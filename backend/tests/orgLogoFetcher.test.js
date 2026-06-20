/**
 * Unit tests for backend/services/orgLogoFetcher.js — the org-website logo
 * extractor that powers the "Use website logo" avatar option for ORGANIZATION
 * profiles.
 *
 * These pin two contracts:
 *   1. extractLogoCandidates() returns candidates in the documented priority
 *      order (og:image -> largest apple-touch-icon -> favicon -> prominent
 *      <img>), with the LARGEST apple-touch-icon preferred.
 *   2. fetchOrgLogo() downloads usable image bytes, enforces the size floor /
 *      image-only content type, and fails gracefully (structured reason) for
 *      no-website and SSRF-blocked private hosts.
 */
import http from 'http'
import { describe, it, expect } from 'vitest'
import { extractLogoCandidates, fetchOrgLogo } from '../services/orgLogoFetcher.js'

const SAMPLE_HTML = `<!doctype html><html><head>
  <meta property="og:image" content="/og.png">
  <link rel="apple-touch-icon" sizes="120x120" href="/touch-120.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/touch-180.png">
  <link rel="icon" href="/favicon-32.png" sizes="32x32">
</head><body>
  <img src="/logo.svg" class="site-logo" alt="Acme logo" width="200" height="60">
</body></html>`

// A valid-enough PNG payload above the MIN_IMAGE_BYTES (100B) floor.
const PNG_BYTES = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 9)])

describe('extractLogoCandidates', () => {
  it('orders candidates by priority and prefers the largest apple-touch-icon', () => {
    const candidates = extractLogoCandidates(SAMPLE_HTML, 'https://example.org/')
    const methods = candidates.map((c) => c.method)

    expect(methods[0]).toBe('og_image')
    expect(candidates[0].url).toBe('https://example.org/og.png')

    const apple = candidates.filter((c) => c.method === 'apple_touch_icon')
    // 180x180 must come before 120x120.
    expect(apple[0].url).toBe('https://example.org/touch-180.png')
    expect(apple[1].url).toBe('https://example.org/touch-120.png')

    // favicon family appears before the prominent <img> fallback.
    expect(methods.indexOf('favicon')).toBeLessThan(methods.indexOf('logo_img'))
    // /favicon.ico is always appended as a last-resort favicon.
    expect(candidates.some((c) => c.url === 'https://example.org/favicon.ico')).toBe(true)
  })

  it('returns an empty list for empty html', () => {
    expect(extractLogoCandidates('', 'https://example.org/')).toEqual([])
  })
})

describe('fetchOrgLogo', () => {
  it('downloads the highest-priority usable image (og:image)', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html')
        res.end(SAMPLE_HTML)
        return
      }
      if (req.url === '/og.png') {
        res.setHeader('content-type', 'image/png')
        res.end(PNG_BYTES)
        return
      }
      res.statusCode = 404
      res.end('not found')
    })
    await new Promise((resolve) => server.listen(0, resolve))
    const { port } = server.address()
    try {
      const result = await fetchOrgLogo(`http://127.0.0.1:${port}/`, { allowLocalhost: true })
      expect(result.ok).toBe(true)
      expect(result.method).toBe('og_image')
      expect(result.contentType).toBe('image/png')
      expect(Buffer.isBuffer(result.buffer)).toBe(true)
      expect(result.buffer.length).toBe(PNG_BYTES.length)
    } finally {
      server.close()
    }
  })

  it('skips an image below the size floor and reports a reason when nothing usable remains', async () => {
    const tiny = Buffer.from('89504e470d0a', 'hex') // < 100 bytes
    const server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html')
        res.end('<html><head><meta property="og:image" content="/og.png"></head></html>')
        return
      }
      if (req.url === '/og.png') {
        res.setHeader('content-type', 'image/png')
        res.end(tiny)
        return
      }
      res.statusCode = 404
      res.end('nf')
    })
    await new Promise((resolve) => server.listen(0, resolve))
    const { port } = server.address()
    try {
      const result = await fetchOrgLogo(`http://127.0.0.1:${port}/`, { allowLocalhost: true })
      expect(result.ok).toBe(false)
      expect(typeof result.reason).toBe('string')
    } finally {
      server.close()
    }
  })

  it('fails gracefully with no_website when given a blank url', async () => {
    const result = await fetchOrgLogo('')
    expect(result).toEqual({ ok: false, reason: 'no_website' })
  })

  it('blocks private/loopback hosts when localhost is not allowed (SSRF guard)', async () => {
    const result = await fetchOrgLogo('http://10.0.0.5/', { allowLocalhost: false })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('blocked_private_host')
  })
})
