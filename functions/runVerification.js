import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

const CONFIG = { MAX_RETRIES: 3, RETRY_DELAY_MS: 1000, IRS_API_TIMEOUT_MS: 15000 };

function log(level, message, ctx = {}) {
  const sanitized = { ...ctx };
  if (sanitized.ein) sanitized.ein = 'XX-XXX' + sanitized.ein.slice(-4);
  console.log('[' + new Date().toISOString() + '] [' + level.toUpperCase() + '] [runVerification] ' + message, Object.keys(sanitized).length > 0 ? JSON.stringify(sanitized) : '');
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

function normalizeEIN(ein) {
  const digits = ein.replace(/-/g, '');
  return digits.slice(0, 2) + '-' + digits.slice(2);
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { organization_id, ein } = body;

    if (!organization_id || !ein) {
      return Response.json({ success: false, error: { code: 'MISSING_FIELDS', message: 'organization_id and ein required' } }, { status: 400 });
    }

    const normalizedEIN = normalizeEIN(ein);
    const sdk = base44.asServiceRole;
    const registry = 'irs_pub_78';

    // Call IRS API
    let irsData;
    try {
      irsData = await retryWithBackoff(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CONFIG.IRS_API_TIMEOUT_MS);
        const response = await fetch('https://apps.irs.gov/pub/epostcard/api/v1/search?ein=' + normalizedEIN, { signal: controller.signal, headers: { 'User-Agent': 'GrantFlow-Verification/1.0' } });
        clearTimeout(timeout);
        if (!response.ok) throw new Error('IRS API returned ' + response.status);
        return await response.json();
      });
    } catch (e) {
      return Response.json({ success: false, error: { code: 'IRS_API_ERROR', message: e.message } }, { status: 503 });
    }

    const status = irsData.organizations?.length > 0 ? 'verified' : 'not_found';
    const verificationData = status === 'verified' ? JSON.stringify(irsData.organizations[0]) : null;

    // Upsert verification record
    const existing = await sdk.entities.ProfileVerification.filter({ organization_id, registry });
    const recordData = { status, identifiers: JSON.stringify({ ein: normalizedEIN }), checked_at: new Date().toISOString(), verification_data: verificationData };

    let result;
    if (existing.length > 0) {
      result = await sdk.entities.ProfileVerification.update(existing[0].id, recordData);
    } else {
      result = await sdk.entities.ProfileVerification.create({ organization_id, registry, ...recordData });
    }

    const message = status === 'verified' ? 'Verified: Found in IRS database' : 'Not Found: No IRS record for ' + normalizedEIN;
    return Response.json({ success: true, message, verification: { id: result.id, status, registry } });
  } catch (error) {
    return Response.json({ success: false, error: { code: 'UNEXPECTED_ERROR', message: error.message } }, { status: 500 });
  }
});