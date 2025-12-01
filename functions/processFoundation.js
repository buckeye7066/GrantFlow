import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

const CONFIG = { MAX_RETRIES: 3, RETRY_DELAY_MS: 1000 };

function log(level, message, ctx = {}) {
  console.log('[' + new Date().toISOString() + '] [' + level.toUpperCase() + '] [processFoundation] ' + message, Object.keys(ctx).length > 0 ? JSON.stringify(ctx) : '');
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
    const { foundationData } = body;

    if (!foundationData || !foundationData.ein || !foundationData.name) {
      return Response.json({ error: 'Missing foundationData with ein and name' }, { status: 400 });
    }

    // Check for duplicate by EIN
    const existing = await sdk.entities.SourceRegistry.filter({ org_name: foundationData.ein });
    if (existing.length > 0) {
      return Response.json({ action: 'skipped', reason: 'duplicate', id: existing[0].id });
    }

    // Create new foundation entry
    const newSource = {
      name: foundationData.name.trim(),
      org_name: foundationData.ein.trim(),
      source_type: 'foundation',
      program_scope: 'both',
      coverage_status: 'unverified',
      url: 'https://www.google.com/search?q=' + encodeURIComponent(foundationData.name + ' ' + foundationData.ein + ' foundation'),
      geography_tags: foundationData.state ? ['US-' + foundationData.state] : []
    };

    const created = await retryWithBackoff(() => sdk.entities.SourceRegistry.create(newSource));
    return Response.json({ action: 'created', id: created.id }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});