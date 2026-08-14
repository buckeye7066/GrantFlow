/**
 * Google Programmable Search (Custom Search JSON API) provider — the "basic
 * google search" rung (owner directive 2026-08-04: profiles must at least get
 * Google-parity results while the deeper crawler work lands).
 *
 * Sits ABOVE SearXNG in webSearchEngine's ladder: the official API, from a
 * datacenter IP, no scraping, no engine-fleet collapse mode. The trade is a
 * hard DAILY quota (100/day free tier; paid $5/1000 up to 10k/day), so every
 * call is budget-gated by googleBudget.js and a quota refusal degrades the
 * rung until the next UTC midnight — the rest of the ladder is unchanged, so
 * an unconfigured or exhausted Google key costs nothing and hides nothing.
 *
 * Contract mirrors makeSearxngProvider / makeBraveSearchProvider: returns
 * normalized `[{ url, title, snippet }]`; construction throws without config;
 * a QUOTA refusal throws an error with `code: 'google_quota'` (the ladder's
 * degrade signal); any other failure returns [] (failure-tolerant).
 *
 * Env: GOOGLE_CSE_KEY (API key), GOOGLE_CSE_CX (a Programmable Search Engine
 * id configured to search the entire web).
 */

import { getWithRetry } from './httpClient.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:googleCseProvider')

const ENDPOINT = 'https://www.googleapis.com/customsearch/v1'

export function makeGoogleCseProvider({ count = 8 } = {}) {
  const key = String(process.env.GOOGLE_CSE_KEY || '').trim()
  const cx = String(process.env.GOOGLE_CSE_CX || '').trim()
  if (!key || !cx) {
    throw new Error('GOOGLE_CSE_KEY and GOOGLE_CSE_CX are required for the Google CSE provider')
  }

  return async function googleCseSearch({ query, count: perCall, timeoutMs = 8000 } = {}) {
    const q = String(query || '').trim()
    if (!q) return []
    // The API caps num at 10.
    const num = Math.max(1, Math.min(10, Number(perCall ?? count) || 8))
    const url =
      `${ENDPOINT}?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}` +
      `&q=${encodeURIComponent(q)}&num=${num}`

    let response
    try {
      // retries:0 — a quota refusal is a stable fact for the rest of the UTC
      // day, and a transient 5xx just falls through to SearXNG; retrying here
      // only spends latency the ladder will spend better on the next rung.
      response = await getWithRetry(url, { headers: { Accept: 'application/json' } }, { timeoutMs, retries: 0 })
    } catch (err) {
      // `getWithRetry` RETURNS only 2xx — every other status is thrown as an
      // Error carrying `.status` + `.response` (httpClient.requestWithRetry).
      // A quota refusal is therefore a THROW, not a resolved 403, so reading
      // the status only off a resolved response made the `google_quota`
      // degrade signal below unreachable: the ladder never learned the rung
      // was dead and re-paid the budget + the API call on every query for the
      // rest of the UTC day. Re-adopt the carried response so the status
      // branches decide; a real transport failure (no response) still returns [].
      if (err?.response && Number.isFinite(Number(err.status ?? err.response.status))) {
        response = err.response
      } else {
        log.warn(`[googleCseProvider] request failed for "${q}": ${err?.message ?? err}`)
        return []
      }
    }

    const status = Number(response?.status)
    if (status === 403 || status === 429) {
      // Daily quota exhausted (dailyLimitExceeded / rateLimitExceeded) or the
      // key is refused. Either way this rung is dead until the UTC reset —
      // signal the ladder so it stops paying the call.
      const detail = (() => {
        try {
          const body = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
          return body?.error?.errors?.[0]?.reason || body?.error?.status || `http_${status}`
        } catch { return `http_${status}` }
      })()
      const err = new Error(`Google CSE quota/authorization refusal (${detail})`)
      err.code = 'google_quota'
      err.status = status
      throw err
    }
    if (status !== 200) {
      log.warn(`[googleCseProvider] HTTP ${status} for "${q}"`)
      return []
    }

    let body = response.data
    if (typeof body === 'string') {
      try { body = JSON.parse(body) } catch { return [] }
    }
    const items = Array.isArray(body?.items) ? body.items : []
    const out = []
    const seen = new Set()
    for (const item of items) {
      const link = String(item?.link || '').trim()
      if (!/^https?:\/\//i.test(link)) continue
      const dedupeKey = link.toLowerCase().replace(/\/$/, '')
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      out.push({
        url: link,
        title: String(item?.title || '').trim(),
        snippet: String(item?.snippet || '').trim(),
      })
      if (out.length >= num) break
    }
    return out
  }
}

export default { makeGoogleCseProvider }
