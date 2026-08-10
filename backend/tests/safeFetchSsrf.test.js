/**
 * Regression tests for the outbound egress chokepoint.
 */
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  safeFetch,
  safeFetchOrNull,
  SsrfBlockedError,
  readTextCapped,
  readBufferCapped,
  discardResponseBody,
  mergeAbortSignals,
} from '../services/http/safeFetch.js'

const PUBLIC_URL = 'http://93.184.216.34/start'
const METADATA_URL = 'http://169.254.169.254/latest/meta-data/'
const INTERNAL_URL = 'http://192.168.1.10/admin'

function redirectTo(location, body = null) {
  return {
    status: 302,
    headers: { get: (name) => name.toLowerCase() === 'location' ? location : null },
    body,
  }
}

function abortAwareFetch() {
  return vi.fn((_url, init = {}) => new Promise((resolve, reject) => {
    const rejectAbort = () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (init.signal?.aborted) {
      rejectAbort()
      return
    }
    init.signal?.addEventListener('abort', rejectAbort, { once: true })
    void resolve
  }))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('safeFetch SSRF guard', () => {
  it('refuses a direct request to cloud metadata without touching the network', async () => {
    const fetchMock = vi.fn()

    await expect(safeFetch(METADATA_URL, {}, { fetchImpl: fetchMock }))
      .rejects.toBeInstanceOf(SsrfBlockedError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a direct request to an RFC1918 host', async () => {
    const fetchMock = vi.fn()

    await expect(safeFetch(INTERNAL_URL, {}, { fetchImpl: fetchMock }))
      .rejects.toBeInstanceOf(SsrfBlockedError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a non-http scheme', async () => {
    const fetchMock = vi.fn()

    await expect(safeFetch('file:///etc/passwd', {}, { fetchImpl: fetchMock }))
      .rejects.toBeInstanceOf(SsrfBlockedError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('blocks a redirect into cloud metadata and releases the redirect body', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const fetchMock = vi.fn().mockResolvedValueOnce(
      redirectTo(METADATA_URL, { cancel }),
    )

    await expect(safeFetch(PUBLIC_URL, {}, { fetchImpl: fetchMock }))
      .rejects.toBeInstanceOf(SsrfBlockedError)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('blocks a redirect into an RFC1918 host', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirectTo(INTERNAL_URL))

    await expect(safeFetch(PUBLIC_URL, {}, { fetchImpl: fetchMock }))
      .rejects.toBeInstanceOf(SsrfBlockedError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never delegates redirect handling to the fetch implementation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))

    await safeFetch(PUBLIC_URL, { redirect: 'follow' }, { fetchImpl: fetchMock })

    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual')
  })

  it('converts POST to GET on a 303 and removes body headers', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        status: 303,
        headers: { get: (name) => name.toLowerCase() === 'location' ? '/complete' : null },
        body: { cancel: vi.fn().mockResolvedValue(undefined) },
      })
      .mockResolvedValueOnce(new Response('done', { status: 200 }))

    await safeFetch(PUBLIC_URL, {
      method: 'POST',
      body: 'secret=form',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': '11',
        accept: 'text/plain',
      },
    }, { fetchImpl: fetchMock })

    const secondInit = fetchMock.mock.calls[1][1]
    expect(secondInit.method).toBe('GET')
    expect(secondInit.body).toBeUndefined()
    expect(secondInit.headers['content-type']).toBeUndefined()
    expect(secondInit.headers['content-length']).toBeUndefined()
    expect(secondInit.headers.accept).toBe('text/plain')
  })

  it('strips credentials on a cross-origin redirect', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirectTo('http://93.184.216.35/next'))
      .mockResolvedValueOnce(new Response('done', { status: 200 }))

    await safeFetch(PUBLIC_URL, {
      headers: {
        Authorization: 'Bearer should-not-cross-origins',
        Cookie: 'session=should-not-cross-origins',
        Accept: 'text/html',
      },
    }, { fetchImpl: fetchMock })

    const secondHeaders = fetchMock.mock.calls[1][1].headers
    expect(secondHeaders.authorization).toBeUndefined()
    expect(secondHeaders.cookie).toBeUndefined()
    expect(secondHeaders.accept).toBe('text/html')
  })

  it('preserves credentials on a same-origin redirect', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirectTo('/next'))
      .mockResolvedValueOnce(new Response('done', { status: 200 }))

    await safeFetch(PUBLIC_URL, {
      headers: {
        Authorization: 'Bearer same-origin',
        Cookie: 'session=same-origin',
      },
    }, { fetchImpl: fetchMock })

    const secondHeaders = fetchMock.mock.calls[1][1].headers
    expect(secondHeaders.authorization).toBe('Bearer same-origin')
    expect(secondHeaders.cookie).toBe('session=same-origin')
  })

  it('follows a redirect to another public host and returns the final response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirectTo('http://93.184.216.35/next'))
      .mockResolvedValueOnce(new Response('done', { status: 200 }))

    const res = await safeFetch(PUBLIC_URL, {}, { fetchImpl: fetchMock })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.grantflowFinalUrl).toBe('http://93.184.216.35/next')
  })

  it('resolves relative redirects against the current hop', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirectTo('/second'))
      .mockResolvedValueOnce(new Response('done', { status: 200 }))

    await safeFetch(PUBLIC_URL, {}, { fetchImpl: fetchMock })

    expect(fetchMock.mock.calls[1][0]).toBe('http://93.184.216.34/second')
  })

  it('caps redirect chains and releases every discarded response', async () => {
    const bodies = []
    const fetchMock = vi.fn(() => {
      const body = { cancel: vi.fn().mockResolvedValue(undefined) }
      bodies.push(body)
      return Promise.resolve(redirectTo(PUBLIC_URL, body))
    })

    await expect(safeFetch(PUBLIC_URL, {}, { fetchImpl: fetchMock, maxRedirects: 3 }))
      .rejects.toThrow(/too_many_redirects/)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(bodies.every((body) => body.cancel.mock.calls.length === 1)).toBe(true)
  })

  it('omits TLS servername for an IP-literal URL', async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      expect(init.agent.options.servername).toBeUndefined()
      return new Response('ok', { status: 200 })
    })

    await safeFetch('https://93.184.216.34/start', {}, { fetchImpl: fetchMock })
  })

  it('keeps the original DNS hostname as TLS servername', async () => {
    const resolve = vi.fn().mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ])
    const fetchMock = vi.fn(async (_url, init) => {
      expect(init.agent.options.servername).toBe('tls.example')
      return new Response('ok', { status: 200 })
    })

    await safeFetch('https://tls.example/start', {}, { fetchImpl: fetchMock, resolve })
  })

  it('pins the policy-approved DNS answer into the transport agent', async () => {
    const resolve = vi.fn().mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ])
    let pinned
    const fetchMock = vi.fn(async (_url, init) => {
      pinned = await new Promise((resolveLookup, rejectLookup) => {
        init.agent.options.lookup('rebind.example', {}, (error, address, family) => {
          if (error) rejectLookup(error)
          else resolveLookup({ address, family })
        })
      })
      return new Response('ok', { status: 200 })
    })

    await safeFetch('https://rebind.example/start', {}, { fetchImpl: fetchMock, resolve })

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(pinned).toEqual({ address: '93.184.216.34', family: 4 })
  })

  it('rejects when any DNS answer is private', async () => {
    const fetchMock = vi.fn()
    const resolve = vi.fn().mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])

    await expect(safeFetch('https://mixed.example/', {}, { fetchImpl: fetchMock, resolve }))
      .rejects.toMatchObject({ reason: 'resolves_private:127.0.0.1' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns a 200 response through unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('hello', { status: 200 }))

    const res = await safeFetch(PUBLIC_URL, {}, { fetchImpl: fetchMock })
    expect(res.status).toBe(200)
    await expect(res.text()).resolves.toBe('hello')
  })

  it('safeFetchOrNull returns null for blocked URLs rather than throwing', async () => {
    await expect(safeFetchOrNull(METADATA_URL, {}, { fetchImpl: vi.fn() }))
      .resolves.toBeNull()
  })
})

describe('safeFetch cancellation', () => {
  it('preserves RequestInit cancellation', async () => {
    const controller = new AbortController()
    const pending = safeFetch(
      PUBLIC_URL,
      { signal: controller.signal },
      { fetchImpl: abortAwareFetch(), timeoutMs: 1000 },
    )
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('preserves opts.signal cancellation', async () => {
    const controller = new AbortController()
    const pending = safeFetch(
      PUBLIC_URL,
      {},
      { fetchImpl: abortAwareFetch(), signal: controller.signal, timeoutMs: 1000 },
    )
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('uses one end-to-end deadline across redirect hops', async () => {
    vi.useFakeTimers()
    const signals = []
    const fetchMock = vi.fn((_url, request = {}) => {
      signals.push(request.signal)
      if (signals.length === 1) {
        return new Promise((resolve) => {
          setTimeout(() => resolve(redirectTo('/second', {
            cancel: vi.fn().mockResolvedValue(undefined),
          })), 60)
        })
      }
      return new Promise((_resolve, reject) => {
        const rejectAbort = () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }
        if (request.signal?.aborted) rejectAbort()
        else request.signal?.addEventListener('abort', rejectAbort, { once: true })
      })
    })

    try {
      const pending = safeFetch(
        PUBLIC_URL,
        {},
        { fetchImpl: fetchMock, timeoutMs: 100 },
      )
      const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })

      await vi.advanceTimersByTimeAsync(60)
      for (let attempt = 0; attempt < 10 && fetchMock.mock.calls.length < 2; attempt += 1) {
        await Promise.resolve()
      }

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(signals[1]).toBe(signals[0])
      await vi.advanceTimersByTimeAsync(39)
      expect(signals[1].aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts at the configured timeout', async () => {
    await expect(safeFetch(
      PUBLIC_URL,
      {},
      { fetchImpl: abortAwareFetch(), timeoutMs: 5 },
    )).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('propagates every source through the AbortSignal.any fallback', () => {
    const first = new AbortController()
    const second = new AbortController()
    const merged = mergeAbortSignals([first.signal, second.signal], null)

    second.abort('caller cancellation')
    expect(merged.signal.aborted).toBe(true)
    expect(merged.signal.reason).toBe('caller cancellation')
    merged.cleanup()
  })
})

describe('response body cleanup and caps', () => {
  it('discards Web response bodies', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    await discardResponseBody({ body: { cancel } })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('truncates Web streams that exceed the cap', async () => {
    const big = 'x'.repeat(5000)
    const res = new Response(big, { status: 200 })
    const text = await readTextCapped(res, 100)
    expect(Buffer.byteLength(text)).toBe(100)
  })

  it('caps oversized Node streams incrementally and destroys them', async () => {
    const stream = Readable.from([
      Buffer.alloc(80, 'a'),
      Buffer.alloc(80, 'b'),
    ])
    const destroy = vi.spyOn(stream, 'destroy')

    const text = await readTextCapped({ body: stream }, 100)

    expect(Buffer.byteLength(text)).toBe(100)
    expect(destroy).toHaveBeenCalled()
  })

  it('caps Web binary bodies while reporting truncation', async () => {
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

  it('returns short bodies intact', async () => {
    const res = new Response('short', { status: 200 })
    await expect(readTextCapped(res, 1000)).resolves.toBe('short')
  })

  it('keeps status-only probes wired to explicit body cleanup', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url))
    const housing = fs.readFileSync(`${root}/backend/services/housingScholarshipCrawler.js`, 'utf8')
    const verifier = fs.readFileSync(`${root}/backend/services/linkVerificationService.js`, 'utf8')

    expect(housing).toMatch(/await discardResponseBody\(res\)/)
    expect(housing).toMatch(/await discardResponseBody\(res2\)/)
    expect(verifier).toMatch(/await discardResponseBody\(res\)/)
  })
})
