/**
 * Safe outbound HTTP egress.
 *
 * Every outbound request that targets a URL we did not hardcode ourselves
 * (crawled pages, ingested opportunity links, user-supplied portal URLs,
 * admin-configured data portals, OSM/feed-derived websites) MUST go through
 * this module rather than calling `fetch`/`http.request` directly.
 *
 * Why this exists as a chokepoint instead of a per-call-site check:
 *
 *   `assertSsrfSafeUrl(url)` on its own is NOT an SSRF fix when the caller then
 *   fetches with `redirect: 'follow'`. The guard clears the *first* URL only;
 *   an attacker-controlled host that answers `302 -> http://169.254.169.254/`
 *   walks straight past it, because the redirect is followed inside undici
 *   where our guard never runs. Closing that hole requires taking manual
 *   control of redirects and re-validating each hop, which is fiddly enough
 *   that it must live in exactly one place.
 *
 * Guarantees provided here:
 *   1. Scheme allowlist + private/loopback/link-local/metadata IP rejection
 *      on the initial URL (via assertSsrfSafeUrl, which also resolves DNS).
 *   2. Redirects are handled manually and EVERY hop is re-validated.
 *   3. Redirect chains are depth-capped (no infinite redirect loops).
 *   4. A hard request timeout via AbortSignal (native `fetch` has none).
 *   5. Optional response body size cap for callers that read the body.
 *
 * Residual risk (documented, not silently ignored): a DNS-rebinding attacker
 * can in principle return a public address to our `lookup()` and a private one
 * to the socket connect that follows. Eliminating that requires pinning the
 * resolved address at connect time via a custom agent/lookup. This module
 * closes the redirect and scheme classes of bypass; rebinding is tracked
 * separately and is a substantially harder attack to land.
 */

import { assertSsrfSafeUrl } from '../../config/urlRules.js'

export const DEFAULT_MAX_REDIRECTS = 5
export const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 // 2 MiB

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * Thrown when a request is refused before any packet leaves the process.
 * Callers that treat outbound failures as "site is down" should catch this
 * separately so a blocked-by-policy URL is never recorded as a dead link.
 */
export class SsrfBlockedError extends Error {
  constructor(reason, url) {
    super(`ssrf_blocked:${reason}`)
    this.name = 'SsrfBlockedError'
    this.reason = reason
    this.url = url
  }
}

/**
 * Validate a single URL, throwing SsrfBlockedError when it is not safe to hit.
 * @param {string} url
 * @returns {Promise<void>}
 */
export async function assertEgressAllowed(url) {
  const verdict = await assertSsrfSafeUrl(url)
  if (!verdict?.ok) {
    throw new SsrfBlockedError(verdict?.reason || 'unknown', url)
  }
}

/**
 * SSRF-safe `fetch` with manual, re-validated redirect handling.
 *
 * @param {string} url                     initial URL (untrusted)
 * @param {RequestInit} [init]             standard fetch init; `redirect` is ignored/forced
 * @param {Object}  [opts]
 * @param {number}  [opts.maxRedirects]    redirect hop cap (default 5)
 * @param {number}  [opts.timeoutMs]       total per-hop timeout (default 15s)
 * @param {AbortSignal} [opts.signal]      caller cancellation, merged with the timeout
 * @param {Function} [opts.fetchImpl]      fetch implementation (default: global fetch).
 *   Callers already standardized on `node-fetch` pass it here so they keep their
 *   existing Response semantics while still going through this guard — swapping
 *   a crawler's HTTP client as a side effect of a security fix is its own risk.
 * @returns {Promise<Response>}            the final non-redirect Response
 * @throws  {SsrfBlockedError}             when the URL or any redirect hop is blocked
 */
export async function safeFetch(url, init = {}, opts = {}) {
  const doFetch = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch
  const maxRedirects = Number.isFinite(opts.maxRedirects) ? opts.maxRedirects : DEFAULT_MAX_REDIRECTS
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS

  let currentUrl = String(url || '')
  const visited = []

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // Re-validated on EVERY hop, not just the first. This is the line that
    // makes redirect-based SSRF bypass impossible.
    await assertEgressAllowed(currentUrl)
    visited.push(currentUrl)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const signals = [controller.signal]
    if (opts.signal) signals.push(opts.signal)

    let res
    try {
      res = await doFetch(currentUrl, {
        ...init,
        // Forced: the whole point is that undici must not follow redirects for us.
        redirect: 'manual',
        signal: signals.length > 1 && typeof AbortSignal.any === 'function'
          ? AbortSignal.any(signals)
          : controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    if (!REDIRECT_STATUSES.has(res.status)) {
      // Surface where we actually ended up so callers can persist the final URL.
      try {
        Object.defineProperty(res, 'grantflowFinalUrl', { value: currentUrl, enumerable: false })
      } catch { /* non-fatal: response object frozen in some runtimes */ }
      return res
    }

    const location = res.headers?.get?.('location')
    if (!location) {
      // A 3xx with no Location is terminal; hand it back rather than looping.
      return res
    }

    // Resolve relative redirects ("/next") against the hop we just made.
    let nextUrl
    try {
      nextUrl = new URL(location, currentUrl).toString()
    } catch {
      throw new SsrfBlockedError('unparseable_redirect', location)
    }
    currentUrl = nextUrl
  }

  throw new SsrfBlockedError(`too_many_redirects:${visited.length}`, visited[0])
}

/**
 * Read a response body as text with a hard byte cap, so an attacker-controlled
 * host cannot exhaust memory by streaming an unbounded body at us.
 *
 * @param {Response} res
 * @param {number} [maxBytes]
 * @returns {Promise<string>}
 */
export async function readTextCapped(res, maxBytes = DEFAULT_MAX_BYTES) {
  if (!res?.body || typeof res.body.getReader !== 'function') {
    // Fallback for mocked/simple Response objects in tests.
    const text = typeof res?.text === 'function' ? await res.text() : ''
    return text.length > maxBytes ? text.slice(0, maxBytes) : text
  }

  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      chunks.push(value.slice(0, value.length - (total - maxBytes)))
      try { await reader.cancel() } catch { /* already closed */ }
      break
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
}

/**
 * Convenience wrapper: returns null instead of throwing when the URL is
 * blocked by policy. Use only where "we refused to look" and "we looked and
 * it failed" genuinely need the same handling.
 */
export async function safeFetchOrNull(url, init = {}, opts = {}) {
  try {
    return await safeFetch(url, init, opts)
  } catch (err) {
    if (err instanceof SsrfBlockedError) return null
    throw err
  }
}
