/**
 * State Open Data Connector
 * Socrata-style datasets per state
 * Configurable state-by-state for grant and program data
 * 
 * Many states publish open data via Socrata platform
 * Examples:
 * - Ohio: https://data.ohio.gov
 * - California: https://data.ca.gov
 * - New York: https://data.ny.gov
 * 
 * LEGAL: Public domain state data
 * RATE LIMIT: Varies by state, use 1 req/sec conservative
 * TOS: Check individual state data portals
 */

import fetch from 'node-fetch';
import { createLogger } from '../../utils/logger.js'
import { isPlaceholderUrl } from '../../config/urlRules.js'

/**
 * Accept a crawled third-party URL only if it's a real http(s) URL (the
 * canonical placeholder check also rejects localhost/127.0.0.1/non-http
 * schemes), otherwise fall back to the trusted portal URL. Prevents unsanitized
 * Socrata `record.url` values from being persisted as an opportunity's source.
 */
function safeSourceUrl(candidate, fallback) {
  const c = typeof candidate === 'string' ? candidate.trim() : '';
  if (c && !isPlaceholderUrl(c) && c.length <= 2048) return c;
  return fallback;
}
const log = createLogger('stateOpenDataConnector')

const RATE_LIMIT_MS = 1000; // 1 request per second

let lastRequestTime = 0;

// State-specific Socrata/open-data endpoints.
// grants_dataset: Socrata 4×4 dataset ID for open grant solicitations (if available).
// programs_dataset: Socrata 4×4 dataset ID for program/assistance listings (if available).
// portal_grants_url: Direct URL to the state grants portal (authoritative fallback).
const STATE_DATA_PORTALS = {
  'OH': {
    domain: 'data.ohio.gov',
    grants_dataset: null, // Ohio does not publish a unified grants dataset on Socrata
    programs_dataset: null,
    portal_grants_url: 'https://grants.ohio.gov/',
    name: 'Ohio Open Data'
  },
  'CA': {
    domain: 'data.ca.gov',
    grants_dataset: null, // CA grants are published at grants.ca.gov, not data.ca.gov
    programs_dataset: null,
    portal_grants_url: 'https://www.grants.ca.gov/',
    name: 'California Open Data'
  },
  'NY': {
    // NY publishes state contracts/grants via data.ny.gov; dataset '63vv-5f67' is state grants awarded.
    domain: 'data.ny.gov',
    grants_dataset: '63vv-5f67', // NY State Grants Awarded (Socrata)
    programs_dataset: null,
    portal_grants_url: 'https://grantsgateway.ny.gov/',
    name: 'New York Open Data'
  },
  'TX': {
    domain: 'data.texas.gov',
    grants_dataset: null, // Texas grants portal is separate from open data
    programs_dataset: null,
    portal_grants_url: 'https://gov.texas.gov/organization/financial-services/grants',
    name: 'Texas Open Data'
  },
  'FL': {
    domain: 'open.floridacommerce.org', // Florida DEO open data (replaces data.fl.gov for grants)
    grants_dataset: null,
    programs_dataset: null,
    portal_grants_url: 'https://floridajobs.org/business-growth-and-partnerships/for-businesses-and-employers/browse-business-resources/grants',
    name: 'Florida Open Data'
  },
  'PA': {
    domain: 'data.pa.gov',
    grants_dataset: null,
    programs_dataset: null,
    portal_grants_url: 'https://www.grants.pa.gov/',
    name: 'Pennsylvania Open Data'
  },
  'TN': {
    domain: 'data.tn.gov',
    grants_dataset: null,
    programs_dataset: null,
    portal_grants_url: 'https://www.tn.gov/finance/strategic-initiatives/state-grants.html',
    name: 'Tennessee Open Data'
  },
};

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
      'Accept': 'application/json',
      'User-Agent': 'GrantFlow/1.0 (grant management system)',
      ...options.headers
    }
  });
  
  if (!response.ok) {
    throw new Error(`State open data API error: ${response.status} ${response.statusText}`);
  }
  
  return response.json();
}

/**
 * Search state open data for grants and programs
 * @param {string} state - Two-letter state code
 * @param {Object} params - Search parameters
 * @returns {Promise<Array>} Array of state opportunities/programs
 */
export async function searchStateData(state, params = {}) {
  const portal = STATE_DATA_PORTALS[state];
  
  if (!portal) {
    console.warn(`[State Open Data] No portal configured for ${state}`);
    return [];
  }
  
  log.info(`[State Open Data] Searching ${portal.name} for ${state}`);
  
  // In production, you would:
  // 1. Configure specific dataset IDs for each state
  // 2. Query Socrata API with SODA queries
  // 3. Parse results and classify as OPPORTUNITY/PROGRAM/DIRECTORY
  
  // Example Socrata query structure:
  // https://data.ohio.gov/resource/dataset-id.json?$where=status='open'&$limit=100
  
  const stateResources = [];

  // Return authoritative grants portal as a DIRECTORY entry
  const portalUrl = portal.portal_grants_url || `https://${portal.domain}`;
  stateResources.push({
    title: `${state} State Grants Portal`,
    description: 'Central portal for state grant opportunities',
    sponsor: `${state} State Government`,
    source: portal.domain,
    source_url: portalUrl,
    type: 'DIRECTORY', // Portal/directory, not a specific grant
    state: state,
    evidence_url: portalUrl,
    is_active: true,
    last_crawled: new Date().toISOString()
  });

  // If a Socrata grants dataset is configured, attempt to query it
  if (portal.grants_dataset) {
    try {
      const socrataUrl = `https://${portal.domain}/resource/${portal.grants_dataset}.json?$limit=50`;
      const data = await rateLimitedFetch(socrataUrl);
      if (Array.isArray(data)) {
        for (const record of data) {
          const title = record.program_name || record.grant_name || record.title || record.program || null;
          if (!title) continue;
          stateResources.push({
            title: String(title),
            sponsor: record.agency || record.grantor || `${state} State Government`,
            source: portal.domain,
            source_id: record.id || record.program_number || null,
            source_url: safeSourceUrl(record.url || record.program_url, portalUrl),
            description: record.description || record.program_description || `State grant program in ${state}`,
            deadline: record.deadline || record.close_date || null,
            deadline_type: record.deadline ? 'fixed' : 'rolling',
            amount_min: record.min_award ? parseFloat(record.min_award) : null,
            amount_max: record.max_award || record.award_ceiling ? parseFloat(record.max_award || record.award_ceiling) : null,
            type: 'OPPORTUNITY',
            state: state,
            evidence_url: socrataUrl,
            is_active: true,
            last_crawled: new Date().toISOString()
          });
        }
        log.info(`[State Open Data] ${state}: Fetched ${data.length} records from Socrata dataset ${portal.grants_dataset}`);
      }
    } catch (socrataError) {
      console.warn(`[State Open Data] ${state}: Socrata fetch failed (${socrataError.message}), using portal directory entry only`);
    }
  }

  return stateResources;
}

/**
 * Get state-specific program information
 */
export async function getStateProgramDetails(state, programId) {
  const portal = STATE_DATA_PORTALS[state];
  
  if (!portal) {
    throw new Error(`No portal configured for ${state}`);
  }
  
  // In production, query specific dataset
  return {
    title: programId,
    state: state,
    type: 'PROGRAM', // State programs are typically standing programs
    evidence_url: `https://${portal.domain}`,
  };
}

/**
 * Configure a new state data portal
 * Administrators can add state-specific Socrata endpoints
 */
export function configureStatePortal(state, config) {
  STATE_DATA_PORTALS[state] = {
    domain: config.domain,
    grants_dataset: config.grants_dataset,
    programs_dataset: config.programs_dataset,
    name: config.name
  };
  
  log.info(`[State Open Data] Configured portal for ${state}`);
}

/**
 * IMPLEMENTATION NOTES FOR PRODUCTION:
 * 
 * 1. State Data Sources:
 *    - Socrata-powered open data portals (most common)
 *    - State-specific grant management systems
 *    - CKAN-based portals (some states)
 *    - Direct agency websites
 * 
 * 2. Data Classification:
 *    - OPPORTUNITY: Active, open grant solicitations with deadlines
 *    - PROGRAM: Standing state programs (e.g., workforce development)
 *    - DIRECTORY: General resources, agency listings, closed programs
 * 
 * 3. State-Specific Considerations:
 *    - Each state has different data structure
 *    - Some states require API keys (register with each portal)
 *    - Update frequencies vary
 *    - Check TOS for each state portal
 * 
 * 4. Recommended Approach:
 *    - Build one connector per state initially
 *    - Focus on largest states first (CA, TX, NY, FL, OH)
 *    - Work with state agencies for data access
 *    - Document each state's unique endpoints
 */

export default {
  searchStateData,
  getStateProgramDetails,
  configureStatePortal
};
