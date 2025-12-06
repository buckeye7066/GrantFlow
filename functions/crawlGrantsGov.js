import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { createSafeServer } from './_shared/safeHandler.js';
import { generateSearchQueries, performProfileBasedSearch } from './_shared/crawlerFramework.js';
import { saveFundingSource } from './_shared/saveFundingSource.js';

const CONFIG = { MAX_RETRIES: 3, RETRY_DELAY_MS: 2000, BATCH_SIZE: 5, BATCH_DELAY_MS: 1000, CRAWLER_TIMEOUT_MS: 40000 };

function log(level, message, ctx = {}) {
  console.log('[' + new Date().toISOString() + '] [' + level.toUpperCase() + '] [crawlGrantsGov] ' + message, 
    Object.keys(ctx).length > 0 ? JSON.stringify(ctx) : '');
}

async function retryWithBackoff(fn, maxRetries = CONFIG.MAX_RETRIES) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try { return await fn(); } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = CONFIG.RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

async function runCrawler(sdk, crawlId, profile, profileId, organizationId) {
  const timeout = Date.now() + CONFIG.CRAWLER_TIMEOUT_MS;
  let logEntry = null;
  try { logEntry = await sdk.entities.CrawlLog.create({ source: 'grants.gov', status: 'started', profile_id: profileId }); } catch (e) {}

  try {
    if (Date.now() > timeout) throw new Error('Crawler timeout');
    
    // Generate profile-based search queries
    let searchPrompt = 'Search https://www.grants.gov for 20 recent federal grants.';
    if (profile) {
      const queries = generateSearchQueries(profile, { maxQueries: 3 });
      if (queries.length > 0) {
        searchPrompt = `Search https://www.grants.gov for federal grants matching these criteria: ${queries.join('; ')}. Focus on grants relevant to profile with state: ${profile.state || 'any'}, focus areas: ${(profile.focus_areas || []).join(', ') || 'any'}.`;
        log('info', 'Using profile-based search', { queries });
      }
    }
    
    searchPrompt += ' Extract opportunityNumber, title, agencyName, postedDate, closeDate, awardCeiling, awardFloor, description, eligibleApplicants, fundingCategory.';
    
    const llmResponse = await retryWithBackoff(async () => {
      return await sdk.integrations.Core.InvokeLLM({
        prompt: searchPrompt,
        add_context_from_internet: true,
        response_json_schema: {
          type: "object",
          properties: { grants: { type: "array", items: { type: "object", properties: {
            opportunityNumber: { type: "string" }, title: { type: "string" }, agencyName: { type: "string" },
            postedDate: { type: "string" }, closeDate: { type: "string" }, awardCeiling: { type: "number" },
            awardFloor: { type: "number" }, description: { type: "string" },
            eligibleApplicants: { type: "array", items: { type: "string" } }, fundingCategory: { type: "string" }
          }}}}
        }
      });
    });

    if (!llmResponse?.grants?.length) {
      if (logEntry) try { await sdk.entities.CrawlLog.update(logEntry.id, { status: 'completed', recordsFound: 0 }); } catch (e) {}
      return { ok: true, result: { status: 'completed', found: 0, processed: 0 } };
    }

    // Save grants.gov as a source if profile is provided
    if (profile && profileId) {
      try {
        await saveFundingSource(sdk, {
          url: 'https://www.grants.gov',
          title: 'Grants.gov - Federal Grants Directory',
          description: 'Official U.S. government database of federal grant opportunities',
          categories: ['federal', 'grants', 'government'],
          source_type: 'government',
          discovered_by: 'crawlGrantsGov',
          organization_id: organizationId,
          profile_id: profileId,
          metadata: { query_count: llmResponse.grants.length }
        });
      } catch (saveErr) {
        log('warn', 'Failed to save grants.gov source', { error: saveErr.message });
      }
    }

    let recordsProcessed = 0;
    for (const rawGrant of llmResponse.grants) {
      if (Date.now() > timeout) break;
      try {
        const mappedItem = {
          source: 'grants_gov',
          source_id: rawGrant.opportunityNumber || 'grants_gov_' + Date.now() + '_' + Math.random().toString(36).slice(2),
          title: rawGrant.title || 'Untitled',
          sponsor: rawGrant.agencyName || 'Unknown',
          url: rawGrant.opportunityNumber ? 'https://www.grants.gov/search-results-detail/' + rawGrant.opportunityNumber : 'https://www.grants.gov',
          description_raw: rawGrant.description || '',
          close_date: rawGrant.closeDate || null,
          funding_type: 'federal_grant',
          award_max: rawGrant.awardCeiling || null,
          regions: ['USA'],
          profile_id: profileId,
          organization_id: organizationId
        };
        await retryWithBackoff(() => sdk.functions.invoke('processCrawledItem', { item: mappedItem }));
        recordsProcessed++;
      } catch (e) { log('error', 'Failed to process grant', { error: e.message }); }
    }

    if (logEntry) try { await sdk.entities.CrawlLog.update(logEntry.id, { status: 'completed', recordsFound: llmResponse.grants.length, recordsAdded: recordsProcessed }); } catch (e) {}
    return { ok: true, result: { status: 'completed', found: llmResponse.grants.length, processed: recordsProcessed } };
  } catch (error) {
    if (logEntry) try { await sdk.entities.CrawlLog.update(logEntry.id, { status: 'failed', errorMessage: error.message }); } catch (e) {}
    throw error;
  }
}

createSafeServer(async (req) => {
  const crawlId = crypto.randomUUID().slice(0, 8);
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const profile = body.profile || null;
    const profileId = body.profile_id || profile?.id || null;
    const organizationId = body.organization_id || profile?.organization_id || null;
    
    return Response.json(await runCrawler(base44.asServiceRole, crawlId, profile, profileId, organizationId), { status: 200 });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message ?? 'Crawler error' }, { status: 500 });
  }
});