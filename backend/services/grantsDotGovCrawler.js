/**
 * Grants.gov API Crawler
 * 
 * Fetches REAL federal funding opportunities from the official Grants.gov API
 * https://www.grants.gov/web/grants/search-grants.html
 * 
 * This uses the Grants.gov API to get actual federal grant opportunities.
 * NOTE: search2 works without GRANTS_GOV_API_KEY; when set, X-API-Key is sent.
 */

import axios from 'axios';
import { upsertFundingOpportunity } from './opportunityInserter.js';
import {
  GRANTS_GOV_SEARCH2_URL as GRANTS_GOV_SEARCH2,
  GRANTS_GOV_DETAIL_URL as GRANTS_GOV_VIEW,
} from '../config/grantsGovEndpoints.js';

// Optional: when GRANTS_GOV_API_KEY is set, search2 requests include X-API-Key.
const GRANTS_GOV_API_KEY = process.env.GRANTS_GOV_API_KEY || ''

/**
 * Fetch opportunities from Grants.gov API
 */
async function fetchGrantsGov(params = {}) {
  const {
    keyword = '',
    oppStatus = 'forecasted|posted', // posted|forecasted (public search2)
    rows = 25,
    startRow = 0,
    fundingCategories = null, // Array of category codes
  } = params;

  const payload = {
    rows: Number(rows) || 25,
    oppStatuses: String(oppStatus || 'forecasted|posted'),
    keyword: String(keyword || ''),
    startRecordNum: Number(startRow) || 0,
    agencies: '',
    fundingCategories: Array.isArray(fundingCategories) ? fundingCategories.join('|') : '',
    aln: '',
    oppNum: '',
  };

  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[GrantsGov] search2 request (attempt ${attempt}/${MAX_RETRIES}):`, JSON.stringify(payload))
      const response = await axios.post(GRANTS_GOV_SEARCH2, payload, {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(GRANTS_GOV_API_KEY ? { 'X-API-Key': GRANTS_GOV_API_KEY } : {}),
        }
      });

      console.log('[GrantsGov] search2 HTTP status:', response.status)

      const body = response?.data ?? null
      if (!body) return null

      const hitsNode = body?.data?.oppHits ? body.data : body?.data?.data?.oppHits ? body.data.data : body
      const oppHits = Array.isArray(hitsNode?.oppHits) ? hitsNode.oppHits : []
      console.log('[GrantsGov] search2 oppHits returned:', oppHits.length)
      if (oppHits.length === 0) {
        console.warn('[GrantsGov] search2 returned 0 results; full response:', JSON.stringify(body, null, 2))
      }
      return hitsNode
    } catch (error) {
      const status = error?.response?.status;
      const detail = error?.response?.data ? JSON.stringify(error.response.data).slice(0, 400) : null;

      // Permanent failures — do not retry
      if (status && status >= 400 && status < 500 && status !== 429) {
        console.error('[GrantsGov] Permanent API error, not retrying:', status, detail || error.message);
        return null;
      }

      // Transient failure — retry with exponential backoff
      const isLastAttempt = attempt === MAX_RETRIES;
      if (isLastAttempt) {
        console.error('[GrantsGov] API error after all retries:', status ? `${status}` : error.message, detail || '');
        return null;
      }

      const delayMs = BASE_DELAY_MS * (2 ** (attempt - 1));
      console.warn(`[GrantsGov] Transient API error (${status ?? error.message}), retrying in ${delayMs}ms (attempt ${attempt}/${MAX_RETRIES})...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return null;
}

/**
 * Transform Grants.gov opportunity to our format
 */
function transformGrantsGovOpportunity(opp) {
  const oppId = opp?.id ?? opp?.oppId ?? null
  const oppNumber = opp?.number || opp?.oppNum || opp?.oppNumber || opp?.opportunityNumber || '';
  const id = `grants-gov-${oppNumber || oppId || cryptoSafeId(opp)}`;
  const agencyName = opp?.agencyName || opp?.agency || null
  const agencyCode = opp?.agencyCode || null
  const openDate = opp?.openDate || null
  const closeDate = opp?.closeDate || null
  const oppStatus = opp?.oppStatus || null
  const alnlist = opp?.alnlist ?? null
  
  return {
    id,
    title: opp?.title || opp?.opportunityTitle || opp?.oppTitle || 'Federal Grant Opportunity',
    sponsor: agencyName || agencyCode || 'Federal Agency',
    source: 'grants.gov',
    // De-dupe by Grants.gov opportunity number (idempotent).
    source_id: oppNumber || null,
    source_url: oppId != null ? `${GRANTS_GOV_VIEW}${oppId}` : oppNumber ? `https://www.grants.gov/search-results-detail/${encodeURIComponent(String(oppNumber))}` : null,
    application_url: oppId != null ? `${GRANTS_GOV_VIEW}${oppId}` : oppNumber ? `https://www.grants.gov/search-results-detail/${encodeURIComponent(String(oppNumber))}` : null,
    description: opp?.synopsis || opp?.description || `Grants.gov opportunity ${oppNumber}${oppStatus ? ` (${oppStatus})` : ''}`.trim(),
    amount_min: parseAmount(opp?.awardFloor) || null,
    amount_max: parseAmount(opp?.awardCeiling) || null,
    deadline: closeDate || null,
    deadline_type: closeDate ? 'fixed' : 'rolling',
    is_national: true,
    state: 'nationwide',
    categories: [
    opp?.categoryOfFunding || 'federal',
    'government',
    'grants.gov',
    ...(Array.isArray(opp?.eligibilities) ? opp.eligibilities.map(e => String(e).toLowerCase()) : []),
    ...(Array.isArray(opp?.applicantTypes) ? opp.applicantTypes.map(a => String(a).toLowerCase()) : []),
  ].filter(Boolean),
    keywords: extractKeywords(opp),
    opportunity_type: 'grant',
    type: 'OPPORTUNITY',
    requires_501c3: false,
    requires_match: false,
    eligibility_bullets: buildEligibility({ oppNumber, agencyName, agencyCode, openDate, closeDate, oppStatus, alnlist }),
    last_verified_at: new Date().toISOString(),
  };
}

function cryptoSafeId(opp) {
  try {
    const text = JSON.stringify(opp ?? {});
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return String(hash);
  } catch (error) {
    console.warn('[GrantsGov] Failed to generate crypto-safe ID:', error.message);
    return String(Date.now());
  }
}

function parseAmount(val) {
  if (!val) return null;
  const num = parseFloat(String(val).replace(/[^0-9.]/g, ''));
  return isNaN(num) ? null : num;
}

function extractKeywords(opp) {
  const keywords = [];
  if (opp?.categoryOfFunding) keywords.push(String(opp.categoryOfFunding).toLowerCase());
  if (opp?.agencyName) keywords.push(String(opp.agencyName).toLowerCase());
  if (opp?.agencyCode) keywords.push(String(opp.agencyCode).toLowerCase());
  if (opp?.oppStatus) keywords.push(String(opp.oppStatus).toLowerCase());
  keywords.push('grants.gov', 'federal', 'government', 'grant');
  return keywords;
}

function buildEligibility({ oppNumber, agencyName, agencyCode, openDate, closeDate, oppStatus, alnlist }) {
  const bullets = [];
  if (oppNumber) bullets.push(`Opportunity number: ${oppNumber}`);
  if (agencyName) bullets.push(`Agency: ${agencyName}${agencyCode ? ` (${agencyCode})` : ''}`);
  if (oppStatus) bullets.push(`Status: ${oppStatus}`);
  if (openDate) bullets.push(`Open date: ${openDate}`);
  if (closeDate) bullets.push(`Close date: ${closeDate}`);
  if (alnlist) bullets.push(`ALN list: ${Array.isArray(alnlist) ? alnlist.join(', ') : String(alnlist)}`);
  bullets.push('Apply through Grants.gov');
  return bullets;
}

/**
 * Crawl Grants.gov and populate database
 */
export async function crawlGrantsGov(db, options = {}) {
  if (!db) {
    throw new Error('Database connection required for crawlGrantsGov');
  }
  const { maxPages = 4, rowsPerPage = 25 } = options;
  
  console.log('[GrantsGov] Starting crawl...');
  
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalErrors = 0;
  let keywordErrors = 0;
  
  // Search categories to maximize coverage
  const searchTerms = [
    '', // All open grants
    'education',
    'health',
    'community',
    'housing',
    'environment',
    'arts',
    'science',
    'technology',
    'agriculture',
    'transportation',
    'economic development',
    'social services',
    'youth',
    'elderly',
    'disability',
    'veterans',
    'workforce',
    'infrastructure',
    'rural',
  ];
  
  for (const keyword of searchTerms) {
    console.log(`[GrantsGov] Searching: "${keyword || 'all open grants'}"...`);
    
    let keywordFailed = false;
    for (let page = 0; page < maxPages; page++) {
      const startRow = page * rowsPerPage;
      
      const data = await fetchGrantsGov({
        keyword,
        rows: rowsPerPage,
        startRow,
      });
      
      if (!data) {
        // fetchGrantsGov already logged the error; skip this keyword
        console.warn(`[GrantsGov] Skipping remaining pages for keyword "${keyword || 'all open grants'}" after fetch failure`);
        keywordFailed = true;
        break;
      }

      if (!data.oppHits || data.oppHits.length === 0) {
        break; // No more results for this keyword
      }
      
      for (const opp of data.oppHits) {
        const transformed = transformGrantsGovOpportunity(opp);
        // Pre-filter: skip obviously closed opportunities before touching the DB
const status = (opp?.oppStatus ?? '').toLowerCase();
if (status === 'closed' || status === 'archived') {
  console.log(`[GrantsGov] Skipping closed/archived opportunity ${transformed.id} (${opp?.oppStatus})`);
  continue;
}

const result = await upsertFundingOpportunity(db, {
  ...transformed,
  record_origin: 'funding_api',
  evidence_url: transformed.source_url ?? transformed.application_url ?? null,
});
        
        if (result.inserted) totalInserted++;
        else if (result.updated) totalUpdated++;
        else if (result.error) totalErrors++;
      }
      
      // Don't hammer the API
      await new Promise(r => setTimeout(r, 500));
      
      // If fewer results than requested, we've reached the end
      if (data.oppHits.length < rowsPerPage) {
        break;
      }
    }

    if (keywordFailed) keywordErrors++;
  }
  
  console.log(`[GrantsGov] Complete: ${totalInserted} inserted, ${totalUpdated} updated, ${totalErrors} errors, ${keywordErrors}/${searchTerms.length} keywords failed`);
  
  return {
    inserted: totalInserted,
    updated: totalUpdated,
    errors: totalErrors,
    keyword_errors: keywordErrors,
    keywords_total: searchTerms.length,
  };
}

export default { crawlGrantsGov, fetchGrantsGov };
