/**
 * Safe outbound HTTP egress.
 *
 * Every outbound request that targets a URL we did not hardcode ourselves
 * (crawled pages, ingested opportunity links, user-supplied portal URLs,
 * admin-configured data portals, OSM/feed-derived websites) MUST go through
 * this module rather than calling `fetch`/`http.request` directly.
 *
 * Guarantees provided here:
 *   1. Scheme allowlist + private/loopback/link-local/metadata IP rejection.
 *   2. The DNS address approved by policy is pinned to the socket connection,
 *      closing validate-then-re-resolve (DNS rebinding) gaps.
 *   3. Redirects are handled manually and every hop is re-resolved, validated,
 *      and pinned independently.
 *   4. Redirect chains are depth-capped and discarded bodies are released.
 *   5. Caller cancellation and a hard timeout are both preserved.
 *   6. Optional response body size caps work for Web and Node streams.
 */

import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import nodeFetch from 'node-fetch'
import { isPrivateIp, SSRF_BLOCKED_HOSTS } from '../../config/urlRules.js'

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

async function defaultResolve(host) {
  const family = net.isIP(host)
  if (family) return [{ address: host, family }]
  return dns.lookup(host, { all: true, verbatim: true })
}

function normalizeResolution(records) {
  const values = Array.isArray(records) ? records : [records]
  return values
    .map((record) => {
      if (typeof record === 'string') {
        return { address: record, family: net.isIP(record) }
      }
      const address = String(record?.address || '')
      return {
        address,
        family: Number(record?.family) || net.isIP(address),
      }
    })
    .filter((record) => record.address && (record.family === 4 || record.family === 6))
}

/**
 * Validate and resolve a single URL. The returned address is the exact address
 * that must be used for the socket connection; callers must not resolve again.
 *
 * @param {string} url
 * @param {Object} [opts]
 * @param {Function} [opts.resolve] testable DNS resolver
 * @returns {Promise<{ url: string, host: string, address: string, family: 4|6 }>}
 */
export async function assertEgressAllowed(url, opts = {}) {
  if (!url || typeof url !== 'string') {
    throw new SsrfBlockedError('empty_url', url)
  }

  let parsed
  try {
    parsed = new URL(url.trim())
  } catch {
    throw new SsrfBlockedError('unparseable_url', url)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(`blocked_scheme:${parsed.protocol}`, url)
  }
  if (parsed.username || parsed.password) {
    throw new SsrfBlockedError('embedded_credentials', url)
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (SSRF_BLOCKED_HOSTS.has(host)) {
    throw new SsrfBlockedError(`blocked_host:${host}`, url)
  }

  const resolve = typeof opts.resolve === 'function' ? opts.resolve : defaultResolve
  let records
  try {
    records = normalizeResolution(await resolve(host))
  } catch (err) {
    throw new SsrfBlockedError(`dns_error:${err?.code || err?.message || 'unknown'}`, url)
  }

  if (records.length === 0) {
    throw new SsrfBlockedError('dns_no_records', url)
  }

  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new SsrfBlockedError(`resolves_private:${record.address}`, url)
    }
  }

  const selected = records[0]
  return {
    url: parsed.toString(),
    host,
    address: selected.address,
    family: selected.family,
  }
}

function createPinnedAgent(targetUrl, resolved) {
  const parsed = new URL(targetUrl)
  const Agent = parsed.protocol === 'https:' ? https.Agent : http.Agent
  const lookup = (_hostname, options, callback) => {
    if (options?.all) {
      callback(null, [{ address: resolved.address, family: resolved.family }])
      return
    }
    callback(null, resolved.address, resolved.family)
  }

  return new Agent({
    keepAlive: false,
    lookup,
    ...(parsed.protocol === 'https:' ? { servername: resolved.host } : {}),
  })
}

/**
 * Merge cancellation signals without losing caller cancellation on runtimes
 * that do not expose AbortSignal.any(). The optional anyImpl exists so the
 * fallback can be tested deterministically.
 */
export function mergeAbortSignals(signals, anyImpl = AbortSignal.any?.bind(AbortSignal)) {
  const active = signals.filter(Boolean)
  if (active.length === 0) return { signal: undefined, cleanup: () => {} }
  if (active.length === 1) return { signal: active[0], cleanup: () => {} }
  if (typeof anyImpl === 'function') {
    return { signal: anyImpl(active), cleanup: () => {} }
  }

  const controller = new AbortController()
  const listeners = []
  const abortFrom = (source) => {
    if (!controller.signal.aborted) controller.abort(source.reason)
  }

  for (const source of active) {
    if (source.aborted) {
      abortFrom(source)
      break
    }
    const listener = () => abortFrom(source)
    source.addEventListener('abort', listener, { once: true })
    listeners.push([source, listener])
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const [source, listener] of listeners) {
        source.removeEventListener('abort', listener)
      }
    },
  }
}

function createRequestLifetime(timeoutMs, signals) {
  const timeoutController = new AbortController()
  const timer = setTimeout(
    () => timeoutController.abort(new Error(`safeFetch timeout after ${timeoutMs}ms`)),
    timeoutMs,
  )
  if (typeof timer.unref === 'function') timer.unref()

  const merged = mergeAbortSignals([...signals, timeoutController.signal])
  let released = false
  return {
    signal: merged.signal,
    release: () => {
      if (released) return
      released = true
      clearTimeout(timer)
      merged.cleanup()
    },
  }
}

function releaseWhenBodyFinishes(res, release) {
  const body = res?.body
  if (!body) {
    release()
    return
  }
  if (typeof body.once === 'function') {
    body.once('end', release)
    body.once('close', release)
    body.once('error', release)
    return
  }
  // Production uses node-fetch, whose body is a Node stream. Hermetic test
  // Response objects may expose only a Web stream, so do not leave their timers
  // alive merely because that mock stream has no completion events.
  release()
}

/** Release a response body that the caller intentionally will not consume. */
export async function discardResponseBody(res) {
  const body = res?.body
  if (!body) return

  try {
    if (typeof body.dump === 'function') {
      await body.dump()
      return
    }
    if (typeof body.cancel === 'function') {
      await body.cancel()
      return
    }
    if (typeof body.destroy === 'function') {
      body.destroy()
      return
    }
    if (typeof body.resume === 'function') body.resume()
  } catch {
    // The connection may already be closed or the body may already be locked.
  }
}

/**
 * SSRF-safe fetch with DNS pinning and manual redirect handling.
 *
 * Production traffic uses node-fetch because its Agent hook lets this module
 * pin the validated address while preserving the original Host header and TLS
 * SNI. `opts.fetchImpl` is retained only for hermetic tests; production callers
 * must not inject a transport that ignores the supplied agent.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {Object} [opts]
 * @param {number} [opts.maxRedirects]
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.resolve]
 * @param {Function} [opts.fetchImpl] test-only fetch implementation
 * @returns {Promise<Response>}
 */
export async function safeFetch(url, init = {}, opts = {}) {
  const doFetch = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : nodeFetch
  const maxRedirects = Number.isFinite(opts.maxRedirects)
    ? Math.max(0, Math.trunc(opts.maxRedirects))
    : DEFAULT_MAX_REDIRECTS
  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? Math.max(1, Math.trunc(opts.timeoutMs))
    : DEFAULT_TIMEOUT_MS

  let currentUrl = String(url || '')
  const visited = []

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const resolved = await assertEgressAllowed(currentUrl, { resolve: opts.resolve })
    currentUrl = resolved.url
    visited.push(currentUrl)

    const lifetime = createRequestLifetime(timeoutMs, [init.signal, opts.signal])

    let res
    try {
      res = await doFetch(currentUrl, {
        ...init,
        redirect: 'manual',
        signal: lifetime.signal,
        agent: createPinnedAgent(currentUrl, resolved),
      })
    } catch (err) {
      lifetime.release()
      throw err
    }

    if (!REDIRECT_STATUSES.has(res.status)) {
      try {
        Object.defineProperty(res, 'grantflowFinalUrl', { value: currentUrl, enumerable: false })
      } catch {
        // Non-fatal: some Response implementations freeze the object.
      }
      releaseWhenBodyFinishes(res, lifetime.release)
      return res
    }

    const location = res.headers?.get?.('location')
    if (!location) {
      // A 3xx with no Location is terminal; the caller owns its body.
      releaseWhenBodyFinishes(res, lifetime.release)
      return res
    }

    let nextUrl
    try {
      nextUrl = new URL(location, currentUrl).toString()
    } catch {
      await discardResponseBody(res)
      lifetime.release()
      throw new SsrfBlockedError('unparseable_redirect', location)
    }

    await discardResponseBody(res)
    lifetime.release()
    if (hop >= maxRedirects) {
      throw new SsrfBlockedError(`too_many_redirects:${visited.length}`, visited[0])
    }
    currentUrl = nextUrl
  }

  throw new SsrfBlockedError(`too_many_redirects:${visited.length}`, visited[0])
}

/**
 * Read a response body as text with a hard byte cap.
 *
 * @param {Response|Object} res
 * @param {number} [maxBytes]
 * @returns {Promise<string>}
 */
export async function readTextCapped(res, maxBytes = DEFAULT_MAX_BYTES) {
  const cap = Number.isFinite(maxBytes) ? Math.max(0, Math.trunc(maxBytes)) : DEFAULT_MAX_BYTES
  const body = res?.body

  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const buffer = Buffer.from(value || [])
      const remaining = cap - total
      if (remaining <= 0) {
        try { await reader.cancel() } catch { /* already closed */ }
        break
      }
      if (buffer.length > remaining) {
        chunks.push(buffer.subarray(0, remaining))
        total += remaining
        try { await reader.cancel() } catch { /* already closed */ }
        break
      }
      chunks.push(buffer)
      total += buffer.length
    }
    return Buffer.concat(chunks, total).toString('utf8')
  }

  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = []
    let total = 0
    let capped = false
    try {
      for await (const value of body) {
        const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
        const remaining = cap - total
        if (remaining <= 0) {
          capped = true
          break
        }
        if (buffer.length > remaining) {
          chunks.push(buffer.subarray(0, remaining))
          total += remaining
          capped = true
          break
        }
        chunks.push(buffer)
        total += buffer.length
      }
    } finally {
      if (capped && typeof body.destroy === 'function') body.destroy()
    }
    return Buffer.concat(chunks, total).toString('utf8')
  }

  // Simple bodyless mocks are bounded after conversion. Real network responses
  // use one of the streaming branches above and never read an unbounded body.
  const text = typeof res?.text === 'function' ? await res.text() : ''
  return Buffer.from(String(text)).subarray(0, cap).toString('utf8')
}

/**
 * Convenience wrapper: returns null instead of throwing when the URL is
 * blocked by policy.
 */
export async function safeFetchOrNull(url, init = {}, opts = {}) {
  try {
    return await safeFetch(url, init, opts)
  } catch (err) {
    if (err instanceof SsrfBlockedError) return null
    throw err
  }
}
