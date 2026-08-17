/**
 * Centralized Grants.gov API endpoints.
 *
 * Backward-compatible application facade for Grants.gov and Simpler Grants
 * endpoints. The dependency-free shared/grantsGovProtocol.js contract owns the
 * Search2 URLs and is imported directly by Crawler OS; existing application
 * callers may continue importing those re-exports here. Inline URL strings are
 * forbidden in either runtime.
 */

// Backward-compatible endpoint exports. The dependency-free protocol module is
// the authority shared by the Crawler OS and the live Grants.gov API client.
export {
  GRANTS_GOV_SEARCH2_URL,
  GRANTS_GOV_DETAIL_URL,
  GRANTS_GOV_VIEW_URL,
} from '../../shared/grantsGovProtocol.js'

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
  // Canonical name, documented legacy alias, then hand-entered variants seen in
  // the Railway dashboard (env var names are case-sensitive on Linux, so a key
  // saved as `Sam_gov_key` is otherwise invisible and silently disables SAM).
  return (
    process.env.SAM_GOV_PUBLIC_API_KEY ||
    process.env.SAM_GOV_API_KEY ||
    process.env.Sam_gov_key ||
    process.env.SAM_GOV_KEY ||
    null
  )
}
