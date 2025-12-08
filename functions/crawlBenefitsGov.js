import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { createSafeServer } from './_shared/safeHandler.js';
import { createLogger } from './_shared/logger.js';

const CONFIG = { MAX_RETRIES: 3, RETRY_DELAY_MS: 1000, BATCH_SIZE: 5, CRAWLER_TIMEOUT_MS: 40000, MAX_PROGRAMS: 15 };

// Base44 integration: Use centralized logger instead of custom function
const logger = createLogger('crawlBenefitsGov');

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

async function runCrawler(sdk, crawlId, organizationId) {
  const SOURCE_NAME = 'benefits_gov';
  let logEntry = null;
  try { logEntry = await sdk.entities.CrawlLog.create({ source: SOURCE_NAME, status: 'started' }); } catch (e) {}

  try {
    let opportunities = [
      { source: SOURCE_NAME, source_id: "snap", url: "https://www.benefits.gov/benefit/361", title: "SNAP", sponsor: "USDA", description_raw: "Nutrition assistance for needy families.", funding_type: "benefit", regions: ["USA"], categories: ["food"] },
      { source: SOURCE_NAME, source_id: "medicare", url: "https://www.benefits.gov/benefit/1307", title: "Medicare", sponsor: "CMS", description_raw: "Health insurance for 65+.", funding_type: "benefit", regions: ["USA"], categories: ["healthcare"] },
      { source: SOURCE_NAME, source_id: "medicaid", url: "https://www.benefits.gov/benefit/1640", title: "Medicaid", sponsor: "CMS", description_raw: "Health coverage for low-income.", funding_type: "benefit", regions: ["USA"], categories: ["healthcare"] },
      { source: SOURCE_NAME, source_id: "ssi", url: "https://www.benefits.gov/benefit/4416", title: "SSI", sponsor: "SSA", description_raw: "Monthly payments for disabled/elderly.", funding_type: "benefit", regions: ["USA"], categories: ["financial"] },
      { source: SOURCE_NAME, source_id: "liheap", url: "https://www.benefits.gov/benefit/623", title: "LIHEAP", sponsor: "HHS", description_raw: "Energy bill assistance.", funding_type: "assistance", regions: ["USA"], categories: ["utility"] }
    ];

    let recordsProcessed = 0;
    for (const item of opportunities) {
      try {
        await retryWithBackoff(() => sdk.functions.invoke('processCrawledItem', { item }));
        recordsProcessed++;
      } catch (e) { 
        // Base44 integration: Error logging for failed items
        logger.error('Failed to process item', { error: e.message });
      }
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
    return Response.json(await runCrawler(base44.asServiceRole, crawlId, body.organization_id), { status: 200 });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message ?? 'Crawler error' }, { status: 500 });
  }
});