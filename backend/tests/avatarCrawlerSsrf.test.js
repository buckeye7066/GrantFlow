/**
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

  it('blocks a redirect hop into cloud metadata before a second request', async () => {
    const result = await safeAvatarFetch(
      `http://127.0.0.1:${redirectPort}/r`,
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
        website_hint: `http://127.0.0.1:${goodPort}/`,
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
        `http://127.0.0.1:${port}/start`,
        'image/*',
        { allowLocalhost: true },
      )
      expect(result.ok).toBe(true)
      expect(result.res.ok).toBe(true)
      expect(result.finalUrl).toBe(`http://127.0.0.1:${port}/ok.png`)
    } finally {
      await new Promise((resolve) => chainServer.close(resolve))
    }
  })
})
