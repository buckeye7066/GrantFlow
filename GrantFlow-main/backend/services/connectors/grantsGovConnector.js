/**
 * Grants.gov API Connector
 * Integrates with the official Grants.gov REST API
 * 
 * API Documentation: https://www.grants.gov/web/grants/xml-web-services.html
 * Base URL: https://www.grants.gov/grantsws/rest
 * 
 * LEGAL: Public API, free to use for legitimate grant searching
 * RATE LIMIT: Not explicitly documented, use conservative 1 req/sec
 * TOS: https://www.grants.gov/web/grants/support/terms-of-use.html
 */

import fetch from 'node-fetch';

const BASE_URL = 'https://www.grants.gov/grantsws/rest';
const RATE_LIMIT_MS = 1000; // 1 second between requests

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
  
  return response.json();
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
    keyword: params.keyword || '',
    oppStatuses: params.oppStatus || 'posted',
    rows: Math.min(params.rows || 100, 1000),
    offset: params.offset || 0
  };
  
  if (params.fundingInstrument) {
    searchPayload.fundingInstruments = params.fundingInstrument;
  }
  
  if (params.eligibility) {
    searchPayload.eligibilities = params.eligibility;
  }
  
  try {
    const data = await rateLimitedFetch(`${BASE_URL}/opportunities/search`, {
      method: 'POST',
      body: JSON.stringify(searchPayload)
    });
    
    const opportunities = data.oppHits || [];
    
    return opportunities.map(opp => ({
      title: opp.oppTitle || '',
      sponsor: opp.agencyName || '',
      source: 'grants.gov',
      source_id: opp.oppNumber || '',
      source_url: `https://www.grants.gov/web/grants/view-opportunity.html?oppId=${opp.id}`,
      description: opp.oppDescription || '',
      amount_min: null, // Not in search results
      amount_max: null,
      deadline: opp.closeDate ? new Date(opp.closeDate).toISOString().split('T')[0] : null,
      deadline_type: 'fixed',
      application_url: `https://www.grants.gov/web/grants/view-opportunity.html?oppId=${opp.id}`,
      is_national: true, // Federal grants are typically national
      categories: opp.categories || [],
      keywords: [opp.oppTitle, opp.agencyCode].filter(Boolean),
      opportunity_type: 'grant',
      type: 'OPPORTUNITY', // Real, active solicitation
      evidence_url: `${BASE_URL}/opportunities/search`,
      last_verified_at: new Date().toISOString(),
      is_active: opp.oppStatus === 'posted',
      last_crawled: new Date().toISOString()
    }));
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
