/**
 * Self-hosted SearXNG search provider — GrantFlow's "own Brave".
 *
 * Why this exists:
 *   The shared web-search engine (webSearchEngine.js) needs a server-side web
 *   backend that (a) costs nothing per query, (b) works from a datacenter IP
 *   (Railway), and (c) returns result URLs + titles + snippets for local /
 *   non-federal funding discovery (county scholarships, city foundations).
 *
 *   Brave's API is reliable but the owner's key is capped ($5/mo, returns HTTP
 *   402 USAGE_LIMIT_EXCEEDED) and gets expensive fast. Keyless DuckDuckGo HTML
 *   scraping is DEAD from cloud IPs (html/lite.duckduckgo.com answer datacenter
 *   IPs with an HTTP 202 anti-bot challenge — zero results in prod).
 *
 *   SearXNG is a self-hosted metasearch engine: it aggregates Google/Bing/etc.
 *   results server-side and exposes them as JSON (`&format=json`). We run ONE
 *   instance as a Railway service, point SEARXNG_URL at it, and get unlimited,
 *   key-free, datacenter-reliable web search. See docs/SEARXNG_SELF_HOST.md for
 *   the deploy runbook.
 *
 * Contract: returns normalized `[{ url, title, snippet }]`. Failure-tolerant
 * (any error / non-OK / unparseable body → []) and time-bounded, so callers
 * never have to guard the call. Mirrors makeBraveSearchProvider's shape so it
 * drops into the same provider chain.
 */

import { getWithRetry } from './httpClient.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:searxngProvider')

// ── Global pacer ────────────────────────────────────────────────────────────
// The nightly discovery fan-out (50 Amy synthetics × 6-8 queries, plus the
// parity benchmark) fired back-to-back queries at the instance, whose upstream
// engines then rate-limited/CAPTCHA'd US: on 2026-07-28 brave + google-cse sat
// "Suspended: too many requests" and startpage/qwant "Suspended: CAPTCHA",
// leaving bing-only junk SERPs for the rest of the night (the
// institution_recall_miss ×6 / parity-23.6 root cause). A minimum gap between
// SearXNG calls keeps the upstream engines under their limits. Shared across
// every provider instance in the process; disabled in the unit-test runner and
// tunable via SEARXNG_MIN_INTERVAL_MS (0 disables).
let _pacerChain = Promise.resolve()
let _lastCallAt = 0
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function paceMinIntervalMs() {
  if (process.env.GRANTFLOW_TEST_RUNNER === '1') return 0
  const raw = Number(process.env.SEARXNG_MIN_INTERVAL_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 750
}

function pacedTurn() {
  const minInterval = paceMinIntervalMs()
  if (!minInterval) return Promise.resolve()
  const turn = _pacerChain.then(async () => {
    const wait = _lastCallAt + minInterval - Date.now()
    if (wait > 0) await _sleep(wait)
    _lastCallAt = Date.now()
  })
  // Chain never rejects (the body only sleeps), so no catch needed.
  _pacerChain = turn
  return turn
}

/**
 * Normalize a configured base URL into the SearXNG `/search` JSON endpoint.
 * Accepts `https://host`, `https://host/`, or `https://host/search`.
 */
function toSearchEndpoint(base) {
  const trimmed = String(base || '').trim().replace(/\/+$/, '')
  if (!trimmed) return null
  if (/\/search$/i.test(trimmed)) return trimmed
  return `${trimmed}/search`
}

/**
 * Build a SearXNG search provider.
 *
 * @param {Object} [opts]
 * @param {string} [opts.baseUrl=process.env.SEARXNG_URL] Base URL of the SearXNG instance.
 * @param {number} [opts.count=8]      Max results to request/return.
 * @param {number} [opts.timeoutMs=8000] Per-query network budget.
 * @param {string} [opts.engines]      Optional comma-separated engine allowlist (SEARXNG_ENGINES).
 * @param {string} [opts.language='en'] Result language hint.
 * @returns {(args:{query:string,count?:number,timeoutMs?:number,engines?:string}) => Promise<Array<{url,title,snippet}>>}
 * @throws if no baseUrl is configured (so the engine can skip-construct like Brave).
 */
export function makeSearxngProvider({
  baseUrl = process.env.SEARXNG_URL,
  count = 8,
  timeoutMs = 8000,
  engines = process.env.SEARXNG_ENGINES || '',
  language = 'en',
} = {}) {
  const endpoint = toSearchEndpoint(baseUrl)
  if (!endpoint) throw new Error('makeSearxngProvider: SEARXNG_URL is required')

  // `engines` is per-call overridable: when the DEFAULT engine set degrades to
  // junk (the 2026-07-27 first-word-SERP collapse — every scraping engine
  // suspended except a broken bing), the caller retries the SAME instance with
  // a known-good allowlist instead of abandoning SearXNG entirely.
  return async function search({ query, count: countOverride, timeoutMs: timeoutOverride, engines: enginesOverride } = {}) {
    const q = String(query || '').trim()
    if (!q) return []
    const want = Math.max(1, Number(countOverride) || count)
    const budget = Math.max(1000, Number(timeoutOverride) || timeoutMs)
    const effEngines = enginesOverride !== undefined ? String(enginesOverride) : engines

    const params = new URLSearchParams({
      q,
      format: 'json',
      language,
      safesearch: '0',
    })
    if (effEngines) params.set('engines', effEngines)
    const url = `${endpoint}?${params.toString()}`

    await pacedTurn()

    let response
    try {
      response = await getWithRetry(
        url,
        { headers: { Accept: 'application/json' } },
        { timeoutMs: budget, retries: 1 },
      )
    } catch (err) {
      log.warn(`[searxngProvider] request failed for "${q}": ${err?.message ?? err}`)
      return []
    }

    const status = Number(response?.status)
    if (status && status !== 200) {
      log.warn(`[searxngProvider] HTTP ${status} for "${q}" (check SearXNG instance / JSON format enabled)`)
      return []
    }

    // getWithRetry returns parsed JSON for application/json; tolerate a string body too.
    let json = response?.data
    if (typeof json === 'string') {
      try { json = JSON.parse(json) } catch { return [] }
    }
    const results = Array.isArray(json?.results) ? json.results : []
    const out = []
    const seen = new Set()
    const resultEngines = new Set()
    for (const r of results) {
      for (const e of Array.isArray(r?.engines) ? r.engines : []) resultEngines.add(String(e))
      if (out.length >= want) continue
      const u = String(r?.url || '').trim()
      if (!/^https?:\/\//i.test(u)) continue
      const key = u.toLowerCase().replace(/\/$/, '')
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        url: u,
        title: String(r?.title || '').trim(),
        snippet: String(r?.content || r?.snippet || '').trim(),
      })
    }
    // Engine-health telemetry rides along as a NON-ENUMERABLE property so the
    // `[{url,title,snippet}]` contract (and any deep-equality test on it) is
    // untouched. webSearchEngine reads it to detect engine-fleet collapse
    // (bing-only SERPs while the rest of the fleet sits suspended).
    const unresponsive = []
    for (const entry of Array.isArray(json?.unresponsive_engines) ? json.unresponsive_engines : []) {
      if (Array.isArray(entry)) unresponsive.push({ engine: String(entry[0] ?? ''), reason: String(entry[1] ?? '') })
      else if (entry) unresponsive.push({ engine: String(entry), reason: '' })
    }
    Object.defineProperty(out, 'searxngMeta', {
      value: { result_engines: [...resultEngines].sort(), unresponsive_engines: unresponsive },
      enumerable: false,
    })
    return out
  }
}

export default { makeSearxngProvider }
