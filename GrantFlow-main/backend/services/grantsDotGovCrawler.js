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
const GRANTS_GOV_API = 'https://www.grants.gov/grantsws/rest/opportunities/search/';
const GRANTS_GOV_DETAIL = 'https://www.grants.gov/grantsws/rest/opportunity/details/';
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
    const searchParams = new URLSearchParams({
      oppStatuses: oppStatus,
      rows: rows.toString(),
      startRecordNum: startRow.toString(),
    });
    
    if (keyword) {
      searchParams.append('keyword', keyword);
    }

    const response = await axios.get(`${GRANTS_GOV_API}?${searchParams}`, {
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'GrantFlow/1.0 (grant-matching-platform)',
      }
    });

    return response.data;
  } catch (error) {
    console.error('[GrantsGov] API error:', error.message);
    return null;
  }
}

/**
 * Transform Grants.gov opportunity to our format
 */
function transformGrantsGovOpportunity(opp) {
  const id = `grants-gov-${opp.id || opp.opportunityId}`;
  const oppNumber = opp.number || opp.opportunityNumber || '';
  
  return {
    id,
    title: opp.title || opp.opportunityTitle || 'Federal Grant Opportunity',
    sponsor: opp.agencyName || opp.agency || 'Federal Agency',
    source: 'grants.gov',
    source_id: opp.id || opp.opportunityId,
    source_url: `${GRANTS_GOV_VIEW}${opp.id || opp.opportunityId}`,
    application_url: `${GRANTS_GOV_VIEW}${opp.id || opp.opportunityId}`,
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
