/**
 * USAspending Intelligence Connector
 * For identifying funding agencies and recurring programs
 * NOT treated as opportunities unless application path proven
 * 
 * API Documentation: https://api.usaspending.gov/
 * 
 * LEGAL: Public domain federal data
 * RATE LIMIT: 500 req/hour (conservative approach)
 * TOS: Public use encouraged
 * 
 * NOTE: USAspending shows AWARDS (past grants), not opportunities
 * Use this to identify agencies and programs, then verify if currently open
 */

import fetch from 'node-fetch';

const BASE_URL = 'https://api.usaspending.gov/api/v2';
const RATE_LIMIT_MS = 7200; // ~500 requests per hour

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
    // node-fetch has no default deadline; without a signal a hung remote stalls the caller forever.
    signal: AbortSignal.timeout(30000),
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'GrantFlow/1.0 (grant management system)',
      ...options.headers
    }
  });
  
  if (!response.ok) {
    throw new Error(`USAspending API error: ${response.status} ${response.statusText}`);
  }
  
  return response.json();
}

/**
 * Search for grant awards by keyword
 * IMPORTANT: These are PAST awards, not current opportunities
 * Use to identify active agencies and programs, then verify current status
 * 
 * @param {Object} params - Search parameters
 * @returns {Promise<Array>} Array of award intelligence (NOT marked as OPPORTUNITY)
 */
export async function searchAwards(params = {}) {
  const searchPayload = {
    filters: {
      keywords: [params.keyword || ''],
      time_period: [
        {
          // Default: rolling 2-year lookback from today (no hardcoded stale dates)
          start_date: params.startDate || (() => { const d = new Date(); d.setFullYear(d.getFullYear() - 2); return d.toISOString().split('T')[0] })(),
          end_date: params.endDate || new Date().toISOString().split('T')[0]
        }
      ],
      award_type_codes: ['02', '03', '04', '05'], // Grant types
      award_amounts: [
        {
          lower_bound: params.minAmount || 0,
          upper_bound: params.maxAmount || 1000000000
        }
      ]
    },
    fields: [
      'Award ID',
      'Award Amount',
      'Awarding Agency',
      'Recipient Name',
      'Start Date',
      'Description'
    ],
    limit: params.limit || 100,
    page: params.page || 1
  };
  
  try {
    const data = await rateLimitedFetch(`${BASE_URL}/search/spending_by_award/`, {
      method: 'POST',
      body: JSON.stringify(searchPayload)
    });
    
    const awards = data.results || [];
    
    // Return as intelligence, NOT as opportunities
    return awards.map(award => ({
      title: award['Description'] || 'Grant Award',
      sponsor: award['Awarding Agency'] || '',
      source: 'usaspending.gov',
      source_id: award['Award ID'] || '',
      source_url: award['Award ID']
        ? `https://www.usaspending.gov/award/${encodeURIComponent(award['Award ID'])}`
        : null,
      description: `Past award: ${award['Description'] || 'No description'}`,
      amount_awarded: award['Award Amount'] || 0,
      award_date: award['Start Date'],
      recipient: award['Recipient Name'],
      // CRITICAL: Mark as DIRECTORY, not OPPORTUNITY
      // This is historical data, not an open solicitation
      type: 'DIRECTORY',
      evidence_url: award['Award ID']
        ? `https://www.usaspending.gov/award/${encodeURIComponent(award['Award ID'])}`
        : null,
      is_active: false, // Past awards are not active opportunities
      last_crawled: new Date().toISOString(),
      notes: 'Historical award data - verify if program currently accepting applications'
    }));
  } catch (error) {
    console.error('[USAspending] Search failed:', {
      keyword: params.keyword,
      page: params.page,
      message: error.message
    });
    throw error;
  }
}

/**
 * Get agency spending patterns
 * Use to identify which agencies are active in a particular area
 */
export async function getAgencySpending(agencyCode, params = {}) {
  try {
    const data = await rateLimitedFetch(`${BASE_URL}/agency/${agencyCode}/`);
    
    return {
      agency_name: data.agency_name,
      total_obligations: data.total_obligations,
      active_programs: data.active_programs || [],
      type: 'DIRECTORY', // Agency information, not an opportunity
      evidence_url: `https://www.usaspending.gov/agency/${agencyCode}/`,
    };
  } catch (error) {
    console.error(`[USAspending] Failed to get agency ${agencyCode}:`, error.message);
    throw error;
  }
}

/**
 * IMPORTANT USAGE NOTES:
 * 
 * 1. USAspending shows PAST AWARDS, not current opportunities
 * 2. Use this data to:
 *    - Identify agencies that fund specific areas
 *    - Understand typical award amounts
 *    - Find recurring programs
 * 3. Then verify if programs are currently open via:
 *    - Grants.gov for federal opportunities
 *    - Agency websites for program announcements
 *    - Sam.gov for assistance listings
 * 4. NEVER present USAspending data as open opportunities
 *    - Always mark as DIRECTORY type
 *    - Include notes that verification is needed
 */

export default {
  searchAwards,
  getAgencySpending
};
