/**
 * Yana contact-enrichment HTML fetcher must not follow redirects into private
 * or link-local space. makeHtmlFetcher previously used redirect:'follow' with
 * no hop re-check — the same validate-then-follow SSRF class as headForVerification.
 */
import { describe, it, expect, vi } from 'vitest'
import { makeHtmlFetcher } from '../services/yana/webSearchProvider.js'

const PUBLIC_URL = 'http://93.184.216.34/'
const METADATA_URL = 'http://169.254.169.254/latest/meta-data/'

describe('makeHtmlFetcher — SSRF redirect guard', () => {
  it('refuses a direct private/metadata URL without fetching', async () => {
    const fetchImpl = vi.fn()
    const assertSafeUrl = vi.fn(async () => ({ ok: false, reason: 'private_ip:169.254.169.254' }))
    const fetcher = makeHtmlFetcher({ fetchImpl, assertSafeUrl })

    const html = await fetcher(METADATA_URL)

    expect(html).toBe('')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(assertSafeUrl).toHaveBeenCalledWith(METADATA_URL)
  })

  it('blocks a redirect into cloud metadata', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: { get: (k) => (String(k).toLowerCase() === 'location' ? METADATA_URL : null) },
    })
    const assertSafeUrl = vi.fn(async (url) => {
      if (url === PUBLIC_URL) return { ok: true }
      return { ok: false, reason: 'private_ip:169.254.169.254' }
    })
    const fetcher = makeHtmlFetcher({ fetchImpl, assertSafeUrl })

    const html = await fetcher(PUBLIC_URL)

    expect(html).toBe('')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual')
    expect(assertSafeUrl).toHaveBeenCalledWith(PUBLIC_URL)
    expect(assertSafeUrl).toHaveBeenCalledWith(METADATA_URL)
  })

  it('returns HTML from a healthy public page', async () => {
    const body = '<html><body>Hello</body></html>'
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'text/html' : null) },
      arrayBuffer: async () => Buffer.from(body),
    })
    const assertSafeUrl = vi.fn(async () => ({ ok: true }))
    const fetcher = makeHtmlFetcher({ fetchImpl, assertSafeUrl })

    const html = await fetcher(PUBLIC_URL)

    expect(html).toBe(body)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
