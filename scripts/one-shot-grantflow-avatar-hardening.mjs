import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function write(relativePath, content) {
  fs.writeFileSync(path.join(root, relativePath), content, 'utf8')
}

function replaceOnce(content, needle, replacement, label) {
  const first = content.indexOf(needle)
  if (first === -1) throw new Error(`[${label}] expected source text was not found`)
  const second = content.indexOf(needle, first + needle.length)
  if (second !== -1) throw new Error(`[${label}] expected exactly one source match`)
  return content.slice(0, first) + replacement + content.slice(first + needle.length)
}

function replaceRange(content, startMarker, endMarker, replacement, label) {
  const start = content.indexOf(startMarker)
  if (start === -1) throw new Error(`[${label}] start marker was not found`)
  const end = content.indexOf(endMarker, start + startMarker.length)
  if (end === -1) throw new Error(`[${label}] end marker was not found`)
  if (content.indexOf(startMarker, start + startMarker.length) !== -1) {
    throw new Error(`[${label}] start marker was not unique`)
  }
  return content.slice(0, start) + replacement + content.slice(end + endMarker.length)
}

function insertBeforeOnce(content, marker, insertion, label) {
  const index = content.indexOf(marker)
  if (index === -1) throw new Error(`[${label}] insertion marker was not found`)
  if (content.indexOf(marker, index + marker.length) !== -1) {
    throw new Error(`[${label}] insertion marker was not unique`)
  }
  return content.slice(0, index) + insertion + content.slice(index)
}

function hardenSafeFetch() {
  const relativePath = 'backend/services/http/safeFetch.js'
  let source = read(relativePath)

  source = insertBeforeOnce(
    source,
    '/**\n * Validate and resolve a single URL.',
    `/** True only for loopback names or addresses. */
function isLoopbackOnly(value) {
  let address = String(value || '').trim().toLowerCase().replace(/^\\[|\\]$/g, '')
  if (!address) return false
  if (address === 'localhost' || address.endsWith('.localhost') || address === '::1') return true
  const mapped = address.match(/^::ffff:(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})$/)
  if (mapped) address = mapped[1]
  if (!/^\\d{1,3}(?:\\.\\d{1,3}){3}$/.test(address)) return false
  const octets = address.split('.').map(Number)
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && octets[0] === 127
}

`,
    'safe-fetch-loopback-helper',
  )

  source = replaceOnce(
    source,
    `  const host = parsed.hostname.toLowerCase().replace(/^\\[|\\]$/g, '')
  if (SSRF_BLOCKED_HOSTS.has(host)) return { ok: false, reason: \`blocked_host:\${host}\` }
`,
    `  const host = parsed.hostname.toLowerCase().replace(/^\\[|\\]$/g, '')
  // Hermetic tests may opt into the loopback interface only. The exemption is
  // ignored outside NODE_ENV=test and never applies to a public name that
  // resolves to loopback, RFC1918, link-local, or metadata space.
  const allowTestLoopback =
    opts.allowTestLoopback === true &&
    process.env.NODE_ENV === 'test' &&
    isLoopbackOnly(host)
  if (SSRF_BLOCKED_HOSTS.has(host) && !allowTestLoopback) {
    return { ok: false, reason: \`blocked_host:\${host}\` }
  }
`,
    'safe-fetch-host-test-exemption',
  )

  source = replaceOnce(
    source,
    `  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new SsrfBlockedError(\`resolves_private:\${record.address}\`, url)
    }
  }
`,
    `  for (const record of records) {
    const permittedTestLoopback = allowTestLoopback && isLoopbackOnly(record.address)
    if (isPrivateIp(record.address) && !permittedTestLoopback) {
      throw new SsrfBlockedError(\`resolves_private:\${record.address}\`, url)
    }
  }
`,
    'safe-fetch-record-test-exemption',
  )

  source = replaceOnce(
    source,
    ` * @param {Function} [opts.resolve] testable DNS resolver
 * @returns {Promise<{ url: string, host: string, address: string, family: 4|6 }>}
`,
    ` * @param {Function} [opts.resolve] testable DNS resolver
 * @param {boolean} [opts.allowTestLoopback] ignored unless NODE_ENV=test and the URL host itself is loopback
 * @returns {Promise<{ url: string, host: string, address: string, family: 4|6 }>}
`,
    'safe-fetch-egress-jsdoc',
  )

  source = replaceOnce(
    source,
    ` * @param {Function} [opts.resolve]
 * @param {Function} [opts.fetchImpl] test-only fetch implementation
`,
    ` * @param {Function} [opts.resolve]
 * @param {boolean} [opts.allowTestLoopback] test-only loopback exemption; ignored outside NODE_ENV=test
 * @param {Function} [opts.fetchImpl] test-only fetch implementation
`,
    'safe-fetch-jsdoc',
  )

  source = replaceOnce(
    source,
    `      const resolved = await assertEgressAllowed(currentUrl, { resolve: opts.resolve })
`,
    `      const resolved = await assertEgressAllowed(currentUrl, {
        resolve: opts.resolve,
        allowTestLoopback: opts.allowTestLoopback,
      })
`,
    'safe-fetch-pass-loopback-option',
  )

  source = replaceRange(
    source,
    '/**\n * Read a response body as text with a hard byte cap.',
    '/**\n * Convenience wrapper: returns null instead of throwing when the URL is',
    `/**
 * Read a response body as bytes with a hard streaming cap.
 *
 * Real network responses expose a Web or Node stream, so oversized bodies are
 * cancelled or destroyed before the process buffers the remainder. Bodyless
 * mocks fall back to arrayBuffer/text and are capped after conversion.
 *
 * @param {Response|Object} res
 * @param {number} [maxBytes]
 * @returns {Promise<{ buffer: Buffer, truncated: boolean }>}
 */
export async function readBufferCapped(res, maxBytes = DEFAULT_MAX_BYTES) {
  const cap = Number.isFinite(maxBytes) ? Math.max(0, Math.trunc(maxBytes)) : DEFAULT_MAX_BYTES
  const body = res?.body

  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks = []
    let total = 0
    let truncated = false
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const buffer = Buffer.from(value || [])
      const remaining = cap - total
      if (remaining <= 0) {
        truncated = true
        try { await reader.cancel() } catch { /* already closed */ }
        break
      }
      if (buffer.length > remaining) {
        chunks.push(buffer.subarray(0, remaining))
        total += remaining
        truncated = true
        try { await reader.cancel() } catch { /* already closed */ }
        break
      }
      chunks.push(buffer)
      total += buffer.length
    }
    return { buffer: Buffer.concat(chunks, total), truncated }
  }

  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = []
    let total = 0
    let truncated = false
    try {
      for await (const value of body) {
        const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
        const remaining = cap - total
        if (remaining <= 0) {
          truncated = true
          break
        }
        if (buffer.length > remaining) {
          chunks.push(buffer.subarray(0, remaining))
          total += remaining
          truncated = true
          break
        }
        chunks.push(buffer)
        total += buffer.length
      }
    } finally {
      if (truncated && typeof body.destroy === 'function') body.destroy()
    }
    return { buffer: Buffer.concat(chunks, total), truncated }
  }

  let raw
  if (typeof res?.arrayBuffer === 'function') {
    raw = Buffer.from(await res.arrayBuffer())
  } else if (typeof res?.text === 'function') {
    raw = Buffer.from(String(await res.text()))
  } else {
    raw = Buffer.alloc(0)
  }
  return {
    buffer: raw.subarray(0, cap),
    truncated: raw.length > cap,
  }
}

/**
 * Read a response body as text with a hard byte cap.
 *
 * @param {Response|Object} res
 * @param {number} [maxBytes]
 * @returns {Promise<string>}
 */
export async function readTextCapped(res, maxBytes = DEFAULT_MAX_BYTES) {
  const { buffer } = await readBufferCapped(res, maxBytes)
  return buffer.toString('utf8')
}

/**
 * Convenience wrapper: returns null instead of throwing when the URL is`,
    'safe-fetch-body-reader',
  )

  write(relativePath, source)
}

function hardenAvatarCrawler() {
  const relativePath = 'backend/services/avatarCrawler.js'
  let source = read(relativePath)

  source = replaceOnce(
    source,
    `import { assertSsrfSafeUrl } from '../config/urlRules.js'
`,
    `import {
  readBufferCapped,
  readTextCapped,
  safeFetch,
  SsrfBlockedError,
} from './http/safeFetch.js'
`,
    'avatar-import-safe-fetch',
  )

  source = replaceRange(
    source,
    'const fetchImpl = globalThis.fetch',
    'export function normalizeHttpUrl',
    `const FETCH_TIMEOUT_MS = 12_000
const MAX_REDIRECTS = 4
const MAX_HTML_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const USER_AGENT = 'GrantFlow Avatar Lookup/1.0'

/** Map shared SSRF refusals onto the avatar crawler's stable reason vocabulary. */
function mapSsrfReason(reason) {
  const value = String(reason || '')
  if (
    value.startsWith('private_ip:') ||
    value.startsWith('resolves_private:') ||
    value.startsWith('blocked_host:')
  ) return 'blocked_private_host'
  if (value === 'empty_url' || value === 'unparseable_url') return 'invalid_url'
  if (value.startsWith('unparseable_redirect')) return 'invalid_redirect'
  if (value.startsWith('blocked_scheme:')) return 'blocked_redirect_scheme'
  if (value.startsWith('too_many_redirects:')) return 'too_many_redirects'
  if (value === 'embedded_credentials') return 'blocked_embedded_credentials'
  if (value.startsWith('dns_')) return 'dns_failed'
  return value || 'fetch_failed'
}

export function normalizeHttpUrl`,
    'avatar-header-and-reason-map',
  )

  source = replaceRange(
    source,
    'function isLoopbackHostname',
    'function resolveUrl',
    'function resolveUrl',
    'avatar-remove-loopback-helper',
  )

  source = replaceRange(
    source,
    'async function fetchOnce',
    'function pickWebsiteImageCandidate',
    `/**
 * Avatar egress delegates to GrantFlow's single socket-pinned safeFetch
 * chokepoint. DNS is resolved once per hop, the approved address is pinned to
 * the connection, redirects are revalidated, and one deadline spans the chain.
 * Test-only transport/resolver injection is forwarded to safeFetch.
 */
export async function safeAvatarFetch(startUrl, accept, options = {}) {
  const egress = typeof options.safeFetchImpl === 'function'
    ? options.safeFetchImpl
    : safeFetch
  try {
    const res = await egress(
      startUrl,
      {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: accept,
        },
      },
      {
        maxRedirects: MAX_REDIRECTS,
        timeoutMs: FETCH_TIMEOUT_MS,
        signal: options.signal,
        resolve: options.resolve,
        fetchImpl: options.fetchImpl,
        allowTestLoopback:
          options.allowLocalhost === true && process.env.NODE_ENV === 'test',
      },
    )
    return {
      ok: true,
      res,
      finalUrl: res?.grantflowFinalUrl || startUrl,
    }
  } catch (error) {
    const message = String(error?.message || '')
    if (
      error instanceof SsrfBlockedError ||
      error?.name === 'SsrfBlockedError' ||
      message.startsWith('ssrf_blocked:')
    ) {
      const reason = error?.reason || message.replace(/^ssrf_blocked:/, '')
      return { ok: false, reason: mapSsrfReason(reason) }
    }
    return {
      ok: false,
      reason: error?.name === 'AbortError' ? 'fetch_timeout_or_cancelled' : 'fetch_failed',
    }
  }
}

function pickWebsiteImageCandidate`,
    'avatar-use-safe-fetch',
  )

  source = replaceOnce(
    source,
    `  if (!fetchImpl) return { ok: false, reason: 'fetch_unavailable' }

`,
    '',
    'avatar-remove-direct-fetch-check',
  )

  source = replaceOnce(
    source,
    `  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > 10 * 1024 * 1024) return { ok: false, reason: 'too_large' }
  if (buf.length < 100) return { ok: false, reason: 'too_small' }
`,
    `  const imageBody = await readBufferCapped(res, MAX_IMAGE_BYTES).catch(() => null)
  if (!imageBody) return { ok: false, reason: 'fetch_failed' }
  if (imageBody.truncated) return { ok: false, reason: 'too_large' }
  const buf = imageBody.buffer
  if (buf.length < 100) return { ok: false, reason: 'too_small' }
`,
    'avatar-direct-stream-cap',
  )

  source = replaceOnce(
    source,
    `  if (!fetchImpl) {
    return { ok: false, reason: 'fetch_unavailable' }
  }

`,
    '',
    'avatar-remove-website-fetch-check',
  )

  source = replaceOnce(
    source,
    `  const html = await res.text().catch(() => '')
`,
    `  const html = await readTextCapped(res, MAX_HTML_BYTES).catch(() => '')
`,
    'avatar-html-stream-cap',
  )

  source = replaceRange(
    source,
    '  // Cover URLs are page-derived (untrusted). Re-run the DNS-resolving hop',
    "  const imgFetched = await safeAvatarFetch(coverUrl, 'image/*,*/*;q=0.8', { allowLocalhost })",
    "  const imgFetched = await safeAvatarFetch(coverUrl, 'image/*,*/*;q=0.8', { allowLocalhost })",
    'avatar-remove-redundant-cover-preflight',
  )

  source = replaceOnce(
    source,
    `  const buf = Buffer.from(await imgRes.arrayBuffer())
  // Safety cap: 10MB
  if (buf.length > 10 * 1024 * 1024) {
    return { ok: false, reason: 'cover_too_large' }
  }
`,
    `  const imageBody = await readBufferCapped(imgRes, MAX_IMAGE_BYTES).catch(() => null)
  if (!imageBody) return { ok: false, reason: 'cover_fetch_failed' }
  if (imageBody.truncated) return { ok: false, reason: 'cover_too_large' }
  const buf = imageBody.buffer
`,
    'avatar-cover-stream-cap',
  )

  if (source.includes("import { assertSsrfSafeUrl }")) {
    throw new Error('[avatar-final-check] preflight-only SSRF import remains')
  }
  if (source.includes('const fetchImpl = globalThis.fetch')) {
    throw new Error('[avatar-final-check] raw global fetch binding remains')
  }
  if (!source.includes("from './http/safeFetch.js'")) {
    throw new Error('[avatar-final-check] shared egress chokepoint import is missing')
  }

  write(relativePath, source)
}

function extendSafeFetchTests() {
  const relativePath = 'backend/tests/safeFetchSsrf.test.js'
  let source = read(relativePath)

  source = replaceOnce(
    source,
    `  readTextCapped,
  discardResponseBody,
`,
    `  readTextCapped,
  readBufferCapped,
  discardResponseBody,
`,
    'safe-fetch-test-import',
  )

  source = insertBeforeOnce(
    source,
    `  it('returns short bodies intact', async () => {
`,
    `  it('caps Web binary bodies while reporting truncation', async () => {
    const res = new Response(Buffer.alloc(256, 7), { status: 200 })
    const result = await readBufferCapped(res, 100)
    expect(result.buffer.length).toBe(100)
    expect(result.truncated).toBe(true)
  })

  it('caps Node binary streams incrementally and destroys them', async () => {
    const stream = Readable.from([
      Buffer.alloc(80, 1),
      Buffer.alloc(80, 2),
    ])
    const destroy = vi.spyOn(stream, 'destroy')

    const result = await readBufferCapped({ body: stream }, 100)

    expect(result.buffer.length).toBe(100)
    expect(result.truncated).toBe(true)
    expect(destroy).toHaveBeenCalled()
  })

`,
    'safe-fetch-binary-cap-tests',
  )

  write(relativePath, source)
}

function replaceAvatarTests() {
  const relativePath = 'backend/tests/avatarCrawlerSsrf.test.js'
  const source = `/**
 * Guard: avatar_lookup must use the socket-pinned egress chokepoint for every
 * page/image hop and must never follow redirects into private/metadata space.
 */
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { processAvatarLookupJob, safeAvatarFetch } from '../services/avatarCrawler.js'

process.env.NODE_ENV = 'test'

const PNG_BYTES = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 9)])

describe('avatarCrawler socket-pinned SSRF guard', () => {
  let redirectServer
  let goodServer
  let redirectPort
  let goodPort
  let uploadDir

  beforeAll(async () => {
    uploadDir = mkdtempSync(join(tmpdir(), 'avatar-ssrf-'))

    redirectServer = http.createServer((req, res) => {
      if (req.url === '/r') {
        res.statusCode = 302
        res.setHeader('location', 'http://169.254.169.254/latest/meta-data/')
        res.end('redirect')
        return
      }
      if (req.url === '/cover-redirect') {
        res.statusCode = 302
        res.setHeader('location', 'http://169.254.169.254/evil.png')
        res.end('redirect')
        return
      }
      res.statusCode = 404
      res.end('nf')
    })
    await new Promise((resolve) => redirectServer.listen(0, '127.0.0.1', resolve))
    redirectPort = redirectServer.address().port

    goodServer = http.createServer((req, res) => {
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html')
        res.end(
          \`<html><head><meta property="og:image" content="http://127.0.0.1:\${redirectPort}/cover-redirect"></head></html>\`,
        )
        return
      }
      if (req.url === '/ok.png') {
        res.setHeader('content-type', 'image/png')
        res.end(PNG_BYTES)
        return
      }
      res.statusCode = 404
      res.end('nf')
    })
    await new Promise((resolve) => goodServer.listen(0, '127.0.0.1', resolve))
    goodPort = goodServer.address().port
  })

  afterAll(async () => {
    await new Promise((resolve) => redirectServer.close(resolve))
    await new Promise((resolve) => goodServer.close(resolve))
    rmSync(uploadDir, { recursive: true, force: true })
  })

  it('blocks a redirect hop into cloud metadata before a second request', async () => {
    const result = await safeAvatarFetch(
      \`http://127.0.0.1:\${redirectPort}/r\`,
      'text/html',
      { allowLocalhost: true },
    )
    expect(result).toMatchObject({ ok: false, reason: 'blocked_private_host' })
  })

  it('blocks a public hostname whose DNS answer is private without invoking transport', async () => {
    const fetchImpl = vi.fn()
    const resolve = vi.fn(async (host) => [{
      address: host === 'evil.example' ? '169.254.169.254' : '93.184.216.34',
      family: 4,
    }])

    const result = await safeAvatarFetch(
      'http://evil.example/latest/meta-data/',
      'text/html',
      { resolve, fetchImpl },
    )

    expect(result).toMatchObject({ ok: false, reason: 'blocked_private_host' })
    expect(resolve).toHaveBeenCalledWith('evil.example')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('re-resolves every redirect and refuses a rebinding target before transport', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      status: 302,
      headers: {
        get: (name) => name.toLowerCase() === 'location'
          ? 'http://rebind.example/latest/meta-data/'
          : null,
      },
      body: { cancel },
    })
    const resolve = vi.fn(async (host) => [{
      address: host === 'rebind.example' ? '169.254.169.254' : '93.184.216.34',
      family: 4,
    }])

    const result = await safeAvatarFetch(
      'http://public.example/start',
      'text/html',
      { resolve, fetchImpl },
    )

    expect(result).toMatchObject({ ok: false, reason: 'blocked_private_host' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls.map(([host]) => host)).toEqual(['public.example', 'rebind.example'])
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('pins the policy-approved address into the avatar transport agent', async () => {
    const resolve = vi.fn().mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ])
    let pinned
    const fetchImpl = vi.fn(async (_url, init) => {
      pinned = await new Promise((resolveLookup, rejectLookup) => {
        init.agent.options.lookup('avatar.example', {}, (error, address, family) => {
          if (error) rejectLookup(error)
          else resolveLookup({ address, family })
        })
      })
      return new Response('ok', { status: 200 })
    })

    const result = await safeAvatarFetch(
      'https://avatar.example/photo.png',
      'image/*',
      { resolve, fetchImpl },
    )

    expect(result.ok).toBe(true)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(pinned).toEqual({ address: '93.184.216.34', family: 4 })
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual')
  })

  it('blocks a website cover whose image redirects to private space', async () => {
    const result = await processAvatarLookupJob({
      profileContext: {
        profile: { id: 'p1', display_name: 'Test Org', primary_type: 'nonprofit' },
        website_hint: \`http://127.0.0.1:\${goodPort}/\`,
      },
      uploadDir,
      getOpenAI: () => null,
      job: { parameters: {} },
    })
    expect(result.inserted).toBe(0)
    expect(result.result_meta?.ok).toBe(false)
  })

  it('still fetches a safe same-origin redirect chain', async () => {
    const chainServer = http.createServer((req, res) => {
      if (req.url === '/start') {
        res.statusCode = 302
        res.setHeader('location', '/ok.png')
        res.end('go')
        return
      }
      if (req.url === '/ok.png') {
        res.setHeader('content-type', 'image/png')
        res.end(PNG_BYTES)
        return
      }
      res.statusCode = 404
      res.end('nf')
    })
    await new Promise((resolve) => chainServer.listen(0, '127.0.0.1', resolve))
    const { port } = chainServer.address()
    try {
      const result = await safeAvatarFetch(
        \`http://127.0.0.1:\${port}/start\`,
        'image/*',
        { allowLocalhost: true },
      )
      expect(result.ok).toBe(true)
      expect(result.res.ok).toBe(true)
      expect(result.finalUrl).toBe(\`http://127.0.0.1:\${port}/ok.png\`)
    } finally {
      await new Promise((resolve) => chainServer.close(resolve))
    }
  })
})
`
  write(relativePath, source)
}

hardenSafeFetch()
hardenAvatarCrawler()
extendSafeFetchTests()
replaceAvatarTests()

console.log('[grantflow] avatar egress hardening applied')
