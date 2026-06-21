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
 * @returns {(args:{query:string,count?:number,timeoutMs?:number}) => Promise<Array<{url,title,snippet}>>}
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

  return async function search({ query, count: countOverride, timeoutMs: timeoutOverride } = {}) {
    const q = String(query || '').trim()
    if (!q) return []
    const want = Math.max(1, Number(countOverride) || count)
    const budget = Math.max(1000, Number(timeoutOverride) || timeoutMs)

    const params = new URLSearchParams({
      q,
      format: 'json',
      language,
      safesearch: '0',
    })
    if (engines) params.set('engines', engines)
    const url = `${endpoint}?${params.toString()}`

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
    for (const r of results) {
      if (out.length >= want) break
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
    return out
  }
}

export default { makeSearxngProvider }
