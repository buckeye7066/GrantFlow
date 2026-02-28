/**
 * Resilient Grants.gov API Client
 *
 * Queries BOTH the legacy search2 API and the newer Simpler.Grants.gov API,
 * merging results for maximum coverage.  Falls back gracefully when either
 * endpoint is unreachable, rate-limited, or returns empty results.
 *
 * This module is the SINGLE source for all grants.gov network calls —
 * crawlers should use `searchGrants()` instead of calling postWithRetry
 * directly against the grants.gov endpoints.
 */

import { getWithRetry, postWithRetry } from './httpClient.js'

// ── Endpoints ──────────────────────────────────────────────────────────────────
const LEGACY_API = 'https://api.grants.gov/v1/api/search2'
const SIMPLER_API = 'https://api.simpler.grants.gov/v1/opportunities/search'
const GRANTS_GOV_DETAIL = 'https://www.grants.gov/search-results-detail/'

// ── Timeouts & limits ─────────────────────────────────────────────────────────
const API_TIMEOUT_MS = 18_000
const API_RETRIES = 2
const MAX_ROWS_PER_QUERY = 25

// ── Normaliser (both APIs → common shape) ──────────────────────────────────────

function normaliseLegacyHit(hit) {
  if (!hit) return null
  const title = hit.title ?? hit.oppTitle ?? hit.opportunityTitle ?? null
  if (!title) return null

  const id = hit.id ?? hit.oppId ?? hit.opportunityId ?? null
  const number = hit.number ?? hit.oppNum ?? hit.oppNumber ?? hit.opportunityNumber ?? null
  const agency = hit.agencyName ?? hit.agency ?? hit.agencyCode ?? null
  const closeDate = hit.closeDate ?? hit.close_date ?? null
  const openDate = hit.openDate ?? hit.open_date ?? null
  const synopsis = hit.synopsis ?? hit.description ?? null

  const description = synopsis || [
    `Federal grant opportunity: ${title}.`,
    agency ? `Funded by ${agency}.` : '',
    number ? `Opportunity number ${number}.` : '',
    'Visit Grants.gov for full eligibility details and application instructions.',
  ].filter(Boolean).join(' ')

  const url = id != null
    ? `${GRANTS_GOV_DETAIL}${id}`
    : number
      ? `https://www.grants.gov/search-grants?query=${encodeURIComponent(String(number))}`
      : 'https://www.grants.gov/search-grants'

  return {
    title,
    sponsor: agency,
    description,
    url,
    application_url: url,
    source_url: url,
    opportunity_number: number,
    amount_min: 0,
    amount_max: 0,
    amount_description: null,
    deadline: closeDate,
    open_date: openDate,
    deadline_type: closeDate ? 'fixed' : 'rolling',
    eligibility: '',
    is_national: true,
    source_id: id,
    _api_source: 'grants_gov_legacy',
  }
}

function normaliseSimplerHit(hit) {
  if (!hit) return null
  const title = hit.opportunity_title ?? hit.title ?? null
  if (!title) return null

  const id = hit.opportunity_id ?? hit.id ?? null
  const number = hit.opportunity_number ?? hit.number ?? null
  const agency = hit.agency_name ?? hit.agency ?? null
  const closeDate = hit.close_date ?? hit.post_date ?? null
  const openDate = hit.open_date ?? hit.post_date ?? null
  const synopsis = hit.summary?.summary_description ?? hit.description ?? hit.synopsis ?? null

  const description = synopsis || [
    `Federal grant opportunity: ${title}.`,
    agency ? `Funded by ${agency}.` : '',
    number ? `Opportunity number ${number}.` : '',
    'Visit Grants.gov for full eligibility details.',
  ].filter(Boolean).join(' ')

  const url = id != null
    ? `${GRANTS_GOV_DETAIL}${id}`
    : number
      ? `https://www.grants.gov/search-grants?query=${encodeURIComponent(String(number))}`
      : 'https://www.grants.gov/search-grants'

  return {
    title,
    sponsor: agency,
    description,
    url,
    application_url: url,
    source_url: url,
    opportunity_number: number,
    amount_min: 0,
    amount_max: 0,
    amount_description: null,
    deadline: closeDate,
    open_date: openDate,
    deadline_type: closeDate ? 'fixed' : 'rolling',
    eligibility: '',
    is_national: true,
    source_id: id,
    _api_source: 'simpler_grants_gov',
  }
}

// ── Legacy API ─────────────────────────────────────────────────────────────────

async function queryLegacyAPI(keyword, rows = MAX_ROWS_PER_QUERY) {
  const payload = {
    keyword,
    oppStatuses: 'forecasted|posted',
    rows: Math.min(rows, MAX_ROWS_PER_QUERY),
  }

  try {
    const response = await postWithRetry(
      LEGACY_API,
      payload,
      { headers: { 'Content-Type': 'application/json' } },
      { timeoutMs: API_TIMEOUT_MS, retries: API_RETRIES },
    )

    let parsed = response?.data
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed) } catch { parsed = null }
    }

    if (!parsed) {
      console.warn(`[GrantsGovClient] Legacy API returned unparseable body for "${keyword}"`)
      return { ok: false, hits: [], error: 'unparseable_response' }
    }

    // The grants.gov API wraps results in data.data.oppHits OR data.oppHits
    const hits =
      parsed?.data?.oppHits ??
      parsed?.oppHits ??
      parsed?.data?.opportunities ??
      parsed?.opportunities ??
      []

    const rows2 = Array.isArray(hits) ? hits : []

    // Diagnostic: log response structure when 0 results
    if (rows2.length === 0) {
      const topKeys = Object.keys(parsed).slice(0, 8).join(', ')
      const errorCode = parsed?.errorcode ?? parsed?.errorCode ?? parsed?.error_code ?? 'none'
      const msg = parsed?.msg ?? parsed?.message ?? ''
      console.warn(
        `[GrantsGovClient] Legacy API 0 hits for "${keyword}" | errorcode=${errorCode} msg="${msg}" keys=[${topKeys}]`,
      )
      // Also log inner data keys if present
      if (parsed?.data && typeof parsed.data === 'object') {
        const innerKeys = Object.keys(parsed.data).slice(0, 8).join(', ')
        console.warn(`[GrantsGovClient]   inner data keys: [${innerKeys}], hitCount=${parsed.data?.hitCount ?? 'N/A'}`)
      }
    }

    const normalised = rows2.map(normaliseLegacyHit).filter(Boolean)

    return {
      ok: true,
      hits: normalised,
      raw_count: rows2.length,
      hit_count: parsed?.data?.hitCount ?? null,
    }
  } catch (err) {
    const code = err?.code || err?.response?.status || ''
    const msg = err?.message || String(err)
    console.error(`[GrantsGovClient] Legacy API FAILED for "${keyword}": ${code} ${msg}`)
    return { ok: false, hits: [], error: `${code} ${msg}`.trim() }
  }
}

// ── Simpler.Grants.gov API ────────────────────────────────────────────────────

async function querySimplerAPI(keyword, rows = MAX_ROWS_PER_QUERY) {
  // Simpler API uses GET with query params
  const params = new URLSearchParams({
    query: keyword,
    status: 'posted,forecasted',
    page_size: String(Math.min(rows, MAX_ROWS_PER_QUERY)),
    page: '1',
    order_by: 'relevancy',
  })

  const url = `${SIMPLER_API}?${params}`

  try {
    const response = await getWithRetry(url, {}, { timeoutMs: API_TIMEOUT_MS, retries: API_RETRIES })

    let parsed = response?.data
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed) } catch { parsed = null }
    }

    if (!parsed) {
      console.warn(`[GrantsGovClient] Simpler API returned unparseable body for "${keyword}"`)
      return { ok: false, hits: [], error: 'unparseable_response' }
    }

    // Simpler API wraps results in data or items or opportunities
    const hits =
      parsed?.data ?? parsed?.items ?? parsed?.opportunities ?? parsed?.results ?? []
    const rows2 = Array.isArray(hits) ? hits : []

    if (rows2.length === 0) {
      const topKeys = Object.keys(parsed).slice(0, 8).join(', ')
      const pagination = parsed?.pagination ?? parsed?.meta ?? null
      const total = pagination?.total_records ?? pagination?.total ?? parsed?.total ?? 'N/A'
      console.warn(
        `[GrantsGovClient] Simpler API 0 hits for "${keyword}" | total=${total} keys=[${topKeys}]`,
      )
    }

    const normalised = rows2.map(normaliseSimplerHit).filter(Boolean)

    return {
      ok: true,
      hits: normalised,
      raw_count: rows2.length,
    }
  } catch (err) {
    const code = err?.code || err?.response?.status || ''
    const msg = err?.message || String(err)
    console.error(`[GrantsGovClient] Simpler API FAILED for "${keyword}": ${code} ${msg}`)
    return { ok: false, hits: [], error: `${code} ${msg}`.trim() }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Search for grant opportunities using both Grants.gov APIs.
 * Deduplicates by title (case-insensitive).
 *
 * @param {string} keyword  Search query string
 * @param {object} [opts]
 * @param {number} [opts.rows=25]  Max results per API
 * @param {boolean} [opts.legacyOnly=false]  Skip simpler API
 * @param {boolean} [opts.simplerOnly=false]  Skip legacy API
 * @returns {Promise<{ ok: boolean, opportunities: object[], diagnostics: object }>}
 */
export async function searchGrants(keyword, opts = {}) {
  const { rows = MAX_ROWS_PER_QUERY, legacyOnly = false, simplerOnly = false } = opts
  const diagnostics = { legacy: null, simpler: null, merged: 0 }

  // Run both APIs in parallel
  const [legacyResult, simplerResult] = await Promise.all([
    simplerOnly ? Promise.resolve({ ok: false, hits: [], error: 'skipped' }) : queryLegacyAPI(keyword, rows),
    legacyOnly ? Promise.resolve({ ok: false, hits: [], error: 'skipped' }) : querySimplerAPI(keyword, rows),
  ])

  diagnostics.legacy = {
    ok: legacyResult.ok,
    count: legacyResult.hits.length,
    raw_count: legacyResult.raw_count ?? 0,
    hit_count: legacyResult.hit_count ?? null,
    error: legacyResult.error ?? null,
  }
  diagnostics.simpler = {
    ok: simplerResult.ok,
    count: simplerResult.hits.length,
    raw_count: simplerResult.raw_count ?? 0,
    error: simplerResult.error ?? null,
  }

  // Merge and deduplicate
  const seen = new Set()
  const merged = []

  for (const opp of [...legacyResult.hits, ...simplerResult.hits]) {
    const key = (opp.title || '').toLowerCase().trim()
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(opp)
  }

  diagnostics.merged = merged.length

  const anyOk = legacyResult.ok || simplerResult.ok
  if (!anyOk) {
    console.error(
      `[GrantsGovClient] BOTH APIs failed for "${keyword}" | legacy: ${legacyResult.error} | simpler: ${simplerResult.error}`,
    )
  } else if (merged.length === 0) {
    console.warn(
      `[GrantsGovClient] Both APIs returned 0 results for "${keyword}" (both reachable)`,
    )
  } else {
    console.log(
      `[GrantsGovClient] "${keyword}" → ${merged.length} opportunities (legacy=${legacyResult.hits.length}, simpler=${simplerResult.hits.length})`,
    )
  }

  return {
    ok: anyOk,
    opportunities: merged,
    diagnostics,
  }
}

/**
 * Run multiple keyword searches in parallel (batched to avoid rate-limits).
 * Returns deduplicated results across ALL queries.
 *
 * @param {Array<{label:string, query:string}>} strategies
 * @param {object} [opts]
 * @param {number} [opts.batchSize=3]  Concurrent queries
 * @param {number} [opts.batchDelayMs=400]  Delay between batches
 * @param {number} [opts.rowsPerQuery=25]  Max results per query
 * @returns {Promise<{ opportunities: object[], diagnostics: object }>}
 */
export async function searchGrantsBatch(strategies, opts = {}) {
  const { batchSize = 3, batchDelayMs = 400, rowsPerQuery = MAX_ROWS_PER_QUERY } = opts

  const seenTitles = new Set()
  const allOpportunities = []
  const perStrategy = {}

  for (let i = 0; i < strategies.length; i += batchSize) {
    const batch = strategies.slice(i, i + batchSize)

    const results = await Promise.allSettled(
      batch.map(async (strategy) => {
        const result = await searchGrants(strategy.query, { rows: rowsPerQuery })
        return { strategy, result }
      }),
    )

    for (const settled of results) {
      if (settled.status !== 'fulfilled') continue
      const { strategy, result } = settled.value

      perStrategy[strategy.label] = {
        query: strategy.query,
        count: result.opportunities.length,
        ok: result.ok,
      }

      for (const opp of result.opportunities) {
        const key = (opp.title || '').toLowerCase().trim()
        if (key && seenTitles.has(key)) continue
        if (key) seenTitles.add(key)
        allOpportunities.push({ ...opp, _discovery_strategy: strategy.label })
      }
    }

    // Delay between batches
    if (i + batchSize < strategies.length) {
      await new Promise((r) => setTimeout(r, batchDelayMs))
    }
  }

  console.log(
    `[GrantsGovClient] Batch search: ${strategies.length} strategies → ${allOpportunities.length} unique opportunities`,
  )

  return {
    opportunities: allOpportunities,
    diagnostics: { strategy_count: strategies.length, per_strategy: perStrategy },
  }
}

export { GRANTS_GOV_DETAIL }
export default { searchGrants, searchGrantsBatch, GRANTS_GOV_DETAIL }
