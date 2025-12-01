import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

const CONFIG = { MAX_RETRIES: 3, RETRY_DELAY_MS: 1000, BATCH_SIZE: 5, BATCH_DELAY_MS: 1000 };

function log(level, message, ctx = {}) {
  console.log('[' + new Date().toISOString() + '] [' + level.toUpperCase() + '] [crawlIrs990] ' + message, Object.keys(ctx).length > 0 ? JSON.stringify(ctx) : '');
}

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

Deno.serve(async (req) => {
  const crawlId = crypto.randomUUID();
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const SOURCE_NAME = 'irs_990_pf';

    const logEntry = await sdk.entities.CrawlLog.create({ source: SOURCE_NAME, status: 'started' });

    const sampleFoundations = [
      { ein: "94-3136282", name: "The Tech Forward Foundation", city: "PALO ALTO", state: "CA" },
      { ein: "81-0544521", name: "Rural Empowerment Initiative", city: "CHATTANOOGA", state: "TN" },
      { ein: "20-5678901", name: "Community Health Partners", city: "ATLANTA", state: "GA" },
      { ein: "35-1234567", name: "Educational Excellence Fund", city: "NASHVILLE", state: "TN" },
      { ein: "58-9876543", name: "Arts & Culture Foundation", city: "MEMPHIS", state: "TN" }
    ];

    let recordsAdded = 0;
    for (const foundation of sampleFoundations) {
      try {
        await retryWithBackoff(() => sdk.functions.invoke('processFoundation', { foundationData: foundation }));
        recordsAdded++;
      } catch (e) { log('error', 'Failed to process', { ein: foundation.ein, error: e.message }); }
    }

    await sdk.entities.CrawlLog.update(logEntry.id, { status: 'completed', recordsFound: sampleFoundations.length, recordsAdded });
    return Response.json({ status: 'completed', found: sampleFoundations.length, added: recordsAdded });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});