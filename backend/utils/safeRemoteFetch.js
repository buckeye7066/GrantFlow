import dns from 'node:dns/promises'
import https from 'node:https'
import net from 'node:net'
import { isPrivateHost, isSafeUrl } from '../crawler-os/safeUrl.js'

const DEFAULT_MAX_BYTES = 256_000
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_REDIRECTS = 4
const ALLOWED_CONTENT_TYPES = [
  'text/html',
  'text/plain',
  'application/xhtml+xml',
  'application/json',
]

export function publicFetchFailureStatus(result = {}) {
  const reason = String(result?.reason || '')
  if (reason === 'response_too_large') return 413
  if (reason === 'unsupported_content_type') return 415
  if (reason === 'timeout') return 504
  if (reason === 'http_error') {
    const status = Number(result?.status)
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status
  }
  if (
    reason === 'empty' ||
    reason === 'unparseable' ||
    reason === 'private_host' ||
    reason === 'dns_resolves_private' ||
    reason === 'embedded_credentials' ||
    reason === 'https_required' ||
    reason === 'invalid_redirect_location' ||
    reason.startsWith('bad_protocol:')
  ) return 400
  return 502
}

async function defaultResolve(host) {
  const normalizedHost = String(host || '').replace(/^\[|\]$/g, '')
  if (net.isIP(normalizedHost)) return [normalizedHost]
  const records = await dns.lookup(normalizedHost, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

async function readLimitedText(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false, reason: 'response_too_large' }
  }

  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let bytes = 0
    let text = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value?.byteLength || 0
      if (bytes > maxBytes) {
        try {
          await reader.cancel()
        } catch (cancelError) {
          void cancelError
        }
        return { ok: false, reason: 'response_too_large' }
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return { ok: true, body: text }
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > maxBytes) return { ok: false, reason: 'response_too_large' }
  return { ok: true, body: buffer.toString('utf8') }
}

async function guardResolvedHost(host, resolve) {
  let addresses
  try {
    addresses = await resolve(host)
  } catch (error) {
    return { ok: false, reason: `dns_error:${error?.code || 'lookup_failed'}` }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return { ok: false, reason: 'dns_no_records' }
  }
  if (addresses.some((address) => isPrivateHost(address))) {
    return { ok: false, reason: 'dns_resolves_private' }
  }
  const pinnedAddress = addresses[0]
  const family = net.isIP(pinnedAddress)
  if (!family) return { ok: false, reason: 'dns_invalid_record' }
  return { ok: true, addresses, pinnedAddress, family }
}

function getHeader(headers, name) {
  if (!headers) return null
  if (typeof headers.get === 'function') return headers.get(name)
  const value = headers[String(name).toLowerCase()]
  return Array.isArray(value) ? value[0] : value ?? null
}

function normalizeContentType(headers) {
  return String(getHeader(headers, 'content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
}

function requestPinnedHttps(url, {
  address,
  family,
  timeoutMs,
  maxBytes,
  headers,
} = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const tlsHost = String(parsed.hostname || '').replace(/^\[|\]$/g, '')
    let settled = false
    let deadlineTimer = null
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      if (deadlineTimer) clearTimeout(deadlineTimer)
      callback(value)
    }

    const request = https.request(
      parsed,
      {
        method: 'GET',
        agent: false,
        ...(net.isIP(tlsHost) ? {} : { servername: tlsHost }),
        family,
        lookup: (_hostname, _options, callback) => callback(null, address, family),
        headers: {
          Accept: '*/*',
          'Accept-Encoding': 'identity',
          ...headers,
        },
      },
      (response) => {
        const status = Number(response.statusCode) || null
        const responseHeaders = response.headers || {}
        const contentLength = Number(getHeader(responseHeaders, 'content-length'))
        const contentEncoding = String(getHeader(responseHeaders, 'content-encoding') || 'identity')
          .trim()
          .toLowerCase()

        if (contentEncoding && contentEncoding !== 'identity') {
          const error = new Error('Unsupported response content encoding')
          error.code = 'UNSUPPORTED_CONTENT_ENCODING'
          finish(reject, error)
          response.destroy()
          return
        }
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          const error = new Error('Response exceeds byte limit')
          error.code = 'RESPONSE_TOO_LARGE'
          finish(reject, error)
          response.destroy()
          return
        }

        if (status && status >= 300 && status < 400) {
          finish(resolve, { status, headers: responseHeaders, body: Buffer.alloc(0) })
          response.destroy()
          return
        }

        const chunks = []
        let totalBytes = 0
        response.on('data', (chunk) => {
          if (settled) return
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          totalBytes += buffer.length
          if (totalBytes > maxBytes) {
            const error = new Error('Response exceeds byte limit')
            error.code = 'RESPONSE_TOO_LARGE'
            finish(reject, error)
            response.destroy()
            return
          }
          chunks.push(buffer)
        })
        response.on('end', () => {
          finish(resolve, {
            status,
            headers: responseHeaders,
            body: Buffer.concat(chunks, totalBytes),
          })
        })
        response.on('error', (error) => finish(reject, error))
      },
    )

    request.setTimeout(Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS), () => {
      const error = new Error('Request timed out')
      error.code = 'ETIMEDOUT'
      request.destroy(error)
    })
    deadlineTimer = setTimeout(() => {
      const error = new Error('Request deadline exceeded')
      error.code = 'ETIMEDOUT'
      request.destroy(error)
    }, Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))
    request.on('error', (error) => finish(reject, error))
    request.end()
  })
}

async function guardResolvedHostBeforeDeadline(host, resolve, timeoutMs) {
  let timer = null
  try {
    return await Promise.race([
      guardResolvedHost(host, resolve),
      new Promise((resolveTimeout) => {
        timer = setTimeout(
          () => resolveTimeout({ ok: false, reason: 'timeout' }),
          Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS),
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function runBeforeDeadline(promise, timeoutMs) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Operation deadline exceeded')
          error.code = 'ETIMEDOUT'
          reject(error)
        }, Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Fetch a bounded public HTTPS resource while pinning the TCP connection to the
 * DNS answer that was checked. Redirects are followed manually and revalidated.
 * This closes the DNS-rebinding gap left by validating DNS and then asking a
 * separate fetch implementation to resolve the hostname again.
 */
export async function fetchPublicResource(url, {
  resolve = defaultResolve,
  transport = requestPinnedHttps,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  allowedContentTypes = null,
  userAgent = 'GrantFlow-SafeReader/1.0',
  accept = '*/*',
} = {}) {
  const boundedMaxBytes = Math.max(1, Number(maxBytes) || DEFAULT_MAX_BYTES)
  const totalTimeoutMs = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)
  const deadline = Date.now() + totalTimeoutMs
  const first = isSafeUrl(url, { kind: 'fetch' })
  if (!first.ok) return { ok: false, status: null, body: null, reason: first.reason }
  if (!first.url.startsWith('https://')) {
    return { ok: false, status: null, body: null, reason: 'https_required' }
  }

  let current = first.url
  const hops = [current]

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const remainingBeforeDns = deadline - Date.now()
    if (remainingBeforeDns <= 0) {
      return { ok: false, status: null, body: null, reason: 'timeout', finalUrl: current, hops }
    }
    const parsed = new URL(current)
    const dnsHost = String(parsed.hostname || '').replace(/^\[|\]$/g, '')
    const hostGuard = await guardResolvedHostBeforeDeadline(dnsHost, resolve, remainingBeforeDns)
    if (!hostGuard.ok) {
      return {
        ok: false,
        status: null,
        body: null,
        reason: hostGuard.reason,
        finalUrl: current,
        hops,
      }
    }

    let response
    try {
      const remainingBeforeRequest = deadline - Date.now()
      if (remainingBeforeRequest <= 0) {
        return { ok: false, status: null, body: null, reason: 'timeout', finalUrl: current, hops }
      }
      response = await runBeforeDeadline(
        transport(current, {
          address: hostGuard.pinnedAddress,
          family: hostGuard.family,
          timeoutMs: remainingBeforeRequest,
          maxBytes: boundedMaxBytes,
          headers: {
            Accept: accept,
            'User-Agent': userAgent,
          },
        }),
        remainingBeforeRequest,
      )
    } catch (error) {
      const reason =
        error?.code === 'ETIMEDOUT'
          ? 'timeout'
          : error?.code === 'RESPONSE_TOO_LARGE'
            ? 'response_too_large'
            : error?.code === 'UNSUPPORTED_CONTENT_ENCODING'
              ? 'unsupported_content_encoding'
              : 'fetch_failed'
      return {
        ok: false,
        status: null,
        body: null,
        reason,
        error: error?.message || String(error),
        finalUrl: current,
        hops,
      }
    }

    const status = Number(response?.status) || null
    if (status && status >= 300 && status < 400) {
      const location = getHeader(response?.headers, 'location')
      if (!location) {
        return { ok: false, status, body: null, reason: 'redirect_without_location', finalUrl: current, hops }
      }
      let nextUrl
      try {
        nextUrl = new URL(location, current).toString()
      } catch {
        return { ok: false, status, body: null, reason: 'invalid_redirect_location', finalUrl: current, hops }
      }
      const next = isSafeUrl(nextUrl, { kind: 'fetch' })
      if (!next.ok || !next.url.startsWith('https://')) {
        return {
          ok: false,
          status,
          body: null,
          reason: next.ok ? 'https_required' : next.reason,
          finalUrl: nextUrl,
          hops,
        }
      }
      current = next.url
      hops.push(current)
      continue
    }

    if (!status || status < 200 || status >= 300) {
      return { ok: false, status, body: null, reason: 'http_error', finalUrl: current, hops }
    }

    const contentType = normalizeContentType(response?.headers)
    if (
      Array.isArray(allowedContentTypes) &&
      allowedContentTypes.length > 0 &&
      !allowedContentTypes.includes(contentType)
    ) {
      return { ok: false, status, body: null, reason: 'unsupported_content_type', finalUrl: current, hops, contentType }
    }

    const body = Buffer.isBuffer(response?.body) ? response.body : Buffer.from(response?.body || '')
    if (body.length > boundedMaxBytes) {
      return { ok: false, status, body: null, reason: 'response_too_large', finalUrl: current, hops, contentType }
    }

    return { ok: true, status, body, finalUrl: current, hops, contentType }
  }

  return { ok: false, status: null, body: null, reason: 'too_many_redirects', finalUrl: current, hops }
}

export async function fetchPublicText(url, {
  fetchImpl = globalThis.fetch,
  resolve = defaultResolve,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  userAgent = 'GrantFlow-SafeReader/1.0',
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, status: null, body: '', reason: 'fetch_unavailable' }
  }

  // Production calls use the DNS-pinned transport. Tests may still inject a
  // fetch implementation to exercise legacy Response-shaped fixtures.
  if (fetchImpl === globalThis.fetch) {
    const result = await fetchPublicResource(url, {
      resolve,
      timeoutMs,
      maxBytes,
      maxRedirects,
      allowedContentTypes: ALLOWED_CONTENT_TYPES,
      userAgent,
      accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.8',
    })
    return {
      ...result,
      body: result.ok ? result.body.toString('utf8') : '',
    }
  }

  const first = isSafeUrl(url, { kind: 'fetch' })
  if (!first.ok) return { ok: false, status: null, body: '', reason: first.reason }
  if (!first.url.startsWith('https://')) {
    return { ok: false, status: null, body: '', reason: 'https_required' }
  }

  let current = first.url
  const hops = [current]

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const parsed = new URL(current)
    const dnsHost = String(parsed.hostname || '').replace(/^\[|\]$/g, '')
    const hostGuard = await guardResolvedHost(dnsHost, resolve)
    if (!hostGuard.ok) {
      return {
        ok: false,
        status: null,
        body: '',
        reason: hostGuard.reason,
        finalUrl: current,
        hops,
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))
    let response
    try {
      response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.8',
          'User-Agent': userAgent,
        },
      })
    } catch (error) {
      clearTimeout(timer)
      return {
        ok: false,
        status: null,
        body: '',
        reason: error?.name === 'AbortError' ? 'timeout' : 'fetch_failed',
        error: error?.message || String(error),
        finalUrl: current,
        hops,
      }
    }
    clearTimeout(timer)

    const status = Number(response.status) || null
    if (status && status >= 300 && status < 400) {
      const location = response.headers?.get?.('location')
      if (!location) {
        return { ok: false, status, body: '', reason: 'redirect_without_location', finalUrl: current, hops }
      }
      let nextUrl
      try {
        nextUrl = new URL(location, current).toString()
      } catch {
        return { ok: false, status, body: '', reason: 'invalid_redirect_location', finalUrl: current, hops }
      }
      const next = isSafeUrl(nextUrl, { kind: 'fetch' })
      if (!next.ok || !next.url.startsWith('https://')) {
        return {
          ok: false,
          status,
          body: '',
          reason: next.ok ? 'https_required' : next.reason,
          finalUrl: nextUrl,
          hops,
        }
      }
      current = next.url
      hops.push(current)
      continue
    }

    if (!response.ok) {
      return { ok: false, status, body: '', reason: 'http_error', finalUrl: current, hops }
    }

    const contentType = String(response.headers?.get?.('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase()
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      return { ok: false, status, body: '', reason: 'unsupported_content_type', finalUrl: current, hops }
    }

    const body = await readLimitedText(response, Math.max(1, Number(maxBytes) || DEFAULT_MAX_BYTES))
    if (!body.ok) {
      return { ok: false, status, body: '', reason: body.reason, finalUrl: current, hops }
    }

    return { ok: true, status, body: body.body, finalUrl: current, hops, contentType }
  }

  return { ok: false, status: null, body: '', reason: 'too_many_redirects', finalUrl: current, hops }
}

export default { fetchPublicText, fetchPublicResource, publicFetchFailureStatus }
