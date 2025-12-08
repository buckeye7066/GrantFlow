import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { createSafeServer } from './_shared/safeHandler.js';
import { createLogger } from './_shared/logger.js';

const CONFIG = { MAX_RETRIES: 3, RETRY_DELAY_MS: 2000, BATCH_SIZE: 5, BATCH_DELAY_MS: 1000, CRAWLER_TIMEOUT_MS: 40000 };

// Base44 integration: Use centralized logger instead of custom function
const logger = createLogger('crawlGrantsGov');

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

async function runCrawler(sdk, crawlId) {
  const timeout = Date.now() + CONFIG.CRAWLER_TIMEOUT_MS;
  let logEntry = null;
  try { logEntry = await sdk.entities.CrawlLog.create({ source: 'grants.gov', status: 'started' }); } catch (e) {}

  try {
    if (Date.now() > timeout) throw new Error('Crawler timeout');
    
    const llmResponse = await retryWithBackoff(async () => {
      return await sdk.integrations.Core.InvokeLLM({
        prompt: 'Search https://www.grants.gov for 20 recent federal grants. Extract opportunityNumber, title, agencyName, postedDate, closeDate, awardCeiling, awardFloor, description, eligibleApplicants, fundingCategory.',
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
          regions: ['USA']
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
    return Response.json(await runCrawler(base44.asServiceRole, crawlId), { status: 200 });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message ?? 'Crawler error' }, { status: 500 });
  }
});