/**
 * Guard: avatar_lookup must not validate-then-follow into private/metadata IPs.
 *
 * A public first hop that 302s to http://169.254.169.254/ used to be followed
 * inside undici (redirect:'follow') after only the first hostname was checked.
 */
import http from 'http'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { safeAvatarFetch, processAvatarLookupJob } from '../services/avatarCrawler.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PNG_BYTES = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 9)])

describe('avatarCrawler SSRF redirect guard', () => {
  let redirectServer
  let goodServer
  let redirectPort
  let goodPort
  let uploadDir
  let metadataHits = 0

  beforeAll(async () => {
    uploadDir = mkdtempSync(join(tmpdir(), 'avatar-ssrf-'))

    // "Attacker" page: 302 -> link-local metadata IP.
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

    // Benign site with og:image that itself redirects to metadata.
    goodServer = http.createServer((req, res) => {
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html')
        res.end(
          `<html><head><meta property="og:image" content="http://127.0.0.1:${redirectPort}/cover-redirect"></head></html>`,
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

  it('blocks a redirect hop into 169.254.169.254 (does not follow)', async () => {
    const result = await safeAvatarFetch(`http://127.0.0.1:${redirectPort}/r`, 'text/html', {
      allowLocalhost: true,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('blocked_private_host')
    expect(metadataHits).toBe(0)
  })

  it('blocks a public hostname whose DNS resolves to a private/metadata IP', async () => {
    // 0563eb97 closed literal-IP redirect follow, but hostname-string checks
    // alone still admitted evil.example → 169.254.169.254. The hop guard must
    // consult DNS (assertSsrfSafeUrl); inject the refusal here so the test is
    // hermetic and does not depend on real resolver data.
    let checked = []
    const result = await safeAvatarFetch('http://evil.example/latest/meta-data/', 'text/html', {
      assertSafeUrl: async (url) => {
        checked.push(url)
        return { ok: false, reason: 'resolves_private:169.254.169.254' }
      },
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('blocked_private_host')
    expect(checked).toEqual(['http://evil.example/latest/meta-data/'])
    expect(metadataHits).toBe(0)
  })

  it('re-checks DNS on every redirect hop (not only the first URL)', async () => {
    const checked = []
    const result = await safeAvatarFetch(`http://127.0.0.1:${redirectPort}/r`, 'text/html', {
      allowLocalhost: true,
      assertSafeUrl: async (url) => {
        checked.push(url)
        // First hop is the public redirector (allowed via allowLocalhost);
        // the Location target must still be refused when DNS says private.
        if (String(url).includes('169.254.169.254')) {
          return { ok: false, reason: 'private_ip:169.254.169.254' }
        }
        return { ok: true }
      },
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('blocked_private_host')
    expect(checked.some((u) => String(u).includes('169.254.169.254'))).toBe(true)
    expect(metadataHits).toBe(0)
  })

  it('blocks a website cover whose image URL redirects to a private host', async () => {
    const result = await processAvatarLookupJob({
      profileContext: {
        profile: { id: 'p1', display_name: 'Test Org', primary_type: 'nonprofit' },
        website_hint: `http://127.0.0.1:${goodPort}/`,
      },
      uploadDir,
      getOpenAI: () => null,
      job: { parameters: {} },
    })
    // Cosmetics path: job must not crash, and must not return a successful avatar
    // pulled through a metadata redirect.
    expect(result.inserted).toBe(0)
    expect(result.result_meta?.ok).toBe(false)
  })

  it('still fetches a same-origin public redirect chain when every hop is safe', async () => {
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
      const result = await safeAvatarFetch(`http://127.0.0.1:${port}/start`, 'image/*', {
        allowLocalhost: true,
      })
      expect(result.ok).toBe(true)
      expect(result.res.ok).toBe(true)
      expect(result.finalUrl).toBe(`http://127.0.0.1:${port}/ok.png`)
      const buf = Buffer.from(await result.res.arrayBuffer())
      expect(buf.length).toBe(PNG_BYTES.length)
    } finally {
      await new Promise((resolve) => chainServer.close(resolve))
    }
  })
})
