/**
 * Active search-provider health probe — the "crawler doctor" for the search
 * environment, runnable by the agents (Sam checks, Amy diagnostics) instead of
 * a human.
 *
 * WHY THIS EXISTS (2026-07-28): the two recurring crawler_reliability findings
 * in Anya's morning report — Amy's institution_recall_miss cohort misses and a
 * Google-bar web-parity regression — shared ONE environment root cause the
 * report could not see: the self-hosted SearXNG's engine fleet had collapsed
 * (brave/google-cse "Suspended: too many requests", startpage/qwant CAPTCHA)
 * leaving bing-only junk SERPs, while the Brave API fallback answered HTTP 402
 * (the $5/mo cap exhausts mid-month). The suggested fix said "crawler-doctor
 * (manual)" — a human probing by hand. This module IS that probe, so any agent
 * can attach the diagnosis to its own finding.
 *
 * Contract: probeSearchProviderHealth() never throws; returns a structured
 * verdict. Results are cached module-level (default 10 min) so several Sam
 * checks in one sweep share a single probe. In the unit-test runner the live
 * probe is disabled unless a fetch impl is injected (same convention as
 * webSearchEngine's isLiveSearchDisabledInTests).
 */

import { createLogger } from '../utils/logger.js'

const log = createLogger('service:searchProviderHealth')

// Two deliberately DIFFERENT multi-topic queries: a degraded instance answers
// generically; a healthy one answers each on-topic. Cheap (2 SearXNG calls +
// 1 single-result Brave call) and bounded.
const PROBE_QUERIES = [
  'wheelchair van grants tennessee mobility',
  'rural volunteer fire department equipment grants',
]

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000
const PROBE_TIMEOUT_MS = 12000

let _cache = null // { at, result }

/** Test seam. */
export function _resetSearchProviderHealthForTests() {
  _cache = null
}

function isLiveProbeDisabledInTests() {
  const explicitAllow = String(process.env.GRANTFLOW_ALLOW_LIVE_WEB_IN_TESTS || '').toLowerCase() === 'true'
  if (explicitAllow) return false
  return process.env.GRANTFLOW_TEST_RUNNER === '1'
}

function searxngSearchEndpoint(base) {
  const trimmed = String(base || '').trim().replace(/\/+$/, '')
  if (!trimmed) return null
  return /\/search$/i.test(trimmed) ? trimmed : `${trimmed}/search`
}

async function fetchJson(fetchImpl, url, { headers = {}, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetchImpl(url, { headers, signal: ctrl.signal })
    const status = Number(resp?.status) || 0
    let json = null
    try {
      json = await resp.json()
    } catch {
      json = null
    }
    return { status, json }
  } catch (err) {
    return { status: 0, json: null, error: String(err?.message || err) }
  } finally {
    clearTimeout(t)
  }
}

function summarizeSearxngResponse(json) {
  const results = Array.isArray(json?.results) ? json.results : []
  const engines = new Set()
  for (const r of results) {
    for (const e of Array.isArray(r?.engines) ? r.engines : []) engines.add(String(e))
  }
  const unresponsive = []
  for (const entry of Array.isArray(json?.unresponsive_engines) ? json.unresponsive_engines : []) {
    if (Array.isArray(entry)) unresponsive.push({ engine: String(entry[0] ?? ''), reason: String(entry[1] ?? '') })
    else if (entry) unresponsive.push({ engine: String(entry), reason: '' })
  }
  return { result_count: results.length, result_engines: [...engines].sort(), unresponsive_engines: unresponsive }
}

/**
 * Probe SearXNG (default engine set + the fallback allowlist) and the Brave
 * API. Never throws.
 *
 * @param {Object} [opts]
 * @param {Function} [opts.fetchImpl]  Injectable fetch (tests).
 * @param {number}  [opts.cacheTtlMs]  Cache TTL; 0 forces a fresh probe.
 * @param {Function} [opts.now]        Injectable clock (tests).
 * @returns {Promise<{probed_at:string,verdict:string,detail:string,searxng:Object,brave:Object,skipped?:boolean}>}
 */
export async function probeSearchProviderHealth({ fetchImpl = null, cacheTtlMs = DEFAULT_CACHE_TTL_MS, now = Date.now } = {}) {
  if (!fetchImpl && isLiveProbeDisabledInTests()) {
    return { skipped: true, verdict: 'unknown', detail: 'live probe disabled in test runner', probed_at: new Date(now()).toISOString(), searxng: null, brave: null }
  }
  const doFetch = fetchImpl || fetch
  if (_cache && cacheTtlMs > 0 && now() - _cache.at < cacheTtlMs) return _cache.result

  const searxngUrl = searxngSearchEndpoint(process.env.SEARXNG_URL)
  const braveKey = String(process.env.BRAVE_SEARCH_API_KEY || '').trim()
  if (!searxngUrl && !braveKey) {
    return { skipped: true, verdict: 'unconfigured', detail: 'no SEARXNG_URL and no BRAVE_SEARCH_API_KEY set', probed_at: new Date(now()).toISOString(), searxng: null, brave: null }
  }

  const result = {
    probed_at: new Date(now()).toISOString(),
    verdict: 'unknown',
    detail: '',
    searxng: null,
    brave: null,
  }

  // ── SearXNG: default engine set, one probe per query ──────────────────────
  if (searxngUrl) {
    const probes = []
    for (const q of PROBE_QUERIES) {
      const params = new URLSearchParams({ q, format: 'json', language: 'en', safesearch: '0' })
      const { status, json, error } = await fetchJson(doFetch, `${searxngUrl}?${params}`)
      probes.push({ query: q, status, error: error || null, ...(json ? summarizeSearxngResponse(json) : { result_count: 0, result_engines: [], unresponsive_engines: [] }) })
    }
    const reachable = probes.some((p) => p.status === 200)
    const anyResults = probes.some((p) => p.result_count > 0)
    const engineSet = new Set(probes.flatMap((p) => p.result_engines))
    const bingOnly = anyResults && engineSet.size > 0 && [...engineSet].every((e) => e === 'bing')
    const suspendedCore = [...new Map(probes.flatMap((p) => p.unresponsive_engines).map((u) => [u.engine, u])).values()]

    // The fallback allowlist rung (webSearchEngine 1b) — if the default set is
    // collapsed but these still answer, discovery quality survives.
    let fallback = null
    if (!anyResults || bingOnly) {
      const fallbackEngines = String(process.env.SEARXNG_FALLBACK_ENGINES ?? 'yandex,seznam,yahoo').trim()
      if (fallbackEngines) {
        const params = new URLSearchParams({ q: PROBE_QUERIES[0], format: 'json', language: 'en', safesearch: '0', engines: fallbackEngines })
        const { status, json, error } = await fetchJson(doFetch, `${searxngUrl}?${params}`)
        fallback = { engines: fallbackEngines, status, error: error || null, ...(json ? summarizeSearxngResponse(json) : { result_count: 0, result_engines: [], unresponsive_engines: [] }) }
      }
    }

    result.searxng = {
      reachable,
      any_results: anyResults,
      bing_only: bingOnly,
      active_engines: [...engineSet].sort(),
      suspended_engines: suspendedCore,
      probes,
      fallback,
    }
  }

  // ── Brave API: one cheapest-possible call; 402 = cap exhausted ───────────
  if (braveKey) {
    const { status, error } = await fetchJson(doFetch, 'https://api.search.brave.com/res/v1/web/search?q=test&count=1', {
      headers: { 'X-Subscription-Token': braveKey, Accept: 'application/json' },
    })
    result.brave = {
      ok: status === 200,
      status,
      error: error || null,
      note: status === 402 ? 'HTTP 402 — monthly cap exhausted (resets on the 1st) or billing lapsed' : status === 429 ? 'HTTP 429 — rate limited' : null,
    }
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  const sx = result.searxng
  const braveOk = result.brave?.ok === true
  const searxngHealthy = Boolean(sx?.any_results && !sx.bing_only)
  const searxngDegraded = Boolean(sx && sx.reachable && (sx.bing_only || (!sx.any_results && sx.fallback?.result_count > 0)))
  const searxngRescuedByFallback = Boolean(sx?.fallback && sx.fallback.result_count > 0)
  const searxngDead = Boolean(sx && !sx.any_results && !searxngRescuedByFallback)

  if (searxngHealthy || (!sx && braveOk)) {
    result.verdict = 'healthy'
    result.detail = sx
      ? `SearXNG healthy (engines answering: ${sx.active_engines.join(', ') || 'n/a'})${result.brave ? `; Brave ${braveOk ? 'ok' : `down (HTTP ${result.brave.status})`}` : ''}`
      : 'Brave API healthy (no SearXNG configured)'
  } else if (searxngDegraded && (searxngRescuedByFallback || braveOk)) {
    result.verdict = 'degraded'
    const suspended = (sx.suspended_engines || []).map((u) => `${u.engine} (${u.reason || 'unresponsive'})`).join(', ')
    result.detail = `SearXNG default engine set degraded${sx.bing_only ? ' to bing-only generic SERPs' : ''}${suspended ? ` — suspended: ${suspended}` : ''}; ` +
      (searxngRescuedByFallback
        ? `fallback engines (${sx.fallback.engines}) still answering (${sx.fallback.result_count} results)`
        : 'no fallback engines answering') +
      (result.brave ? `; Brave ${braveOk ? 'ok' : `DOWN (HTTP ${result.brave.status}${result.brave.note ? ` — ${result.brave.note}` : ''})`}` : '')
  } else if ((searxngDead || !sx) && !braveOk) {
    result.verdict = 'down'
    result.detail = `${sx ? (sx.reachable ? 'SearXNG reachable but NO engine returns results (default + fallback both empty)' : 'SearXNG unreachable') : 'no SearXNG configured'}` +
      `${result.brave ? `; Brave DOWN (HTTP ${result.brave.status}${result.brave.note ? ` — ${result.brave.note}` : ''})` : '; no Brave key'}`
  } else {
    result.verdict = 'degraded'
    result.detail = `partial search capability — SearXNG ${sx ? (sx.any_results ? `answering via ${sx.active_engines.join(', ')}` : 'empty') : 'not configured'}; Brave ${result.brave ? (braveOk ? 'ok' : `down (HTTP ${result.brave.status})`) : 'not configured'}`
  }

  log.info(`[searchProviderHealth] verdict=${result.verdict}: ${result.detail}`)
  _cache = { at: now(), result }
  return result
}

export default { probeSearchProviderHealth, _resetSearchProviderHealthForTests }
