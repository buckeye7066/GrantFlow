import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { createSafeServer } from './_shared/safeHandler.js';
import { createLogger } from './_shared/logger.js';

const CONFIG = { MAX_RETRIES: 3, RETRY_DELAY_MS: 1000, MAX_DESCRIPTION_LENGTH: 2500, MIN_DESCRIPTION_FOR_AI: 100 };

// Base44 integration: Use centralized logger instead of custom function
const logger = createLogger('processCrawledItem');

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

function validateItem(item) {
  const errors = [];
  if (!item.source) errors.push('source required');
  if (!item.source_id) errors.push('source_id required');
  if (!item.title) errors.push('title required');
  return { isValid: errors.length === 0, errors };
}

createSafeServer(async (req) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  try {
    let body = null;
    try { body = await req.json(); } catch (e) { return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 }); }

    const { item, test_mode = false } = body;
    if (test_mode) return Response.json({ ok: true, result: { status: 'test_only' } });
    if (!item) return Response.json({ ok: false, error: 'Missing item' }, { status: 400 });

    const validation = validateItem(item);
    if (!validation.isValid) return Response.json({ ok: false, error: 'Invalid item', details: validation.errors }, { status: 400 });

    if (item.close_date) {
      const deadlineStr = String(item.close_date).trim().toLowerCase();
      if (!['rolling', 'ongoing', 'open'].includes(deadlineStr)) {
        const deadlineDate = new Date(item.close_date);
        if (!isNaN(deadlineDate.getTime()) && deadlineDate < new Date()) {
          return Response.json({ ok: true, result: { status: 'skipped', reason: 'expired' } });
        }
      }
    }

    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;

    let existing = [];
    try { existing = await retryWithBackoff(() => sdk.entities.FundingOpportunity.filter({ source: item.source, source_id: item.source_id })); } catch (e) { throw new Error('DB error: ' + e.message); }

    const rawDescription = item.description_raw || item.descriptionMd || '';
    let aiSummary = rawDescription.substring(0, 400) || item.title;

    const opportunityData = {
      source: item.source, source_id: item.source_id, url: item.url || '', title: item.title || 'Untitled',
      sponsor: item.sponsor || 'Unknown', descriptionMd: aiSummary, categories: item.categories || null,
      regions: item.regions || null, deadlineAt: item.close_date || null, fundingType: item.funding_type || 'grant',
      awardMin: item.award_min || null, awardMax: item.award_max || null, lastCrawled: new Date().toISOString()
    };

    let result = null;
    const isUpdate = existing.length > 0;
    try {
      if (isUpdate) result = await retryWithBackoff(() => sdk.entities.FundingOpportunity.update(existing[0].id, opportunityData));
      else result = await retryWithBackoff(() => sdk.entities.FundingOpportunity.create(opportunityData));
    } catch (e) { throw new Error('DB write error: ' + e.message); }

    return Response.json({ ok: true, result: { status: isUpdate ? 'updated' : 'created', id: result.id } });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message ?? 'Processing error' }, { status: 500 });
  }
});