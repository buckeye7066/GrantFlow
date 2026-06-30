/**
 * yana/webSearchProvider.js
 *
 * Live-web search + fetch providers (Brave Search) that supply the two
 * dependencies yanaContactEnrichment.makeContactEnricher() needs to turn a
 * `needs_enrichment` prospect into a reachable `qualified` lead:
 *
 *   - searchProvider({ query }) => [{ url, title, snippet }]   (find the homepage)
 *   - fetcher(url)             => string HTML                  (read it for an email)
 *
 * Why Brave: a genuinely free tier (~2k queries/mo) and an independent index,
 * so an unattended discovery loop doesn't depend on scraping Google under shaky
 * terms. The free tier is rate-limited to ~1 request/second, so the search
 * provider SERIALIZES calls with a minimum spacing — the enricher can fan out
 * under bounded concurrency without tripping 429s.
 *
 * Activated only when BRAVE_SEARCH_API_KEY is set AND YANA_ALLOW_LIVE_WEB=true
 * (wired in server.js). No key → never constructed → enrichment stays a NOOP and
 * prospects sit honestly at `needs_enrichment`.
 */

import { createLogger } from '../../utils/logger.js'
import { isBravePaused, noteBrave429, noteBraveSuccess, braveCircuitState } from './braveRateLimit.js'

const log = createLogger('yanaWebSearch')

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

/**
 * Serialize async calls so consecutive invocations are spaced >= minIntervalMs.
 * Each queued caller runs after the previous settles AND the spacing elapses,
 * keeping us under Brave's free-tier ~1 req/s cap even when the enricher fans
 * out with concurrency.
 */
function makeThrottle(minIntervalMs) {
  let chain = Promise.resolve()
  let last = 0
  return (fn) => {
    const run = chain.then(async () => {
      const wait = Math.max(0, last + minIntervalMs - Date.now())
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      last = Date.now()
      return fn()
    })
    // Keep the chain alive but never let a rejection break future callers.
    chain = run.catch(() => {})
    return run
  }
}

export function makeBraveSearchProvider({
  apiKey = process.env.BRAVE_SEARCH_API_KEY,
  fetchImpl = (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null),
  minIntervalMs = 1100,
  count = 5,
} = {}) {
  if (!apiKey) throw new Error('makeBraveSearchProvider: BRAVE_SEARCH_API_KEY is required')
  if (typeof fetchImpl !== 'function') throw new Error('makeBraveSearchProvider: no fetch implementation available')
  const throttle = makeThrottle(minIntervalMs)

  return async function search({ query } = {}) {
    const q = String(query || '').trim()
    if (!q) return []
    // Circuit breaker: if the key is rate-limited/quota-exhausted, skip the call
    // entirely (no network, no throttle wait) until it refills. This is what
    // makes Yana PAUSE her live-web work instead of firing doomed requests.
    if (isBravePaused()) {
      const s = braveCircuitState()
      log.info(`Brave paused (${s.reason}) — skipping "${q}"; resumes in ~${s.resumes_in_minutes} min`)
      return []
    }
    return throttle(async () => {
      // Re-check inside the serialized chain: an earlier queued call may have
      // tripped the breaker while this one waited its turn.
      if (isBravePaused()) return []
      const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(q)}&count=${count}`
      let res
      try {
        res = await fetchImpl(url, {
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': apiKey,
          },
        })
      } catch (err) {
        log.warn(`Brave search request failed for "${q}": ${err?.message || err}`)
        return []
      }
      if (res.status === 429) {
        // Classify the 429 (transient per-second vs. monthly quota gone) from the
        // rate-limit headers and pause Brave for the right duration.
        const kind = noteBrave429({ headers: res.headers })
        if (kind === 'quota_exhausted' || kind === 'sustained') {
          const s = braveCircuitState()
          log.warn(`Brave ${kind} for "${q}" — pausing Brave until ${s.resumes_at}`)
        } else {
          log.warn(`Brave rate-limited (429) for "${q}" — transient backoff`)
        }
        return []
      }
      if (!res.ok) {
        log.warn(`Brave search returned ${res.status} for "${q}"`)
        return []
      }
      let json
      try { json = await res.json() } catch { return [] }
      noteBraveSuccess()
      const results = json?.web?.results || []
      return results
        .map((r) => ({ url: r?.url || '', title: r?.title || '', snippet: r?.description || '' }))
        .filter((r) => r.url)
    })
  }
}

/**
 * Minimal, defensive HTML fetcher for reading a prospect's homepage. Times out,
 * caps the body size, sets a UA, and returns '' on ANY failure — the enricher
 * treats no-HTML as "no email found", never an error.
 */
export function makeHtmlFetcher({
  fetchImpl = (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null),
  timeoutMs = 8000,
  maxBytes = 600_000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('makeHtmlFetcher: no fetch implementation available')
  return async function fetcher(targetUrl) {
    const url = String(targetUrl || '')
    if (!/^https?:\/\//i.test(url)) return ''
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'GrantFlowYanaBot/1.0 (+https://grantflow.app; nonprofit contact discovery)',
          Accept: 'text/html,application/xhtml+xml',
        },
      })
      if (!res.ok) return ''
      const ct = res.headers.get('content-type') || ''
      if (ct && !/text\/html|xml|text\/plain/i.test(ct)) return ''
      const buf = await res.arrayBuffer()
      return Buffer.from(buf).subarray(0, maxBytes).toString('utf8')
    } catch (err) {
      if (err?.name !== 'AbortError') log.warn(`HTML fetch failed for ${url}: ${err?.message || err}`)
      return ''
    } finally {
      clearTimeout(timer)
    }
  }
}
