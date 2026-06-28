/**
 * SAM.gov Connector
 * Fetches contract/grant opportunities from the SAM.gov Opportunities API.
 * API Documentation: https://open.gsa.gov/api/get-opportunities-public-api/
 *
 * Requires environment variable: SAM_GOV_API_KEY
 */

import fetch from 'node-fetch';

import crypto from 'crypto';
import { getSamGovApiKey } from '../../config/grantsGovEndpoints.js'
import { createLogger } from '../../utils/logger.js'
const log = createLogger('samGov')

async function fetchWithRetry(url, options, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429 || response.status === 503) {
        const backoffMs = attempt * 2000;
        console.warn(`[sam.gov] HTTP ${response.status} on attempt ${attempt}/${maxRetries}, retrying in ${backoffMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        continue;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response.json();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  }
  throw lastError;
}

const SAM_GOV_API_BASE = 'https://api.sam.gov/opportunities/v2/search';
const SOURCE_NAME = 'sam.gov';
const SAM_GOV_MAX_LIMIT = 1000;

/**
 * Fetch opportunities from SAM.gov
 * @param {object} options - Fetch options
 * @param {number} options.limit - Max number of records to fetch (default 25)
 * @param {number} options.offset - Offset for pagination (default 0)
 * @param {string} options.postedFrom - Start date filter YYYY-MM-DD
 * @param {string} options.postedTo - End date filter YYYY-MM-DD
 * @param {string} options.ptype - Opportunity type: 'o' (solicitation), 'k' (presolicitation), 'g' (grant)
 * @param {string} [options.keyword] - Profile term; filters opportunities whose
 *   TITLE matches (SAM.gov v2 `title` param). Lets a profile pull the federal
 *   slice that matches its needs instead of the latest grants overall.
 * @returns {Promise<{ opportunities: Array, metadata: object }>}
 */
export async function fetchSamGov(options = {}) {
  const apiKey = getSamGovApiKey();

  if (!apiKey) {
    console.warn('[sam.gov] SAM_GOV_PUBLIC_API_KEY / SAM_GOV_API_KEY not set - skipping SAM.gov fetch');
    return {
      opportunities: [],
      metadata: {
        source: SOURCE_NAME,
        fetched_at: new Date().toISOString(),
        count: 0,
        skipped: true,
        reason: 'SAM_GOV_API_KEY not configured',
      },
    };
  }

  const {
    limit = 25,
    offset = 0,
    postedFrom = getDateDaysAgo(90),
    postedTo = getCurrentDate(),
    ptype = 'g',
    keyword = null,
  } = options;

  // SAM.gov v2 keyword filtering is title-based. Bound to a sane length so a
  // malformed/over-long term can't corrupt the query (recall-over-precision:
  // an empty/too-short term simply omits the filter rather than failing).
  const titleTerm =
    typeof keyword === 'string' && keyword.trim().length >= 3 && keyword.trim().length <= 60
      ? keyword.trim()
      : null;

  log.info(`[sam.gov] Fetching opportunities (limit: ${limit}, offset: ${offset}${titleTerm ? `, title="${titleTerm}"` : ''})`);

  try {
    const paramObj = {
      api_key: apiKey,
      limit: String(Math.max(1, Math.min(Number(limit) || 25, SAM_GOV_MAX_LIMIT))),
      offset: String(Math.max(0, Number(offset) || 0)),
      postedFrom,
      postedTo,
    };
    if (ptype && typeof ptype === 'string') {
      paramObj.ptype = ptype;
    }
    if (titleTerm) {
      paramObj.title = titleTerm;
    }
    const params = new URLSearchParams(paramObj);

    const url = `${SAM_GOV_API_BASE}?${params.toString()}`;

    const data = await fetchWithRetry(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeout: 30000,
    });

    const opportunities = parseSamGovResponse(data);

    log.info(`[sam.gov] Fetched ${opportunities.length} opportunities`);

    return {
      opportunities,
      metadata: {
        source: SOURCE_NAME,
        fetched_at: new Date().toISOString(),
        count: opportunities.length,
        total_records: data?.totalRecords ?? null,
        has_more: typeof data?.totalRecords === 'number' ? data.totalRecords > (Number(offset) + opportunities.length) : null,
        offset,
        limit,
      },
    };
  } catch (error) {
    // A 404 means this API key lacks access to the Opportunities API (SAM.gov
    // gates each API separately). It's a key/account config issue, not a code
    // bug — log once at warn (not error-per-call) and degrade to no results.
    const is404 = /\b404\b/.test(String(error?.message || ''))
    if (is404) {
      log.warn('[sam.gov] Opportunities API returned 404 — the SAM_GOV_API_KEY likely lacks Opportunities-API access; skipping SAM (set/verify the key to enable).')
    } else {
      log.error('[sam.gov] Error fetching opportunities:', error.message);
    }
    return {
      opportunities: [],
      metadata: {
        source: SOURCE_NAME,
        fetched_at: new Date().toISOString(),
        count: 0,
        error: error.message
      }
    };
  }
}

/**
 * Parse SAM.gov API response and normalize to internal schema.
 */
function parseSamGovResponse(data) {
  const opportunities = [];

  const records = data?.opportunitiesData || data?.data || (Array.isArray(data) ? data : []);

  for (const record of records) {
    try {
      const normalized = normalizeSamGovRecord(record);
      if (normalized) {
        opportunities.push(normalized);
      }
    } catch (error) {
      log.error('[sam.gov] Error normalizing record:', error.message, { noticeId: record?.noticeId, solicitationNumber: record?.solicitationNumber });
    }
  }

  return opportunities;
}

/**
 * Normalize a single SAM.gov record to the internal schema.
 */
function normalizeSamGovRecord(record) {
  const noticeId = record?.noticeId || record?.solicitationNumber || null;
  const title = record?.title || null;
  const agencyName = record?.fullParentPathName || record?.organizationHierarchy?.[0]?.name || record?.departmentName || null;
  const officeAddress = record?.officeAddress || null;
  const postedDate = record?.postedDate || null;
  const responseDeadLine = record?.responseDeadLine || record?.archiveDate || null;
  const description = record?.description || '';
  const uiLink = record?.uiLink || null;
  const type = record?.type || null;
  const naicsCode = record?.naicsCode || null;
  const classificationCode = record?.classificationCode || null;

  if (!noticeId || !title) {
    console.warn('[sam.gov] Skipping record missing required fields');
    return null;
  }

  const sourceUrl = uiLink || `https://sam.gov/opp/${noticeId}/view`;
  const state = officeAddress?.state || null;

  const categories = ['federal', 'sam.gov', 'government'];
  if (type) categories.push(String(type).toLowerCase());

  const keywords = new Set(['sam.gov', 'federal', 'government']);
  if (naicsCode) keywords.add(`naics:${naicsCode}`);
  if (classificationCode) keywords.add(`psc:${classificationCode}`);
  if (type) keywords.add(String(type).toLowerCase());

  return {
    id: crypto.randomUUID(),
    source: SOURCE_NAME,
    source_id: String(noticeId),
    source_url: sourceUrl,
    title: cleanText(title),
    sponsor: cleanText(agencyName),
    description: cleanText(description || `SAM.gov opportunity ${noticeId}`),
    application_url: sourceUrl,
    deadline: parseDate(responseDeadLine),
    deadline_type: responseDeadLine ? 'fixed' : 'rolling',
    amount_min: null,
    amount_max: null,
    amount_description: null,
    is_national: state ? 0 : 1,
    state: state || 'nationwide',
    categories: JSON.stringify(categories),
    keywords: JSON.stringify(Array.from(keywords)),
    eligibility_bullets: JSON.stringify([
      `Notice ID: ${noticeId}`,
      agencyName ? `Agency: ${agencyName}` : null,
      postedDate ? `Posted: ${postedDate}` : null,
      responseDeadLine ? `Response deadline: ${responseDeadLine}` : null,
    ].filter(Boolean)),
    requires_501c3: 0,
    requires_match: 0,
    match_percentage: null,
    opportunity_type: 'grant',
    is_active: 1,
    raw_source_payload: JSON.stringify(record),
    last_crawled: new Date().toISOString(),
  };
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;
    return date.toISOString().split('T')[0];
  } catch {
    return null;
  }
}

function getCurrentDate() {
  return new Date().toISOString().split('T')[0];
}

function getDateDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split('T')[0];
}

function cleanText(text) {
  if (!text) return '';
  return String(text).replace(/\s+/g, ' ').trim();
}

export default { fetchSamGov, SOURCE_NAME };
