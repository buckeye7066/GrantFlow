/**
 * Grants.gov API Crawler
 * 
 * Fetches REAL federal funding opportunities from the official Grants.gov API
 * https://www.grants.gov/web/grants/search-grants.html
 * 
 * This uses the public Grants.gov API to get actual federal grant opportunities
 */

import axios from 'axios';
import { upsertFundingOpportunity } from './opportunityInserter.js';

// Grants.gov API endpoints
// NOTE: The legacy `grantsws/rest/opportunities/search/` endpoint does not accept GET (405).
// Use the public REST API `search2` endpoint (POST JSON).
const GRANTS_GOV_SEARCH2 = 'https://api.grants.gov/v1/api/search2';
const GRANTS_GOV_VIEW = 'https://www.grants.gov/search-results-detail/';

/**
 * Fetch opportunities from Grants.gov API
 */
async function fetchGrantsGov(params = {}) {
  const {
    keyword = '',
    oppStatus = 'posted', // posted, forecasted, closed, archived
    rows = 100,
    startRow = 0,
    fundingCategories = null, // Array of category codes
  } = params;

  try {
    const payload = {
      rows: Number(rows) || 100,
      // Grants.gov supports multiple statuses; string delimiter is accepted by their docs.
      // Keep it simple for now.
      oppStatuses: String(oppStatus || 'posted'),
      keyword: String(keyword || ''),
      startRecordNum: Number(startRow) || 0,
      // Optional fields (safe defaults)
      agencies: '',
      fundingCategories: Array.isArray(fundingCategories) ? fundingCategories.join('|') : '',
      aln: '',
      oppNum: '',
    };

    const response = await axios.post(GRANTS_GOV_SEARCH2, payload, {
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'GrantFlow/1.0 (grant-matching-platform)',
      }
    });

    const body = response?.data ?? null
    if (!body) return null
    if (typeof body.errorcode === 'number' && body.errorcode !== 0) {
      console.error('[GrantsGov] API error:', `errorcode=${body.errorcode}`, body.msg || '')
      return null
    }
    return body.data ?? body
  } catch (error) {
    const status = error?.response?.status;
    const detail = error?.response?.data ? JSON.stringify(error.response.data).slice(0, 400) : null;
    console.error('[GrantsGov] API error:', status ? `${status}` : error.message, detail || '');
    return null;
  }
}

/**
 * Transform Grants.gov opportunity to our format
 */
function transformGrantsGovOpportunity(opp) {
  const rawId = opp?.id ?? opp?.opportunityId ?? opp?.oppId ?? opp?.opportunity_id ?? null
  const id = `grants-gov-${rawId || cryptoSafeId(opp)}`;
  const oppNumber = opp.number || opp.opportunityNumber || opp.oppNum || '';
  
  return {
    id,
    title: opp.title || opp.opportunityTitle || opp.oppTitle || 'Federal Grant Opportunity',
    sponsor: opp.agencyName || opp.agency || opp.agencyCode || 'Federal Agency',
    source: 'grants.gov',
    source_id: rawId || null,
    source_url: rawId ? `${GRANTS_GOV_VIEW}${rawId}` : null,
    application_url: rawId ? `${GRANTS_GOV_VIEW}${rawId}` : null,
    description: opp.synopsis || opp.description || `Federal funding opportunity: ${oppNumber}`,
    amount_min: parseAmount(opp.awardFloor) || null,
    amount_max: parseAmount(opp.awardCeiling) || null,
    deadline: opp.closeDate || opp.closingDate || null,
    deadline_type: opp.closeDateExplanation ? 'fixed' : 'rolling',
    is_national: true,
    state: 'nationwide',
    categories: [opp.categoryOfFunding || 'federal', 'government'].filter(Boolean),
    keywords: extractKeywords(opp),
    opportunity_type: 'grant',
    requires_501c3: false,
    requires_match: opp.costSharing === 'Yes',
    eligibility_bullets: buildEligibility(opp),
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
  } catch {
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
  if (opp.categoryOfFunding) keywords.push(opp.categoryOfFunding.toLowerCase());
  if (opp.agencyName) keywords.push(opp.agencyName.toLowerCase());
  if (opp.opportunityCategory) keywords.push(opp.opportunityCategory.toLowerCase());
  keywords.push('federal', 'government', 'grant');
  return keywords;
}

function buildEligibility(opp) {
  const bullets = [];
  if (opp.eligibleApplicants) {
    bullets.push(`Eligible: ${opp.eligibleApplicants}`);
  }
  if (opp.costSharing === 'Yes') {
    bullets.push('Cost sharing/matching may be required');
  }
  if (opp.cfda) {
    bullets.push(`CFDA: ${opp.cfda}`);
  }
  bullets.push('Apply through Grants.gov');
  return bullets;
}

/**
 * Crawl Grants.gov and populate database
 */
export async function crawlGrantsGov(db, options = {}) {
  const { maxPages = 10, rowsPerPage = 100 } = options;
  
  console.log('[GrantsGov] Starting crawl...');
  
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalErrors = 0;
  
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
    
    for (let page = 0; page < maxPages; page++) {
      const startRow = page * rowsPerPage;
      
      const data = await fetchGrantsGov({
        keyword,
        rows: rowsPerPage,
        startRow,
      });
      
      if (!data || !data.oppHits || data.oppHits.length === 0) {
        break; // No more results
      }
      
      for (const opp of data.oppHits) {
        // Skip if requires cost sharing/matching
        if (opp.costSharing === 'Yes') {
          continue;
        }
        
        const transformed = transformGrantsGovOpportunity(opp);
        const result = await upsertFundingOpportunity(db, {
          ...transformed,
          record_origin: 'live_crawl',
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
  }
  
  console.log(`[GrantsGov] Complete: ${totalInserted} inserted, ${totalUpdated} updated, ${totalErrors} errors`);
  
  return {
    inserted: totalInserted,
    updated: totalUpdated,
    errors: totalErrors,
  };
}

export default { crawlGrantsGov, fetchGrantsGov };
