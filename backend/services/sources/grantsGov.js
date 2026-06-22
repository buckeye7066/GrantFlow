/**
 * DEPRECATED compatibility shim.
 *
 * Historical home of the Grants.gov connector. The implementation was moved
 * to `backend/services/grantsDotGovCrawler.js`. This shim exists so that
 * pinned ingestion scripts (`scripts/ingest.mjs`, `scripts/ingest-grantsgov.mjs`
 * — both wired into npm scripts `ingest` and `ingest:grantsgov`) and any
 * long-lived operational tooling continue to work across logins, machines,
 * and deployments without silent breakage.
 *
 * Covered by `tests/unit/legacy-module-resilience.test.mjs`.
 *
 * If you are writing new code, import `fetchGrantsGov` /
 * `transformGrantsGovOpportunity` from `../grantsDotGovCrawler.js` directly.
 */

import {
  fetchGrantsGov as _canonicalFetch,
  transformGrantsGovOpportunity as _canonicalTransform,
} from '../shared/grantsGovApiClient.js'

/**
 * Legacy-shape wrapper: fetches from Grants.gov and normalizes the response
 * into the historical `{ opportunities, metadata }` contract expected by
 * `ingestionService.ingestOpportunities`.
 *
 * @param {Object} options
 * @param {number} [options.limit=25]  Max records per page (mapped to `rows`).
 * @param {number} [options.offset=0]  Offset (mapped to `startRow`).
 * @param {string} [options.keyword]   Optional keyword filter.
 * @returns {Promise<{ opportunities: Array<Object>, metadata: Object }>}
 */
export async function fetchGrantsGov(options = {}) {
  const { limit = 25, offset = 0, keyword = '' } = options

  const rows = Math.max(1, Math.min(Number(limit) || 25, 1000))
  const startRow = Math.max(0, Number(offset) || 0)

  const raw = await _canonicalFetch({
    rows,
    startRow,
    keyword,
    oppStatus: 'forecasted|posted',
  })

  const oppHits = Array.isArray(raw?.oppHits) ? raw.oppHits : []
  const opportunities = oppHits.map((hit) => _canonicalTransform(hit))

  const metadata = {
    source: 'grants.gov',
    fetched_at: new Date().toISOString(),
    requested_rows: rows,
    requested_offset: startRow,
    returned_count: opportunities.length,
    hit_count: Number(raw?.hitCount ?? raw?.totalHits ?? oppHits.length) || oppHits.length,
  }

  return { opportunities, metadata }
}

export default { fetchGrantsGov }
