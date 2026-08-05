import { afterEach, describe, expect, it, vi } from 'vitest'

import { BROWSER_FETCH_HEADERS, fetchWithTimeout, makeProductionFetcher } from '../services/crawlerOsService.js'

/**
 * makeProductionFetcher is "the ONE network entry for live discovery". Native
 * fetch has no default deadline, so without this wrapper a single half-open
 * remote hangs runProfileDiscoveryLive forever and pins a crawl slot against
 * MAX_CONCURRENT_CRAWLERS. These tests pin the deadline behavior.
 */
describe('crawler fetchWithTimeout', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
    vi.unstubAllEnvs()
  })

  it('aborts a hung remote after CRAWLER_FETCH_TIMEOUT_MS', async () => {
    vi.stubEnv('CRAWLER_FETCH_TIMEOUT_MS', '60')
    // A remote that never responds — but honors the abort signal like undici does.
    globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal.reason))
      })
    const started = Date.now()
    await expect(fetchWithTimeout('https://example.org/hung')).rejects.toThrow(/timeout|abort/i)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('passes through a fast response untouched', async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200 })
    const res = await fetchWithTimeout('https://example.org/fast')
    expect(res.ok).toBe(true)
  })

  it('still honors a caller-provided AbortSignal', async () => {
    globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal.reason))
      })
    const controller = new AbortController()
    const pending = fetchWithTimeout('https://example.org/hung', { signal: controller.signal })
    controller.abort(new Error('caller aborted'))
    await expect(pending).rejects.toThrow('caller aborted')
  })

  // Browser-equivalent headers (owner-approved 2026-07-12): some official
  // sources' WAFs serve a fake 404 to non-browser clients (the
  // highered.ohio.gov / OCOG source_fetch_failed class).
  it('sends browser-equivalent headers by default', async () => {
    let seen
    globalThis.fetch = async (_url, init) => { seen = init; return { ok: true, status: 200 } }
    await fetchWithTimeout('https://example.org/page')
    const h = new Headers(seen.headers)
    expect(h.get('user-agent')).toBe(BROWSER_FETCH_HEADERS['User-Agent'])
    expect(h.get('accept')).toContain('text/html')
    expect(h.get('accept-language')).toContain('en-US')
  })

  it('caller-provided headers override the browser defaults (case-insensitive)', async () => {
    let seen
    globalThis.fetch = async (_url, init) => { seen = init; return { ok: true, status: 200 } }
    await fetchWithTimeout('https://example.org/api', {
      headers: { 'user-agent': 'GrantFlowApiClient/1.0', 'X-Api-Key': 'k123' },
    })
    const h = new Headers(seen.headers)
    expect(h.get('user-agent')).toBe('GrantFlowApiClient/1.0')
    expect(h.get('x-api-key')).toBe('k123')
    expect(h.get('accept-language')).toContain('en-US') // defaults still present
  })

  it('CRAWLER_BROWSER_HEADERS=0 disables the defaults (kill switch)', async () => {
    vi.stubEnv('CRAWLER_BROWSER_HEADERS', '0')
    let seen
    globalThis.fetch = async (_url, init) => { seen = init; return { ok: true, status: 200 } }
    await fetchWithTimeout('https://example.org/page', { headers: { 'X-Only': 'yes' } })
    const h = new Headers(seen.headers ?? {})
    expect(h.get('user-agent')).toBeNull()
    expect(h.get('x-only')).toBe('yes')
  })

  it('production enables one bounded retry for an idempotent transient response', async () => {
    vi.stubEnv('FEATURE_CRAWLER_RETRIES', 'true')
    let calls = 0
    globalThis.fetch = async (url) => {
      calls += 1
      const status = calls === 1 ? 503 : 200
      return {
        ok: status === 200,
        status,
        url,
        headers: { get: () => null },
        async text() { return status === 200 ? 'recovered' : 'busy' },
      }
    }
    const fetcher = makeProductionFetcher({
      resolve: async () => ['8.8.8.8'],
      rateMs: 0,
      retryBaseMs: 0,
    })

    const result = await fetcher.fetch('https://example.org/transient')
    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    expect(result.retries).toBe(1)
    expect(calls).toBe(2)
  })

  it('FEATURE_CRAWLER_RETRIES=false disables the production retry kill switch', async () => {
    vi.stubEnv('FEATURE_CRAWLER_RETRIES', 'false')
    let calls = 0
    globalThis.fetch = async (url) => {
      calls += 1
      return {
        ok: false,
        status: 503,
        url,
        headers: { get: () => null },
        async text() { return 'busy' },
      }
    }
    const fetcher = makeProductionFetcher({
      resolve: async () => ['8.8.8.8'],
      rateMs: 0,
      retryBaseMs: 0,
    })

    const result = await fetcher.fetch('https://example.org/transient')
    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(1)
    expect(result.retries).toBe(0)
    expect(result.retrySuppressed).toBe('retry_limit_reached')
    expect(calls).toBe(1)
  })
})
