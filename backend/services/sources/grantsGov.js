/**
 * Grants.gov Connector
 * Fetches real funding opportunities from the official Grants.gov API
 * API Documentation: https://www.grants.gov/web/grants/support/technical-support/api.html
 */

import { fetchWithRetry } from './httpClient.js';
import crypto from 'crypto';

// Public, unauthenticated Grants.gov search2 endpoint (2026).
// IMPORTANT: no API key, no Authorization header, POST JSON only.
const GRANTS_GOV_SEARCH2_URL = 'https://api.grants.gov/v1/api/search2';
const SOURCE_NAME = 'grants.gov';

/**
 * Fetch opportunities from Grants.gov
 * @param {object} options - Fetch options
 * @param {number} options.limit - Max number of records to fetch
 * @param {number} options.offset - Offset for pagination
 * @returns {Promise<object>} Normalized opportunities and metadata
 */
export async function fetchGrantsGov(options = {}) {
  const { limit = 25, offset = 0 } = options;
  
  console.log(`[grants.gov] Fetching opportunities (limit: ${limit}, offset: ${offset})`);
  
  try {
    // Build POST body per Grants.gov search2 docs.
    // Minimal required example (no auth):
    // {
    //   "rows": 25,
    //   "oppStatuses": "forecasted|posted",
    //   "keyword": "",
    //   "agencies": "",
    //   "fundingCategories": ""
    // }
    const payload = {
      rows: Math.max(1, Math.min(Number(limit) || 25, 1000)),
      oppStatuses: 'forecasted|posted',
      keyword: '',
      agencies: '',
      fundingCategories: '',
      startRecordNum: Math.max(0, Number(offset) || 0),
    };
    
    console.log('[grants.gov] search2 request payload:', JSON.stringify(payload));

    const resp = await fetchWithRetry(GRANTS_GOV_SEARCH2_URL, { 
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      data: payload,
      timeout: 60000, // 60 second timeout for this API
      returnMeta: true,
    });
    console.log('[grants.gov] search2 HTTP status:', resp?.status)
    const data = resp?.data

    // Note: fetchWithRetry returns response.data only; we can't log HTTP status here.
    // To keep the contract stable we log the payload + parsed hit counts and log the full body on zero hits.
    
    // Parse response
    const opportunities = parseGrantsGovResponse(data);
    
    console.log(`[grants.gov] Fetched ${opportunities.length} opportunities`);
    if (opportunities.length === 0) {
      console.warn('[grants.gov] search2 returned 0 results; full response:', JSON.stringify(data, null, 2));
    }
    
    return {
      opportunities,
      metadata: {
        source: SOURCE_NAME,
        fetched_at: new Date().toISOString(),
        count: opportunities.length,
        offset,
        limit,
      },
    };
  } catch (error) {
    console.error(`[grants.gov] Error fetching opportunities:`, error.message);
    throw error;
  }
}

/**
 * Parse Grants.gov API response and normalize to our schema
 */
function parseGrantsGovResponse(data) {
  const opportunities = [];
  
  // The Grants.gov API returns data in various formats, handle accordingly
  let records = [];
  
  // search2 returns opportunities under `data.oppHits` (sometimes nested under `data.data`).
  const envelope = data && typeof data === 'object' ? data : null
  const dataNode = envelope?.data?.oppHits ? envelope.data : envelope?.data?.data?.oppHits ? envelope.data.data : envelope

  if (dataNode && dataNode.oppHits) {
    records = Array.isArray(dataNode.oppHits) ? dataNode.oppHits : [dataNode.oppHits];
  } else if (Array.isArray(data)) {
    records = data;
  }
  
  for (const record of records) {
    try {
      const normalized = normalizeGrantsGovRecord(record);
      if (normalized) {
        opportunities.push(normalized);
      }
    } catch (error) {
      console.error('[grants.gov] Error normalizing record:', error.message);
      // Continue processing other records
    }
  }
  
  return opportunities;
}

/**
 * Normalize a single Grants.gov record to our schema
 */
function normalizeGrantsGovRecord(record) {
  // Extract fields from various possible locations
  const oppNumber = record?.number || record?.opportunityNumber || record?.oppNumber || null;
  const title = record?.title || record?.opportunityTitle || null;
  const agencyName = record?.agencyName || record?.agency || record?.sponsor || null;
  const agencyCode = record?.agencyCode || null;
  const openDate = record?.openDate || record?.postDate || null;
  const closeDate = record?.closeDate || record?.closingDate || null;
  const oppStatus = record?.oppStatus || null;
  const alnlist = record?.alnlist ?? null;
  
  // Skip if missing required fields
  if (!oppNumber || !title) {
    console.warn('[grants.gov] Skipping record missing required fields');
    return null;
  }
  
  // Build source URL
  const id = record?.id ?? record?.oppId ?? null
  const sourceUrl =
    id != null
      ? `https://www.grants.gov/search-results-detail/${id}`
      : `https://www.grants.gov/search-grants?query=${encodeURIComponent(String(oppNumber))}`;
  
  const categories = ['federal', 'grants.gov', 'government'];
  const keywords = new Set(['grants.gov', 'federal', 'government', 'grant']);
  if (agencyCode) keywords.add(String(agencyCode).toLowerCase());
  if (oppStatus) keywords.add(String(oppStatus).toLowerCase());
  if (Array.isArray(alnlist)) {
    alnlist.filter(Boolean).forEach((aln) => keywords.add(`aln:${String(aln).toLowerCase()}`));
  } else if (typeof alnlist === 'string' && alnlist.trim()) {
    alnlist
      .split(/[|,]+/g)
      .map((v) => v.trim())
      .filter(Boolean)
      .forEach((aln) => keywords.add(`aln:${String(aln).toLowerCase()}`));
  }

  const eligibilityBullets = [];
  eligibilityBullets.push(`Opportunity number: ${oppNumber}`);
  if (agencyName) eligibilityBullets.push(`Agency: ${agencyName}${agencyCode ? ` (${agencyCode})` : ''}`);
  if (oppStatus) eligibilityBullets.push(`Status: ${oppStatus}`);
  if (openDate) eligibilityBullets.push(`Open date: ${openDate}`);
  if (closeDate) eligibilityBullets.push(`Close date: ${closeDate}`);
  if (alnlist) eligibilityBullets.push(`ALN list: ${Array.isArray(alnlist) ? alnlist.join(', ') : String(alnlist)}`);
  
  return {
    id: crypto.randomUUID(),
    source: SOURCE_NAME,
    // De-dupe by Grants.gov opportunity number (idempotent re-runs).
    source_id: String(oppNumber),
    source_url: sourceUrl,
    title: cleanText(title),
    sponsor: cleanText(agencyName),
    description: cleanText(`Grants.gov opportunity ${oppNumber}${oppStatus ? ` (${oppStatus})` : ''}.`),
    application_url: sourceUrl,
    deadline: parseDate(closeDate),
    deadline_type: closeDate ? 'fixed' : 'rolling',
    amount_min: null,
    amount_max: null,
    amount_description: null,
    is_national: 1,
    state: 'nationwide',
    categories: JSON.stringify(categories),
    keywords: JSON.stringify(Array.from(keywords)),
    eligibility_bullets: JSON.stringify(eligibilityBullets),
    requires_501c3: 0,
    requires_match: 0,
    match_percentage: null, // Not typically specified in the API
    opportunity_type: 'grant',
    is_active: oppStatus ? (String(oppStatus).toLowerCase().includes('posted') || String(oppStatus).toLowerCase().includes('forecast') ? 1 : 0) : 1,
    raw_source_payload: JSON.stringify(record),
    last_crawled: new Date().toISOString(),
  };
}

/**
 * Parse eligibility code to human-readable text
 */
function parseEligibilityCode(code) {
  const eligibilityMap = {
    '00': 'State governments',
    '01': 'County governments',
    '02': 'City or township governments',
    '04': 'Special district governments',
    '05': 'Independent school districts',
    '06': 'Public and State controlled institutions of higher education',
    '07': 'Native American tribal governments (Federally recognized)',
    '08': 'Public housing authorities/Indian housing authorities',
    '11': 'Native American tribal organizations (other than Federally recognized)',
    '12': 'Nonprofits having a 501(c)(3) status with the IRS, other than institutions of higher education',
    '13': 'Nonprofits that do not have a 501(c)(3) status with the IRS, other than institutions of higher education',
    '20': 'Private institutions of higher education',
    '21': 'Individuals',
    '22': 'For profit organizations other than small businesses',
    '23': 'Small businesses',
    '25': 'Others',
  };
  
  const codeStr = String(code).padStart(2, '0');
  return eligibilityMap[codeStr] || code;
}

/**
 * Parse amount string to number
 */
function parseAmount(amountStr) {
  if (!amountStr) return null;
  if (typeof amountStr === 'number') return amountStr;
  const cleaned = String(amountStr).replace(/[^0-9.]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Parse date string to YYYY-MM-DD format
 */
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

/**
 * Clean text by removing extra whitespace
 */
function cleanText(text) {
  if (!text) return '';
  return String(text).replace(/\s+/g, ' ').trim();
}

export default {
  fetchGrantsGov,
  SOURCE_NAME,
};
