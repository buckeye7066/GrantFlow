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

import { postWithRetry } from './httpClient.js'

// ── Endpoints ──────────────────────────────────────────────────────────────────
const LEGACY_API = 'https://api.grants.gov/v1/api/search2'
const SIMPLER_API = 'https://api.simpler.grants.gov/v1/opportunities/search'
const GRANTS_GOV_DETAIL = 'https://www.grants.gov/search-results-detail/'

// ── Timeouts & limits ─────────────────────────────────────────────────────────
const API_TIMEOUT_MS = 20_000
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
  const alnList = Array.isArray(hit.alnList) ? hit.alnList.join(', ') : ''

  const description = synopsis || [
    `Federal grant opportunity: ${title}.`,
    agency ? `Funded by ${agency}.` : '',
    number ? `Opportunity number ${number}.` : '',
    alnList ? `ALN: ${alnList}.` : '',
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
      return { ok: false, hits: [], error: 'unparseable_response', raw_snippet: String(response?.data ?? '').slice(0, 300) }
    }

    // The grants.gov API wraps results in various structures — try them all
    const hits =
      parsed?.data?.oppHits ??
      parsed?.oppHits ??
      parsed?.data?.opportunities ??
      parsed?.opportunities ??
      parsed?.data?.results ??
      parsed?.results ??
      []

    const resultRows = Array.isArray(hits) ? hits : []

    // Diagnostic: log response structure when 0 results
    if (resultRows.length === 0) {
      const topKeys = Object.keys(parsed).slice(0, 8).join(', ')
      const errorCode = parsed?.errorcode ?? parsed?.errorCode ?? parsed?.error_code ?? 'none'
      const msg = parsed?.msg ?? parsed?.message ?? parsed?.error ?? ''
      const dataKeys = parsed?.data && typeof parsed.data === 'object'
        ? Object.keys(parsed.data).slice(0, 8).join(', ')
        : 'N/A'
      const hitCount = parsed?.data?.hitCount ?? parsed?.hitCount ?? 'N/A'
      console.warn(
        `[GrantsGovClient] Legacy 0 hits for "${keyword}" | err=${errorCode} msg="${msg}" keys=[${topKeys}] data_keys=[${dataKeys}] hitCount=${hitCount}`,
      )
      // If hitCount > 0 but oppHits is empty, there's a parsing problem
      if (typeof hitCount === 'number' && hitCount > 0) {
        console.error(`[GrantsGovClient] PARSING BUG: hitCount=${hitCount} but extracted 0 hits!`)
        const sample = JSON.stringify(parsed?.data ?? parsed).slice(0, 500)
        console.error(`[GrantsGovClient] Raw data sample: ${sample}`)
      }
    } else {
      console.log(`[GrantsGovClient] Legacy "${keyword}" → ${resultRows.length} hits`)
    }

    const normalised = resultRows.map(normaliseLegacyHit).filter(Boolean)

    return {
      ok: true,
      hits: normalised,
      raw_count: resultRows.length,
      hit_count: parsed?.data?.hitCount ?? parsed?.hitCount ?? null,
    }
  } catch (err) {
    const code = err?.code || err?.response?.status || ''
    const msg = err?.message || String(err)
    console.error(`[GrantsGovClient] Legacy API FAILED for "${keyword}": ${code} ${msg}`)
    return { ok: false, hits: [], error: `${code} ${msg}`.trim() }
  }
}

// ── Simpler.Grants.gov API (POST with JSON body) ─────────────────────────────

async function querySimplerAPI(keyword, rows = MAX_ROWS_PER_QUERY) {
  // Simpler.Grants.gov API uses POST with a structured JSON body
  const body = {
    query: keyword,
    filters: {
      opportunity_status: {
        one_of: ['posted', 'forecasted'],
      },
    },
    pagination: {
      page_size: Math.min(rows, MAX_ROWS_PER_QUERY),
      page_offset: 1,
      order_by: 'relevancy',
      sort_direction: 'descending',
    },
  }

  try {
    const response = await postWithRetry(
      SIMPLER_API,
      body,
      { headers: { 'Content-Type': 'application/json' } },
      { timeoutMs: API_TIMEOUT_MS, retries: API_RETRIES },
    )

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
    const resultRows = Array.isArray(hits) ? hits : []

    if (resultRows.length === 0) {
      const topKeys = Object.keys(parsed).slice(0, 8).join(', ')
      const pagination = parsed?.pagination_info ?? parsed?.pagination ?? parsed?.meta ?? null
      const total = pagination?.total_records ?? pagination?.total ?? parsed?.total ?? 'N/A'
      const msg = parsed?.message ?? parsed?.error ?? ''
      console.warn(
        `[GrantsGovClient] Simpler 0 hits for "${keyword}" | total=${total} msg="${msg}" keys=[${topKeys}]`,
      )
    } else {
      console.log(`[GrantsGovClient] Simpler "${keyword}" → ${resultRows.length} hits`)
    }

    const normalised = resultRows.map(normaliseSimplerHit).filter(Boolean)

    return {
      ok: true,
      hits: normalised,
      raw_count: resultRows.length,
    }
  } catch (err) {
    const code = err?.code || err?.response?.status || ''
    const msg = err?.message || String(err)
    // Don't log as error if it's just a 404/405 (endpoint might not exist yet)
    if (code === 404 || code === 405 || code === '404' || code === '405') {
      console.warn(`[GrantsGovClient] Simpler API not available (${code}) for "${keyword}"`)
    } else {
      console.error(`[GrantsGovClient] Simpler API FAILED for "${keyword}": ${code} ${msg}`)
    }
    return { ok: false, hits: [], error: `${code} ${msg}`.trim() }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Search for grant opportunities using both Grants.gov APIs.
 * Deduplicates by title (case-insensitive).
 */
export async function searchGrants(keyword, opts = {}) {
  const { rows = MAX_ROWS_PER_QUERY, legacyOnly = false, simplerOnly = false } = opts
  const diagnostics = { legacy: null, simpler: null, merged: 0 }

  const [legacyResult, simplerResult] = await Promise.all([
    simplerOnly ? Promise.resolve({ ok: false, hits: [], error: 'skipped' }) : queryLegacyAPI(keyword, rows),
    legacyOnly ? Promise.resolve({ ok: false, hits: [], error: 'skipped' }) : querySimplerAPI(keyword, rows),
  ])

  diagnostics.legacy = {
    ok: legacyResult.ok, count: legacyResult.hits.length,
    raw_count: legacyResult.raw_count ?? 0, hit_count: legacyResult.hit_count ?? null,
    error: legacyResult.error ?? null,
  }
  diagnostics.simpler = {
    ok: simplerResult.ok, count: simplerResult.hits.length,
    raw_count: simplerResult.raw_count ?? 0, error: simplerResult.error ?? null,
  }

  // Merge and deduplicate
  const seen = new Set()
  const merged = []
  for (const opp of [...legacyResult.hits, ...simplerResult.hits]) {
    const key = (opp.title || '').toLowerCase().trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push(opp)
  }
  diagnostics.merged = merged.length

  const anyOk = legacyResult.ok || simplerResult.ok
  if (!anyOk) {
    console.error(`[GrantsGovClient] BOTH APIs failed for "${keyword}" | legacy: ${legacyResult.error} | simpler: ${simplerResult.error}`)
  }

  return { ok: anyOk, opportunities: merged, diagnostics }
}

/**
 * Run multiple keyword searches in parallel (batched to avoid rate-limits).
 * Returns deduplicated results across ALL queries.
 */
export async function searchGrantsBatch(strategies, opts = {}) {
  const { batchSize = 3, batchDelayMs = 400, rowsPerQuery = MAX_ROWS_PER_QUERY } = opts

  const seenTitles = new Set()
  const allOpportunities = []
  const perStrategy = {}
  let legacyReachable = null
  let simplerReachable = null

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
        legacy_count: result.diagnostics?.legacy?.count ?? 0,
        simpler_count: result.diagnostics?.simpler?.count ?? 0,
      }

      if (result.diagnostics?.legacy?.ok != null) {
        legacyReachable = legacyReachable === null ? result.diagnostics.legacy.ok : (legacyReachable || result.diagnostics.legacy.ok)
      }
      if (result.diagnostics?.simpler?.ok != null) {
        simplerReachable = simplerReachable === null ? result.diagnostics.simpler.ok : (simplerReachable || result.diagnostics.simpler.ok)
      }

      for (const opp of result.opportunities) {
        const key = (opp.title || '').toLowerCase().trim()
        if (key && seenTitles.has(key)) continue
        if (key) seenTitles.add(key)
        allOpportunities.push({ ...opp, _discovery_strategy: strategy.label })
      }
    }

    if (i + batchSize < strategies.length) {
      await new Promise((r) => setTimeout(r, batchDelayMs))
    }
  }

  console.log(
    `[GrantsGovClient] Batch: ${strategies.length} strategies → ${allOpportunities.length} unique opps (legacy=${legacyReachable}, simpler=${simplerReachable})`,
  )

  return {
    opportunities: allOpportunities,
    diagnostics: {
      strategy_count: strategies.length,
      total_opportunities: allOpportunities.length,
      legacy_api_reachable: legacyReachable,
      simpler_api_reachable: simplerReachable,
      per_strategy: perStrategy,
    },
  }
}

/**
 * Quick connectivity test for health-check endpoints.
 */
export async function testConnectivity() {
  const checks = []

  const legacyStart = Date.now()
  try {
    const result = await queryLegacyAPI('health', 2)
    checks.push({
      source: 'Grants.gov Legacy (search2)', url: LEGACY_API,
      reachable: result.ok, latency_ms: Date.now() - legacyStart,
      hit_count: result.hit_count ?? result.raw_count ?? 0,
      returned: result.hits.length, error: result.error ?? null,
    })
  } catch (err) {
    checks.push({
      source: 'Grants.gov Legacy (search2)', url: LEGACY_API,
      reachable: false, latency_ms: Date.now() - legacyStart,
      hit_count: 0, returned: 0, error: err?.message || String(err),
    })
  }

  const simplerStart = Date.now()
  try {
    const result = await querySimplerAPI('health', 2)
    checks.push({
      source: 'Simpler.Grants.gov', url: SIMPLER_API,
      reachable: result.ok, latency_ms: Date.now() - simplerStart,
      hit_count: result.raw_count ?? 0,
      returned: result.hits.length, error: result.error ?? null,
    })
  } catch (err) {
    checks.push({
      source: 'Simpler.Grants.gov', url: SIMPLER_API,
      reachable: false, latency_ms: Date.now() - simplerStart,
      hit_count: 0, returned: 0, error: err?.message || String(err),
    })
  }

  return checks
}

export { GRANTS_GOV_DETAIL }
export default { searchGrants, searchGrantsBatch, testConnectivity, GRANTS_GOV_DETAIL }
