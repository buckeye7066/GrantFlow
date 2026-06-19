/**
 * State Portals Connector
 * Fetches funding opportunities from state-level grant portals.
 *
 * Each registered state has a real API endpoint. States not in the registry
 * return an empty result set - no hardcoded fake data is ever returned.
 */

import { fetchWithRetry } from './httpClient.js';
import crypto, { createHash } from 'crypto';
import { createLogger } from '../../utils/logger.js'
const log = createLogger('statePortals')

const SOURCE_NAME = 'state-portals';

/**
 * Registry of known state portal APIs.
 * Each entry has:
 *   - name: Human-readable portal name
 *   - url: API endpoint
 *   - method: HTTP method
 *   - buildParams: (options) => query params or POST body
 *   - parse: (data) => Array of normalized opportunity objects
 */
const STATE_PORTAL_REGISTRY = {
  // Ohio Grants Portal - https://grants.ohio.gov (search API)
  OH: {
    name: 'Ohio Grants Portal',
    url: 'https://grants.ohio.gov/api/grants/search',
    method: 'GET',
    buildParams: (options) => ({
      status: 'open',
      limit: String(options.limit || 25),
      offset: String(options.offset || 0),
    }),
    parse: (data, sourceUrl) => {
      const records = data?.results || data?.grants || (Array.isArray(data) ? data : []);
      return records.map((r) => normalizeStateRecord(r, 'OH', 'Ohio Grants Portal', sourceUrl)).filter(Boolean);
    },
  },

  // California Grants Portal - https://www.grants.ca.gov (public API)
  CA: {
    name: 'California Grants Portal',
    url: 'https://www.grants.ca.gov/api/v1/grants',
    method: 'GET',
    buildParams: (options) => ({
      page_size: String(options.limit || 25),
      page: String(Math.floor((options.offset || 0) / (options.limit || 25)) + 1),
      is_open: 'true',
    }),
    parse: (data, sourceUrl) => {
      const records = data?.results || (Array.isArray(data) ? data : []);
      return records.map((r) => normalizeStateRecord(r, 'CA', 'California Grants Portal', sourceUrl)).filter(Boolean);
    },
  },

  // Texas Grant Opportunities - https://comptroller.texas.gov
  TX: {
    name: 'Texas Comptroller Grant Opportunities',
    url: 'https://comptroller.texas.gov/programs/infosecurity/cybersecurity-grant/api/grants',
    method: 'GET',
    buildParams: (options) => ({
      limit: String(options.limit || 25),
      offset: String(options.offset || 0),
    }),
    parse: (data, sourceUrl) => {
      const records = data?.grants || data?.data || (Array.isArray(data) ? data : []);
      return records.map((r) => normalizeStateRecord(r, 'TX', 'Texas Comptroller', sourceUrl)).filter(Boolean);
    },
  },
};

/**
 * Fetch grant opportunities from a state portal.
 *
 * @param {string} stateCode - Two-letter state code (e.g. 'CA', 'OH', 'TX')
 * @param {object} options - { limit, offset }
 * @returns {Promise<{ opportunities: Array, metadata: object }>}
 */
export async function fetchStatePortals(stateCode, options = {}) {
  const code = String(stateCode || '').toUpperCase();
  const portal = STATE_PORTAL_REGISTRY[code];

  if (!portal) {
    return {
      opportunities: [],
      metadata: {
        source: SOURCE_NAME,
        state: code,
        fetched_at: new Date().toISOString(),
        count: 0,
        note: `No registered portal for state "${code}". Checked registry: ${Object.keys(STATE_PORTAL_REGISTRY).join(', ')}.`,
      },
    };
  }

  log.info(`[state-portals] Fetching from ${portal.name} (${code})`);

  try {
    const params = portal.buildParams(options);
    let url = portal.url;

    if (portal.method === 'GET' && params) {
      const qs = new URLSearchParams(params).toString();
      url = `${url}?${qs}`;
    }

    const headers = { Accept: 'application/json' };
    if (portal.method === 'POST') {
      headers['Content-Type'] = 'application/json';
    }

    // fetchWithRetry (axios) returns the ALREADY-PARSED body and throws on HTTP
    // errors itself — so there is no Response object here: the old
    // `response.ok` / `response.json()` were always-undefined and made this throw
    // on every successful fetch (zero opportunities every run). POST bodies go in
    // the axios `data` option, not `body`.
    const data = await fetchWithRetry(url, {
      method: portal.method,
      headers,
      ...(portal.method === 'POST' ? { data: params } : {}),
    });

    const opportunities = portal.parse(data, url);

    log.info(`[state-portals] ${portal.name}: ${opportunities.length} opportunities`);

    return {
      opportunities,
      metadata: {
        source: SOURCE_NAME,
        state: code,
        portal: portal.name,
        fetched_at: new Date().toISOString(),
        count: opportunities.length,
        note: `Fetched from ${portal.name}`,
      },
    };
  } catch (error) {
    console.error(`[state-portals] Error fetching from ${portal.name}:`, error.message);
    return {
      opportunities: [],
      metadata: {
        source: SOURCE_NAME,
        state: code,
        portal: portal.name,
        fetched_at: new Date().toISOString(),
        count: 0,
        error: error.message,
        note: `Error fetching from ${portal.name}: ${error.message}`,
      },
    };
  }
}

/**
 * Normalize a state portal record to the internal schema.
 * Field names vary by portal so we probe common aliases.
 */
function normalizeStateRecord(record, stateCode, portalName, sourceUrl) {
  if (!record || typeof record !== 'object') return null;

  const id =
    record.id || record.grant_id || record.grantId || record.opportunity_id || null;
  const title =
    record.title || record.grant_title || record.name || record.program_name || null;
  const sponsor =
    record.agency || record.department || record.funder || record.sponsor || portalName;
  const description =
    record.description || record.summary || record.overview || '';
  const deadline =
    record.deadline || record.close_date || record.due_date || record.closeDate || null;
  const amountMax =
    parseAmount(record.max_award || record.award_ceiling || record.amount || record.max_amount);
  const appUrl =
    record.application_url || record.apply_url || record.url || record.link || null;

  if (!title) {
    console.warn(`[state-portals] Skipping record missing title (state: ${stateCode})`);
    return null;
  }

  const sourceId = id ? String(id) : createHash('sha256').update(`${stateCode}::${title}`).digest('hex').slice(0, 32);

  return {
    id: crypto.randomUUID(),
    source: SOURCE_NAME,
    source_id: `${stateCode.toLowerCase()}-${sourceId}`,
    source_url: appUrl || null,
    title: cleanText(title),
    sponsor: cleanText(sponsor),
    description: cleanText(description),
    application_url: appUrl,
    deadline: parseDate(deadline),
    deadline_type: deadline ? 'fixed' : 'rolling',
    amount_min: null,
    amount_max: amountMax,
    amount_description: amountMax ? `Up to $${amountMax.toLocaleString()}` : null,
    is_national: 0,
    state: stateCode,
    categories: JSON.stringify(['state', stateCode.toLowerCase(), 'government']),
    keywords: JSON.stringify(['state', stateCode.toLowerCase(), portalName.toLowerCase()]),
    eligibility_bullets: JSON.stringify([
      `State: ${stateCode}`,
      `Portal: ${portalName}`,
      deadline ? `Deadline: ${deadline}` : null,
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

function parseAmount(val) {
  if ((val === null || val === undefined)) return null;
  if (typeof val === 'number') return Math.round(val);
  const cleaned = String(val).replace(/[^0-9.]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : Math.round(parsed);
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;
    return date.toISOString().split('T')[0];
  } catch (error) {
    console.warn(`[state-portals] Date parsing failed for: ${dateStr}`, error.message);
    return null;
  }
}

function cleanText(text) {
  if (!text) return '';
  return String(text).replace(/\s+/g, ' ').trim();
}

export default { fetchStatePortals, STATE_PORTAL_REGISTRY, SOURCE_NAME };
