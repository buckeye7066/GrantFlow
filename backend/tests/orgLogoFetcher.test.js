/**
 * Unit and focused integration tests for the organization website logo fetcher.
 */
import http from 'http'
import { describe, expect, it, vi } from 'vitest'
import { extractLogoCandidates, fetchOrgLogo } from '../services/orgLogoFetcher.js'

const SAMPLE_HTML = `<!doctype html><html><head>
  <meta property="og:image" content="/og.png">
  <link rel="apple-touch-icon" sizes="120x120" href="/touch-120.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/touch-180.png">
  <link rel="icon" href="/favicon-32.png" sizes="32x32">
</head><body>
  <img src="/logo.svg" class="site-logo" alt="Acme logo" width="200" height="60">
</body></html>`

const PNG_BYTES = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.alloc(400, 9),
])

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve))
}

describe('extractLogoCandidates', () => {
  it('orders candidates by priority and prefers the largest apple-touch-icon', () => {
    const candidates = extractLogoCandidates(SAMPLE_HTML, 'https://example.org/')
    const methods = candidates.map((candidate) => candidate.method)

    expect(methods[0]).toBe('og_image')
    expect(candidates[0].url).toBe('https://example.org/og.png')

    const apple = candidates.filter((candidate) => candidate.method === 'apple_touch_icon')
    expect(apple[0].url).toBe('https://example.org/touch-180.png')
    expect(apple[1].url).toBe('https://example.org/touch-120.png')

    expect(methods.indexOf('favicon')).toBeLessThan(methods.indexOf('logo_img'))
    expect(candidates.some((candidate) => candidate.url === 'https://example.org/favicon.ico')).toBe(true)
  })

  it('returns an empty list for empty html', () => {
    expect(extractLogoCandidates('', 'https://example.org/')).toEqual([])
  })
})

describe('fetchOrgLogo', () => {
  it('downloads the highest-priority usable image', async () => {
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
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    try {
      const result = await fetchOrgLogo(`http://127.0.0.1:${port}/`, {
        allowLocalhost: true,
      })
      expect(result.ok).toBe(true)
      expect(result.method).toBe('og_image')
      expect(result.contentType).toBe('image/png')
      expect(Buffer.isBuffer(result.buffer)).toBe(true)
      expect(result.buffer.length).toBe(PNG_BYTES.length)
    } finally {
      await closeServer(server)
    }
  })

  it('skips an image below the size floor and reports a reason when nothing usable remains', async () => {
    const tiny = Buffer.from('89504e470d0a', 'hex')
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
      res.end('not found')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    try {
      const result = await fetchOrgLogo(`http://127.0.0.1:${port}/`, {
        allowLocalhost: true,
      })
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('image_too_small')
    } finally {
      await closeServer(server)
    }
  })

  it('fails gracefully when no website is supplied', async () => {
    await expect(fetchOrgLogo('')).resolves.toEqual({ ok: false, reason: 'no_website' })
  })

  it('blocks a private literal when localhost is not allowed', async () => {
    const result = await fetchOrgLogo('http://10.0.0.5/', { allowLocalhost: false })
    expect(result).toEqual({ ok: false, reason: 'blocked_private_host' })
  })

  it('blocks a public hostname whose DNS answer is private before transport', async () => {
    const privateAddress = ['10', '0', '0', '8'].join('.')
    const resolve = vi.fn(async () => [{ address: privateAddress, family: 4 }])
    const fetchImpl = vi.fn()

    const result = await fetchOrgLogo('https://org.example/', { resolve, fetchImpl })

    expect(result).toEqual({ ok: false, reason: 'blocked_private_host' })
    expect(resolve).toHaveBeenCalledWith('org.example')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('revalidates a homepage redirect before making the redirected request', async () => {
    const privateAddress = ['169', '254', '169', '254'].join('.')
    const resolve = vi.fn(async (host) => [{
      address: host === 'metadata.example' ? privateAddress : '93.184.216.34',
      family: 4,
    }])
    const fetchImpl = vi.fn(async () => new Response('redirect', {
      status: 302,
      headers: { location: 'http://metadata.example/latest/' },
    }))

    const result = await fetchOrgLogo('https://org.example/', { resolve, fetchImpl })

    expect(result).toEqual({ ok: false, reason: 'blocked_private_host' })
    expect(resolve.mock.calls.map(([host]) => host)).toEqual([
      'org.example',
      'metadata.example',
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('never transports a page-derived image redirect after its DNS answer becomes private', async () => {
    const privateAddress = ['169', '254', '169', '254'].join('.')
    const resolve = vi.fn(async (host) => [{
      address: host === 'metadata.example'
        ? privateAddress
        : host === 'cdn.example'
          ? '93.184.216.35'
          : '93.184.216.34',
      family: 4,
    }])
    const fetchImpl = vi.fn(async (url) => {
      const parsed = new URL(url)
      if (parsed.hostname === 'org.example' && parsed.pathname === '/') {
        return new Response(
          '<html><head><meta property="og:image" content="https://cdn.example/logo.png"></head></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        )
      }
      if (parsed.hostname === 'cdn.example') {
        return new Response('redirect', {
          status: 302,
          headers: { location: 'http://metadata.example/logo.png' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const result = await fetchOrgLogo('https://org.example/', { resolve, fetchImpl })

    expect(result.ok).toBe(false)
    expect(resolve.mock.calls.some(([host]) => host === 'metadata.example')).toBe(true)
    expect(
      fetchImpl.mock.calls.some(([url]) => new URL(url).hostname === 'metadata.example'),
    ).toBe(false)
  })

  it('pins the approved address for both homepage and image requests', async () => {
    const answers = {
      'org.example': { address: '93.184.216.34', family: 4 },
      'cdn.example': { address: '93.184.216.35', family: 4 },
    }
    const resolve = vi.fn(async (host) => [answers[host]])
    const pinned = []
    const fetchImpl = vi.fn(async (url, init) => {
      const host = new URL(url).hostname
      pinned.push(await new Promise((resolveLookup, rejectLookup) => {
        init.agent.options.lookup(host, {}, (error, address, family) => {
          if (error) rejectLookup(error)
          else resolveLookup({ host, address, family })
        })
      }))

      if (host === 'org.example') {
        return new Response(
          '<html><head><meta property="og:image" content="https://cdn.example/logo.png"></head></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        )
      }
      return new Response(PNG_BYTES, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    })

    const result = await fetchOrgLogo('https://org.example/', { resolve, fetchImpl })

    expect(result.ok).toBe(true)
    expect(result.sourceUrl).toBe('https://cdn.example/logo.png')
    expect(pinned).toEqual([
      { host: 'org.example', address: '93.184.216.34', family: 4 },
      { host: 'cdn.example', address: '93.184.216.35', family: 4 },
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
