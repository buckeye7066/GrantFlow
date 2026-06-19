/**
 * Centralized Grants.gov API endpoints.
 *
 * ALL Grants.gov and Simpler Grants API URLs live here. Every crawler,
 * connector, and source that talks to Grants.gov MUST import from this
 * module. Inline URL strings are forbidden.
 */

/** Legacy Grants.gov search API (v1) */
export const GRANTS_GOV_SEARCH2_URL = 'https://api.grants.gov/v1/api/search2'

/** Grants.gov opportunity detail URL template */
export const GRANTS_GOV_DETAIL_URL = 'https://www.grants.gov/search-results-detail/'

/** Grants.gov view opportunity URL template */
export const GRANTS_GOV_VIEW_URL = 'https://www.grants.gov/view-opportunity/'

/** Simpler Grants API - opportunity search */
export const SIMPLER_GRANTS_SEARCH_URL = 'https://api.simpler.grants.gov/v1/opportunities/search'

/** Simpler Grants API - single opportunity */
export const SIMPLER_GRANTS_OPPORTUNITY_URL = 'https://api.simpler.grants.gov/v1/opportunities'

/** Simpler Grants API base URL */
export const SIMPLER_GRANTS_BASE_URL = 'https://api.simpler.grants.gov'

/** Environment variable names for API keys */
export const GRANTS_GOV_API_KEY_ENV = 'GRANTS_GOV_API_KEY'
export const SIMPLER_GRANTS_API_KEY_ENV = 'SIMPLER_GRANTS_API_KEY'
export const SAM_GOV_API_KEY_ENV = 'SAM_GOV_API_KEY'

/**
 * Canonical SAM.gov API key accessor.
 *
 * The codebase historically split on the variable name: the ingestion gate,
 * diagnostics, and src/config/apiKeys read SAM_GOV_PUBLIC_API_KEY, while the
 * connectors that actually authenticate the fetch read SAM_GOV_API_KEY. Setting
 * only one name therefore opened the gate but failed the fetch (or vice versa).
 * Resolve BOTH here — prefer SAM_GOV_PUBLIC_API_KEY (the documented operator
 * variable) and fall back to the legacy SAM_GOV_API_KEY — so either works.
 */
export function getSamGovApiKey() {
  return process.env.SAM_GOV_PUBLIC_API_KEY || process.env.SAM_GOV_API_KEY || null
}
