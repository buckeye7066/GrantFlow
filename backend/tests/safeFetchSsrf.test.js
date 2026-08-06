/**
 * Regression tests for the outbound egress chokepoint.
 *
 * The critical case is `blocks a redirect into cloud metadata`. Validating the
 * first URL and then fetching with `redirect: 'follow'` LOOKS like an SSRF fix
 * and is not one: the attacker simply answers 302 -> 169.254.169.254 and the
 * redirect is followed inside undici, where the guard never runs. That test
 * fails against the old validate-then-follow pattern and passes only when every
 * hop is re-validated.
 *
 * All hosts here are IP literals so assertSsrfSafeUrl short-circuits before any
 * DNS lookup — these tests do no network I/O and are hermetic.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  safeFetch,
  safeFetchOrNull,
  SsrfBlockedError,
  readTextCapped,
} from '../services/http/safeFetch.js'

// 93.184.216.34 is a public address (example.com); isPrivateIp() returns false.
const PUBLIC_URL = 'http://93.184.216.34/start'
const METADATA_URL = 'http://169.254.169.254/latest/meta-data/'
const INTERNAL_URL = 'http://192.168.1.10/admin'

function redirectTo(location) {
  return new Response(null, { status: 302, headers: { location } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('safeFetch SSRF guard', () => {
  it('refuses a direct request to cloud metadata without touching the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(safeFetch(METADATA_URL)).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a direct request to an RFC1918 host', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(safeFetch(INTERNAL_URL)).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a non-http scheme', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(safeFetch('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('blocks a redirect into cloud metadata (the validate-then-follow bypass)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirectTo(METADATA_URL))
    vi.stubGlobal('fetch', fetchMock)

    await expect(safeFetch(PUBLIC_URL)).rejects.toBeInstanceOf(SsrfBlockedError)

    // The public first hop is allowed; the metadata hop must never be requested.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(PUBLIC_URL)
  })

  it('blocks a redirect into an RFC1918 host', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirectTo(INTERNAL_URL))
    vi.stubGlobal('fetch', fetchMock)

    await expect(safeFetch(PUBLIC_URL)).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never delegates redirect handling to the fetch implementation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await safeFetch(PUBLIC_URL, { redirect: 'follow' })

    // Caller asked for 'follow'; the chokepoint must override it.
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual')
  })

  it('follows a redirect to another public host and returns the final response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirectTo('http://93.184.216.35/next'))
      .mockResolvedValueOnce(new Response('done', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await safeFetch(PUBLIC_URL)

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.grantflowFinalUrl).toBe('http://93.184.216.35/next')
  })

  it('resolves relative redirects against the current hop', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirectTo('/second'))
      .mockResolvedValueOnce(new Response('done', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await safeFetch(PUBLIC_URL)

    expect(fetchMock.mock.calls[1][0]).toBe('http://93.184.216.34/second')
  })

  it('caps redirect chains instead of looping forever', async () => {
    const fetchMock = vi.fn().mockResolvedValue(redirectTo(PUBLIC_URL))
    vi.stubGlobal('fetch', fetchMock)

    await expect(safeFetch(PUBLIC_URL, {}, { maxRedirects: 3 }))
      .rejects.toThrow(/too_many_redirects/)
    expect(fetchMock).toHaveBeenCalledTimes(4) // initial + 3 redirects
  })

  it('returns a 200 response through unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('hello', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await safeFetch(PUBLIC_URL)
    expect(res.status).toBe(200)
    await expect(res.text()).resolves.toBe('hello')
  })

  it('safeFetchOrNull returns null for blocked URLs rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await expect(safeFetchOrNull(METADATA_URL)).resolves.toBeNull()
  })
})

describe('readTextCapped', () => {
  it('truncates bodies that exceed the cap', async () => {
    const big = 'x'.repeat(5000)
    const res = new Response(big, { status: 200 })
    const text = await readTextCapped(res, 100)
    expect(text.length).toBe(100)
  })

  it('returns short bodies intact', async () => {
    const res = new Response('short', { status: 200 })
    await expect(readTextCapped(res, 1000)).resolves.toBe('short')
  })
})
