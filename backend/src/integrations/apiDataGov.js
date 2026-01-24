import { requestJson } from './httpClient.js'
import { loadFundingApiKeys } from '../config/apiKeys.js'

/**
 * api.data.gov example integration (GovInfo).
 *
 * Many agency APIs behind api.data.gov accept an `api_key` query param.
 * This client is intentionally small and safe: it is used for validation + smoke checks
 * and as a canonical pattern for adding more api.data.gov-backed endpoints.
 *
 * Docs:
 * - https://api.data.gov/docs/developer-manual/
 * - https://api.govinfo.gov/docs/
 */

/**
 * Fetch a GovInfo package summary by package id.
 *
 * Auth: `api_key` query parameter.
 *
 * @param {string} packageId - e.g. "FR-2018-08-03"
 * @returns {Promise<any>}
 */
export async function fetchGovInfoPackageSummary(packageId) {
  const { API_DATA_GOV_KEY } = loadFundingApiKeys()
  if (!API_DATA_GOV_KEY) {
    const err = new Error('Missing API_DATA_GOV_KEY (required for api.data.gov-backed APIs such as GovInfo).')
    err.code = 'MISSING_API_KEY'
    throw err
  }

  const normalized = String(packageId || '').trim()
  if (!normalized) {
    const err = new Error('packageId is required')
    err.status = 400
    throw err
  }

  return requestJson({
    provider: 'api.data.gov',
    url: `https://api.govinfo.gov/packages/${encodeURIComponent(normalized)}/summary`,
    method: 'GET',
    params: { api_key: API_DATA_GOV_KEY },
    timeoutMs: 20_000,
    maxRetries: 2,
  })
}

