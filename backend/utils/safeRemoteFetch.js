import dns from 'node:dns/promises'
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

async function defaultResolve(host) {
  const records = await dns.lookup(host, { all: true, verbatim: true })
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
  return { ok: true }
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

  const first = isSafeUrl(url, { kind: 'fetch' })
  if (!first.ok) return { ok: false, status: null, body: '', reason: first.reason }
  if (!first.url.startsWith('https://')) {
    return { ok: false, status: null, body: '', reason: 'https_required' }
  }

  let current = first.url
  const hops = [current]

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const parsed = new URL(current)
    const hostGuard = await guardResolvedHost(parsed.hostname, resolve)
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
      const nextUrl = new URL(location, current).toString()
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

export default { fetchPublicText }
