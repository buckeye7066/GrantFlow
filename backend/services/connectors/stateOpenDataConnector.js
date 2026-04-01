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

const RATE_LIMIT_MS = 1000; // 1 request per second

let lastRequestTime = 0;

// State-specific Socrata endpoints
const STATE_DATA_PORTALS = {
  'OH': {
    domain: 'data.ohio.gov',
    grants_dataset: null, // Ohio doesn't have a centralized grants dataset on Socrata
    programs_dataset: null,
    name: 'Ohio Open Data'
  },
  'CA': {
    domain: 'data.ca.gov',
    grants_dataset: null,
    programs_dataset: null,
    name: 'California Open Data'
  },
  'NY': {
    domain: 'data.ny.gov',
    grants_dataset: null,
    programs_dataset: null,
    name: 'New York Open Data'
  },
  'TX': {
    domain: 'data.texas.gov',
    grants_dataset: null,
    programs_dataset: null,
    name: 'Texas Open Data'
  },
  'FL': {
    domain: 'data.fl.gov',
    grants_dataset: null,
    programs_dataset: null,
    name: 'Florida Open Data'
  }
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
  
  console.log(`[State Open Data] Searching ${portal.name} for ${state}`);
  
  // In production, you would:
  // 1. Configure specific dataset IDs for each state
  // 2. Query Socrata API with SODA queries
  // 3. Parse results and classify as OPPORTUNITY/PROGRAM/DIRECTORY
  
  // Example Socrata query structure:
  // https://data.ohio.gov/resource/dataset-id.json?$where=status='open'&$limit=100
  
  // For now, return state agency information as DIRECTORY entries
  // No real dataset IDs are configured for any portal in STATE_DATA_PORTALS.
  // Returning placeholder DIRECTORY stubs risks injecting records with no
  // application path into the pipeline (violates Goal 1) and polluting
  // results with junk entries (violates Goal 3).
  // Return empty array until real dataset IDs are configured.
  const hasDataset = portal.grants_dataset || portal.programs_dataset;
  if (!hasDataset) {
    console.warn(
      `[State Open Data] No dataset IDs configured for ${state} (${portal.name}). ` +
      'Skipping stub entry â configure grants_dataset or programs_dataset to enable.'
    );
    return [];
  }

  // --- Real Socrata query path (reached only when dataset IDs are configured) ---
  const datasetId = portal.grants_dataset || portal.programs_dataset;
  const queryUrl =
    `https://${portal.domain}/resource/${datasetId}.json` +
    `?$limit=${params.limit || 100}`;

  let rows;
  try {
    rows = await rateLimitedFetch(queryUrl);
  } catch (err) {
    console.error(`[State Open Data] Fetch failed for ${state}: ${err.message}`);
    return [];
  }

  // Map raw Socrata rows to GrantFlow opportunity shape.
  // Rows without an application URL are classified as DIRECTORY and
  // must be filtered by the caller before pipeline insertion.
  const stateResources = rows.map(row => ({
    title: row.title || row.program_name || row.name || '(untitled)',
    description: row.description || row.summary || '',
    sponsor: row.agency || row.organization || `${state} State Government`,
    source: portal.domain,
    source_url: row.url || row.application_url || row.link || null,
    application_url: row.application_url || row.url || row.link || null,
    type: (row.application_url || row.url || row.link) ? 'OPPORTUNITY' : 'DIRECTORY',
    state: state,
    evidence_url: row.url || `https://${portal.domain}/resource/${datasetId}`,
    last_verified_at: new Date().toISOString(),
    is_active: true,
    last_crawled: new Date().toISOString()
  }));

  const withUrl = stateResources.filter(r => r.application_url);
  const withoutUrl = stateResources.length - withUrl.length;
  if (withoutUrl > 0) {
    console.warn(
      `[State Open Data] ${state}: ${withoutUrl}/${stateResources.length} rows ` +
      'had no application URL â classified as DIRECTORY, excluded from OPPORTUNITY set.'
    );
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

  const datasetId = portal.programs_dataset || portal.grants_dataset;
  if (!datasetId) {
    // No real dataset configured â log and return null so callers can skip
    // pipeline insertion rather than inserting a stub with no application path.
    console.warn(
      `[State Open Data] getStateProgramDetails(${state}, ${programId}): ` +
      'no dataset ID configured â returning null to prevent stub insertion.'
    );
    return null;
  }

  const queryUrl =
    `https://${portal.domain}/resource/${datasetId}.json` +
    `?$where=id='${encodeURIComponent(programId)}'&$limit=1`;

  let rows;
  try {
    rows = await rateLimitedFetch(queryUrl);
  } catch (err) {
    console.error(
      `[State Open Data] getStateProgramDetails fetch failed ` +
      `(${state}/${programId}): ${err.message}`
    );
    return null;
  }

  if (!rows || rows.length === 0) {
    console.warn(
      `[State Open Data] No record found for programId=${programId} in ${state}.`
    );
    return null;
  }

  const row = rows[0];
  return {
    title: row.title || row.program_name || row.name || programId,
    state: state,
    type: 'PROGRAM',
    application_url: row.application_url || row.url || row.link || null,
    evidence_url: row.url || `https://${portal.domain}/resource/${datasetId}`,
    last_verified_at: new Date().toISOString()
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
  
  console.log(`[State Open Data] Configured portal for ${state}`);
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
