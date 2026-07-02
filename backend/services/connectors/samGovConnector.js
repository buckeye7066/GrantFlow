/**
 * SAM.gov Assistance Listings Connector
 * Federal assistance programs and CFDA numbers
 *
 * API Documentation: https://open.gsa.gov/api/fh-public-api/
 * Base URL: https://api.sam.gov/opportunities/v2/ (as of 2024+)
 *   Assistance listings: https://api.sam.gov/assistance-listing/v1/
 *
 * LEGAL: Public domain federal data, free to use
 * RATE LIMIT: Not explicitly stated, use 2 req/sec conservative
 * API KEY: Required - register at https://open.gsa.gov/api/fh-public-api/
 *   Set SAM_GOV_API_KEY environment variable.
 * TOS: https://sam.gov/content/home
 */

import fetch from 'node-fetch';
import { getSamGovApiKey } from '../../config/grantsGovEndpoints.js';

// NOTE: The /prod/ path segment was removed in 2023. The current canonical base is:
//   https://api.sam.gov/assistance-listing/v1/
// If SAM_GOV_API_BASE_URL is set in env, it takes precedence (useful for staging).
const BASE_URL = process.env.SAM_GOV_API_BASE_URL || 'https://api.sam.gov/assistance-listing/v1';
const RATE_LIMIT_MS = 500; // 2 requests per second

let lastRequestTime = 0;

/**
 * Rate-limited fetch wrapper
 */
async function rateLimitedFetch(url, apiKey) {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < RATE_LIMIT_MS) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - timeSinceLastRequest));
  }
  
  lastRequestTime = Date.now();
  
  if (!apiKey) {
    throw new Error('SAM.gov API key required. Set SAM_GOV_API_KEY environment variable.');
  }
  
  const response = await fetch(url, {
    // node-fetch has no default deadline; without a signal a hung remote stalls the caller forever.
    signal: AbortSignal.timeout(30000),
    headers: {
      'X-Api-Key': apiKey,
      'User-Agent': 'GrantFlow/1.0 (grant management system)'
    }
  });
  
  if (!response.ok) {
    throw new Error(`SAM.gov API error: ${response.status} ${response.statusText}`);
  }
  
  return response.json();
}

/**
 * Search assistance listings
 * @param {Object} params - Search parameters
 * @param {string} params.keyword - Keyword search
 * @param {string} params.agency - Federal agency code
 * @param {number} params.limit - Results limit
 * @returns {Promise<Array>} Array of programs (PROGRAM type - standing assistance, not open grants)
 */
export async function searchAssistanceListings(params = {}) {
  const apiKey = getSamGovApiKey();

  if (!apiKey) {
    console.warn('[SAM.gov] SAM_GOV_PUBLIC_API_KEY / SAM_GOV_API_KEY is not set — skipping SAM.gov assistance listings search.')
    return []
  }

  const queryParams = new URLSearchParams({
    limit: params.limit || 100,
    offset: params.offset || 0
  });
  
  if (params.keyword) {
    queryParams.append('keyword', params.keyword);
  }
  
  if (params.agency) {
    queryParams.append('agency_code', params.agency);
  }
  
  try {
    const url = `${BASE_URL}/assistance-listings?${queryParams}`;
    const data = await rateLimitedFetch(url, apiKey);
    
    const listings = data.assistanceListings || [];
    const loanOrMatchRe = /\bloan\b|\bmicroloan\b|\bfinancing\b|\bmatching\b|\bcost share\b|\bmatch required\b|\b1:1\b|\bdollar for dollar\b/i;
    
    return listings
      .filter((listing) => {
        const text = `${listing.programTitle || ''} ${listing.programObjectives || ''} ${listing.applicantEligibility || ''}`;
        return !loanOrMatchRe.test(text);
      })
      .map(listing => ({
      title: listing.programTitle || '',
      sponsor: listing.federalAgency || '',
      source: 'sam.gov',
      source_id: listing.programNumber || '', // CFDA number
      source_url: `https://sam.gov/fal/${listing.programNumber}/view`,
      description: listing.programObjectives || '',
      eligibility_bullets: listing.applicantEligibility ? [listing.applicantEligibility] : [],
      amount_min: null, // Varies by program
      amount_max: null,
      deadline: null, // Standing programs typically don't have single deadline
      deadline_type: 'rolling', // Most assistance listings are ongoing programs
      application_url: `https://sam.gov/fal/${listing.programNumber}/view`,
      is_national: true,
      categories: [listing.functionalCode].filter(Boolean),
      keywords: [listing.programTitle, listing.programNumber].filter(Boolean),
      opportunity_type: 'program',
      type: 'PROGRAM', // Standing assistance program, NOT an open solicitation
      evidence_url: url,
      is_active: true,
      last_crawled: new Date().toISOString(),
      is_loan: false,
      requires_match: false,
      // Program details
      cfda_number: listing.programNumber,
      authorization: listing.authorization || null
    }));
  } catch (error) {
    console.error('[SAM.gov] Search failed:', error.message);
    throw error;
  }
}

/**
 * Get assistance listing details by CFDA number
 */
export async function getAssistanceListingDetails(cfdaNumber) {
  const apiKey = getSamGovApiKey();

  try {
    const url = `${BASE_URL}/assistance-listings/${cfdaNumber}`;
    const data = await rateLimitedFetch(url, apiKey);
    
    const listing = data;
    
    return {
      title: listing.programTitle || '',
      sponsor: listing.federalAgency || '',
      source: 'sam.gov',
      source_id: cfdaNumber,
      source_url: `https://sam.gov/fal/${cfdaNumber}/view`,
      description: listing.programObjectives || '',
      eligibility_bullets: [
        listing.applicantEligibility,
        listing.beneficiaryEligibility
      ].filter(Boolean),
      deadline_type: 'rolling',
      application_url: `https://sam.gov/fal/${cfdaNumber}/view`,
      is_national: true,
      type: 'PROGRAM',
      evidence_url: url,
      cfda_number: cfdaNumber,
      authorization: listing.authorization || null,
      contact_email: listing.contactEmail || null,
      contact_phone: listing.contactPhone || null
    };
  } catch (error) {
    console.error(`[SAM.gov] Failed to get listing ${cfdaNumber}:`, error.message);
    throw error;
  }
}

export default {
  searchAssistanceListings,
  getAssistanceListingDetails
};
