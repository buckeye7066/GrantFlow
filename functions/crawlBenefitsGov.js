import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { createSafeServer } from './_shared/safeHandler.js';
import { generateSearchQueries } from './_shared/crawlerFramework.js';
import { saveFundingSource } from './_shared/saveFundingSource.js';

const CONFIG = { MAX_RETRIES: 3, RETRY_DELAY_MS: 1000, BATCH_SIZE: 5, CRAWLER_TIMEOUT_MS: 40000, MAX_PROGRAMS: 15 };

function log(level, message, ctx = {}) {
  console.log('[' + new Date().toISOString() + '] [' + level.toUpperCase() + '] [crawlBenefitsGov] ' + message, Object.keys(ctx).length > 0 ? JSON.stringify(ctx) : '');
}

async function retryWithBackoff(fn, maxRetries = CONFIG.MAX_RETRIES) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try { return await fn(); } catch (error) {
      lastError = error;
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY_MS * Math.pow(2, attempt - 1)));
    }
  }
  throw lastError;
}

async function runCrawler(sdk, crawlId, organizationId, profile, profileId) {
  const SOURCE_NAME = 'benefits_gov';
  let logEntry = null;
  try { logEntry = await sdk.entities.CrawlLog.create({ source: SOURCE_NAME, status: 'started', profile_id: profileId }); } catch (e) {}

  try {
    let opportunities = [
      { source: SOURCE_NAME, source_id: "snap", url: "https://www.benefits.gov/benefit/361", title: "SNAP", sponsor: "USDA", description_raw: "Nutrition assistance for needy families.", funding_type: "benefit", regions: ["USA"], categories: ["food"] },
      { source: SOURCE_NAME, source_id: "medicare", url: "https://www.benefits.gov/benefit/1307", title: "Medicare", sponsor: "CMS", description_raw: "Health insurance for 65+.", funding_type: "benefit", regions: ["USA"], categories: ["healthcare"] },
      { source: SOURCE_NAME, source_id: "medicaid", url: "https://www.benefits.gov/benefit/1640", title: "Medicaid", sponsor: "CMS", description_raw: "Health coverage for low-income.", funding_type: "benefit", regions: ["USA"], categories: ["healthcare"] },
      { source: SOURCE_NAME, source_id: "ssi", url: "https://www.benefits.gov/benefit/4416", title: "SSI", sponsor: "SSA", description_raw: "Monthly payments for disabled/elderly.", funding_type: "benefit", regions: ["USA"], categories: ["financial"] },
      { source: SOURCE_NAME, source_id: "liheap", url: "https://www.benefits.gov/benefit/623", title: "LIHEAP", sponsor: "HHS", description_raw: "Energy bill assistance.", funding_type: "assistance", regions: ["USA"], categories: ["utility"] }
    ];

    // If profile is provided, perform profile-based search for additional benefits
    if (profile) {
      try {
        const queries = generateSearchQueries(profile, { maxQueries: 2 });
        if (queries.length > 0) {
          const searchPrompt = `Search https://www.benefits.gov for government benefit programs matching: ${queries.join('; ')}. Focus on benefits for profile with state: ${profile.state || 'any'}, income level: ${profile.household_income || 'any'}, disabilities: ${(profile.disabilities || []).length > 0 ? 'yes' : 'no'}. Return up to 10 additional benefits with url, title, sponsor, description, categories.`;
          
          const llmResponse = await sdk.integrations.Core.InvokeLLM({
            prompt: searchPrompt,
            add_context_from_internet: true,
            response_json_schema: {
              type: "object",
              properties: {
                benefits: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      url: { type: "string" },
                      title: { type: "string" },
                      sponsor: { type: "string" },
                      description: { type: "string" },
                      categories: { type: "array", items: { type: "string" } }
                    }
                  }
                }
              }
            }
          });

          if (llmResponse?.benefits?.length > 0) {
            log('info', 'Found additional profile-based benefits', { count: llmResponse.benefits.length });
            for (const benefit of llmResponse.benefits) {
              opportunities.push({
                source: SOURCE_NAME,
                source_id: `benefit_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                url: benefit.url,
                title: benefit.title,
                sponsor: benefit.sponsor || 'Unknown',
                description_raw: benefit.description || '',
                funding_type: 'benefit',
                regions: ['USA'],
                categories: benefit.categories || []
              });
            }
          }
        }

        // Save benefits.gov as a source
        await saveFundingSource(sdk, {
          url: 'https://www.benefits.gov',
          title: 'Benefits.gov - Government Benefits Directory',
          description: 'Official U.S. government database of federal and state benefit programs',
          categories: ['benefits', 'government', 'federal', 'assistance'],
          source_type: 'government',
          discovered_by: 'crawlBenefitsGov',
          organization_id: organizationId,
          profile_id: profileId,
          metadata: { benefit_count: opportunities.length }
        });
      } catch (profileErr) {
        log('warn', 'Profile-based search failed, using defaults', { error: profileErr.message });
      }
    }

    let recordsProcessed = 0;
    for (const item of opportunities) {
      try {
        const itemWithProfile = {
          ...item,
          profile_id: profileId,
          organization_id: organizationId
        };
        await retryWithBackoff(() => sdk.functions.invoke('processCrawledItem', { item: itemWithProfile }));
        recordsProcessed++;
      } catch (e) { log('error', 'Failed', { error: e.message }); }
    }

    if (logEntry) try { await sdk.entities.CrawlLog.update(logEntry.id, { status: 'completed', recordsFound: opportunities.length, recordsAdded: recordsProcessed }); } catch (e) {}
    return { ok: true, result: { status: 'completed', found: opportunities.length, processed: recordsProcessed } };
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
    
    return Response.json(await runCrawler(base44.asServiceRole, crawlId, organizationId, profile, profileId), { status: 200 });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message ?? 'Crawler error' }, { status: 500 });
  }
});