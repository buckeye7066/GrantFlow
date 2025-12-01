import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';

const CONFIG = { MAX_RETRIES: 3, RETRY_DELAY_MS: 1000 };

const ADAPTER_MAP = {
  'benefits_gov': 'crawlBenefitsGov',
  'dsire': 'crawlDSIRE',
  'grants_gov': 'crawlGrantsGov',
  'irs_990_pf': 'crawlIrs990',
  'lee_university': 'crawlLeeUniversity'
};

function log(level, message, ctx = {}) {
  console.log('[' + new Date().toISOString() + '] [' + level.toUpperCase() + '] [queueCrawl] ' + message, Object.keys(ctx).length > 0 ? JSON.stringify(ctx) : '');
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

    let body;
    try { body = await req.json(); } catch (e) {
      return Response.json({ success: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON' } }, { status: 400 });
    }

    const { sourceName, options = {} } = body;
    if (!sourceName) {
      return Response.json({ success: false, error: { code: 'MISSING_SOURCE', message: 'sourceName required' } }, { status: 400 });
    }

    const adapterFunction = ADAPTER_MAP[sourceName];
    if (!adapterFunction) {
      return Response.json({ success: false, error: { code: 'ADAPTER_NOT_FOUND', message: 'Unknown source', available: Object.keys(ADAPTER_MAP) } }, { status: 400 });
    }

    let taskResult;
    try {
      taskResult = await retryWithBackoff(() => sdk.functions.invoke(adapterFunction, options));
    } catch (e) {
      return Response.json({ success: false, error: { code: 'INVOCATION_FAILED', message: e.message } }, { status: 500 });
    }

    return Response.json({
      success: true,
      message: 'Queued crawl for ' + sourceName,
      sourceName,
      adapterFunction,
      requestId,
      result: taskResult?.data
    }, { status: 202 });
  } catch (error) {
    return Response.json({ success: false, error: { code: 'UNEXPECTED_ERROR', message: error.message } }, { status: 500 });
  }
});