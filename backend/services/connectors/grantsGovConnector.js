/**
 * Grants.gov API Connector
 * Integrates with the official Grants.gov REST API
 * 
 * API Documentation: https://www.grants.gov/web/grants/xml-web-services.html
 * Base URL: https://www.grants.gov/grantsws/rest
 * 
 * NOTE: The search2 endpoint requires an X-API-Key header since 2026 (401 without it).
 * RATE LIMIT: Not explicitly documented, use conservative 1 req/sec
 * TOS: https://www.grants.gov/web/grants/support/terms-of-use.html
 */

import fetch from 'node-fetch';

// Grants.gov search2 endpoint — now requires an API key (returns 401 without one).
// Set GRANTS_GOV_API_KEY in your environment (.env / Railway / Vercel secrets).
const SEARCH2_URL = 'https://api.grants.gov/v1/api/search2';
const BASE_URL = 'https://www.grants.gov/grantsws/rest';
const RATE_LIMIT_MS = 1000; // 1 second between requests

const GRANTS_GOV_API_KEY = process.env.GRANTS_GOV_API_KEY || ''
if (!GRANTS_GOV_API_KEY) {
  console.warn(
    '[grants.gov] GRANTS_GOV_API_KEY env var is not set; ' +
      'Grants.gov search2 requests will likely return 401 Unauthorized.',
  )
}

let lastRequestTime = 0;

/**
 * Rate-limited fetch wrapper
 */
async function rateLimitedFetch(url, options = {}) {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < RATE_LIMIT_MS) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - timeSinceLastRequest));
  }
  
  lastRequestTime = Date.now();
  
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'GrantFlow/1.0 (grant management system)',
      ...options.headers
    }
  });
  
  if (!response.ok) {
    throw new Error(`Grants.gov API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (options && options.returnMeta === true) {
    return { status: response.status, data };
  }
  return data;
}

/**
 * Search for grant opportunities
 * @param {Object} params - Search parameters
 * @param {string} params.keyword - Keyword search
 * @param {string} params.oppStatus - 'forecasted' or 'posted' (default: 'posted')
 * @param {string} params.fundingInstrument - Grant type filter
 * @param {string} params.eligibility - Eligibility category
 * @param {number} params.rows - Results per page (max 1000)
 * @param {number} params.offset - Pagination offset
 * @returns {Promise<Array>} Array of opportunities in OPPORTUNITY type
 */
export async function searchOpportunities(params = {}) {
  const searchPayload = {
    rows: Math.min(params.rows || 25, 1000),
    oppStatuses: params.oppStatus || 'forecasted|posted',
    keyword: params.keyword || '',
    agencies: '',
    fundingCategories: '',
    startRecordNum: params.offset || 0,
  };
  
  try {
    console.log('[grants.gov] search2 request payload:', JSON.stringify(searchPayload));
    const { status, data } = await rateLimitedFetch(SEARCH2_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(GRANTS_GOV_API_KEY ? { 'X-API-Key': GRANTS_GOV_API_KEY } : {}),
      },
      body: JSON.stringify(searchPayload),
      returnMeta: true,
    });

    const hitsNode = data?.data?.oppHits ? data.data : data?.data?.data?.oppHits ? data.data.data : data
    const hits = Array.isArray(hitsNode?.oppHits) ? hitsNode.oppHits : []

    console.log('[grants.gov] search2 HTTP status:', status)
    console.log('[grants.gov] search2 oppHits returned:', hits.length)
    if (hits.length === 0) {
      console.warn('[grants.gov] search2 returned 0 results; full response:', JSON.stringify(data, null, 2))
    }

    const mapped = hits.map((hit) => {
      const number = hit?.number ?? hit?.oppNum ?? hit?.oppNumber ?? null
      const id = hit?.id ?? hit?.oppId ?? null
      const title = hit?.title ?? hit?.oppTitle ?? ''
      const agencyName = hit?.agencyName ?? hit?.agency ?? ''
      const agencyCode = hit?.agencyCode ?? ''
      const openDate = hit?.openDate ?? null
      const closeDate = hit?.closeDate ?? null
      const oppStatus = hit?.oppStatus ?? null
      const alnlist = hit?.alnlist ?? null
      const fundingInstrument = hit?.fundingInstrumentType ?? hit?.fundingInstrument ?? ''
      const costSharing = hit?.costSharingOrMatchingRequirement ?? hit?.costSharing ?? ''

      const url =
        id != null
          ? `https://www.grants.gov/search-results-detail/${id}`
          : number
            ? `https://www.grants.gov/search-grants?query=${encodeURIComponent(String(number))}`
            : 'https://www.grants.gov/search-grants'

      const keywords = []
      if (agencyCode) keywords.push(String(agencyCode))
      if (oppStatus) keywords.push(String(oppStatus))
      if (openDate) keywords.push(String(openDate))
      if (Array.isArray(alnlist)) keywords.push(...alnlist.map((v) => String(v)))

      const statusLower = oppStatus ? String(oppStatus).toLowerCase() : ''
      const isActive = statusLower.includes('posted') || statusLower.includes('forecast')

      const instCode = String(fundingInstrument).toUpperCase()
      const is_loan = /^L$|^PC$|^LOAN$/.test(instCode) || instCode.includes('LOAN')
      const requires_match = /^yes$|^true$|^1$/.test(String(costSharing).toLowerCase().trim())

      return {
        title: title || '',
        sponsor: agencyName || '',
        source: 'grants.gov',
        source_id: number ? String(number) : '',
        source_url: url,
        description: `Grants.gov opportunity ${number || ''}${oppStatus ? ` (${oppStatus})` : ''}`.trim(),
        amount_min: null,
        amount_max: null,
        deadline: closeDate ? new Date(closeDate).toISOString().split('T')[0] : null,
        deadline_type: closeDate ? 'fixed' : 'rolling',
        application_url: url,
        is_national: true,
        categories: ['federal', 'grants.gov', 'government'],
        keywords,
        opportunity_type: 'grant',
        type: 'OPPORTUNITY',
        evidence_url: SEARCH2_URL,
        last_verified_at: new Date().toISOString(),
        is_active: isActive,
        last_crawled: new Date().toISOString(),
        is_loan,
        requires_match,
      }
    });

    return mapped.filter((o) => !o.is_loan && !o.requires_match);
  } catch (error) {
    console.error('[Grants.gov] Search failed:', error.message);
    throw error;
  }
}

/**
 * Get detailed opportunity information
 * @param {string} opportunityId - Grants.gov opportunity ID
 * @returns {Promise<Object>} Detailed opportunity data
 */
export async function getOpportunityDetails(opportunityId) {
  try {
    const data = await rateLimitedFetch(`${BASE_URL}/opportunity/details/${opportunityId}`);
    
    const opp = data;
    
    return {
      title: opp.oppTitle || '',
      sponsor: opp.agencyName || '',
      source: 'grants.gov',
      source_id: opp.oppNumber || '',
      source_url: `https://www.grants.gov/web/grants/view-opportunity.html?oppId=${opportunityId}`,
      description: opp.description || opp.oppDescription || '',
      eligibility_bullets: opp.eligibility || [],
      amount_min: opp.awardCeiling ? parseFloat(opp.awardCeiling) : null,
      amount_max: opp.awardFloor ? parseFloat(opp.awardFloor) : null,
      deadline: opp.closeDate ? new Date(opp.closeDate).toISOString().split('T')[0] : null,
      deadline_type: 'fixed',
      application_url: `https://www.grants.gov/web/grants/view-opportunity.html?oppId=${opportunityId}`,
      is_national: true,
      categories: opp.categories || [],
      keywords: [opp.oppTitle, opp.agencyCode, opp.cfdaNumber].filter(Boolean),
      opportunity_type: 'grant',
      type: 'OPPORTUNITY',
      evidence_url: `${BASE_URL}/opportunity/details/${opportunityId}`,
      last_verified_at: new Date().toISOString(),
      requires_501c3: opp.eligibility?.some(e => e.includes('501(c)(3)')) || false,
      is_active: opp.oppStatus === 'posted',
      last_crawled: new Date().toISOString(),
      // Contact information if available
      contact_email: opp.contactEmail || null,
      contact_phone: opp.contactPhone || null
    };
  } catch (error) {
    console.error(`[Grants.gov] Failed to get details for ${opportunityId}:`, error.message);
    throw error;
  }
}

/**
 * Search for opportunities by state/region
 */
export async function searchByState(state, params = {}) {
  // Grants.gov federal opportunities are typically national
  // but we can search for state-specific keywords
  return searchOpportunities({
    ...params,
    keyword: `${state} ${params.keyword || ''}`.trim()
  });
}

export default {
  searchOpportunities,
  getOpportunityDetails,
  searchByState
};
