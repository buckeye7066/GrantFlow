import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { createSafeServer } from './_shared/safeHandler.js';
import { createLogger } from './_shared/logger.js';

const CONFIG = { MAX_RETRIES: 3, RETRY_DELAY_MS: 1000, BATCH_SIZE: 5, BATCH_DELAY_MS: 1000 };

// Base44 integration: Use centralized logger instead of custom function
const logger = createLogger('crawlDSIRE');

async function retryWithBackoff(fn, maxRetries = CONFIG.MAX_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try { return await fn(); } catch (error) {
      lastError = error;
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY_MS * Math.pow(2, attempt - 1)));
    }
  }
  throw lastError;
}

createSafeServer(async (req) => {
  const crawlId = crypto.randomUUID();
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const SOURCE_NAME = 'dsire';

    const logEntry = await sdk.entities.CrawlLog.create({ source: SOURCE_NAME, status: 'started' });

    const sampleOpportunities = [
      { source: SOURCE_NAME, source_id: "TN-123", url: "https://programs.dsireusa.org/system/program/tn123", title: "TVA - Green Power Providers", sponsor: "TVA", description_raw: "Premium for renewable energy.", funding_type: "rebate", regions: ["US-TN"], categories: ["renewable_energy"] },
      { source: SOURCE_NAME, source_id: "US-555", url: "https://programs.dsireusa.org/system/program/us555", title: "Residential Clean Energy Credit", sponsor: "IRS", description_raw: "30% federal tax credit for clean energy.", funding_type: "credit", regions: ["US"], categories: ["tax_credit", "renewable_energy"] },
      { source: SOURCE_NAME, source_id: "TN-456", url: "https://programs.dsireusa.org/system/program/tn456", title: "Tennessee Solar Rebate", sponsor: "TDEC", description_raw: "Rebate for solar installations.", funding_type: "rebate", regions: ["US-TN"], categories: ["solar"] },
      { source: SOURCE_NAME, source_id: "US-789", url: "https://programs.dsireusa.org/system/program/us789", title: "Energy Efficient Home Credit", sponsor: "IRS", description_raw: "Tax credit for home improvements.", funding_type: "credit", regions: ["US"], categories: ["energy_efficiency"] },
      { source: SOURCE_NAME, source_id: "GA-234", url: "https://programs.dsireusa.org/system/program/ga234", title: "Georgia Solar Tax Credit", sponsor: "GA DOR", description_raw: "35% state tax credit for solar.", funding_type: "credit", regions: ["US-GA"], categories: ["solar", "tax_credit"] }
    ];

    let recordsProcessed = 0;
    const errors = [];
    for (const item of sampleOpportunities) {
      try {
        await retryWithBackoff(() => sdk.functions.invoke('processCrawledItem', { item }));
        recordsProcessed++;
      } catch (e) { errors.push({ title: item.title, error: e.message }); }
    }

    await sdk.entities.CrawlLog.update(logEntry.id, {
      status: errors.length === sampleOpportunities.length ? 'failed' : 'completed',
      recordsFound: sampleOpportunities.length,
      recordsAdded: recordsProcessed
    });

    return Response.json({ status: 'completed', found: sampleOpportunities.length, processed: recordsProcessed, errors: errors.length });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});