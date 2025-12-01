import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

const CONFIG = { MAX_RETRIES: 3, RETRY_DELAY_MS: 2000, BATCH_SIZE: 5, REQUEST_TIMEOUT_MS: 30000 };

function log(level, message, ctx = {}) {
  console.log('[' + new Date().toISOString() + '] [' + level.toUpperCase() + '] [runPartnerFeed] ' + message, Object.keys(ctx).length > 0 ? JSON.stringify(ctx) : '');
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
  const requestId = crypto.randomUUID();
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { partner_id } = body;

    if (!partner_id) {
      return Response.json({ success: false, error: { code: 'MISSING_PARTNER_ID', message: 'partner_id required' } }, { status: 400 });
    }

    let partner;
    try { partner = await sdk.entities.PartnerSource.get(partner_id); } catch (e) {
      return Response.json({ success: false, error: { code: 'PARTNER_NOT_FOUND', message: 'Partner not found' } }, { status: 404 });
    }

    if (!partner.api_base_url) {
      return Response.json({ success: false, error: { code: 'INVALID_CONFIG', message: 'Partner missing api_base_url' } }, { status: 400 });
    }

    const logEntry = await sdk.entities.CrawlLog.create({ source: 'Partner Feed: ' + partner.name, status: 'started' });

    // Fetch partner API
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
    let partnerData;
    try {
      const response = await fetch(partner.api_base_url, { headers: { 'Content-Type': 'application/json' }, signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) throw new Error('API returned ' + response.status);
      partnerData = await response.json();
    } catch (e) {
      clearTimeout(timeoutId);
      await sdk.entities.CrawlLog.update(logEntry.id, { status: 'failed', errorMessage: e.message });
      return Response.json({ success: false, error: { code: 'API_FAILED', message: e.message } }, { status: 500 });
    }

    const records = Array.isArray(partnerData) ? partnerData : [partnerData];
    let processed = 0;
    for (const record of records) {
      try {
        await retryWithBackoff(() => sdk.functions.invoke('processCrawledItem', { item: { ...record, source: 'partner_' + partner.name.toLowerCase().replace(/\s+/g, '_'), source_id: record.id || record.source_id || partner.id + '_' + processed } }));
        processed++;
      } catch (e) { log('error', 'Record failed', { error: e.message }); }
    }

    await sdk.entities.CrawlLog.update(logEntry.id, { status: 'completed', recordsFound: records.length, recordsAdded: processed });
    await sdk.entities.PartnerSource.update(partner_id, { last_success_at: new Date().toISOString(), status: 'active' });

    return Response.json({ success: true, message: 'Feed completed for ' + partner.name, recordsFound: records.length, recordsProcessed: processed });
  } catch (error) {
    return Response.json({ success: false, error: { code: 'UNEXPECTED_ERROR', message: error.message } }, { status: 500 });
  }
});