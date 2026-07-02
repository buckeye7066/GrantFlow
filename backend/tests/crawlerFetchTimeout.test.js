import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchWithTimeout } from '../services/crawlerOsService.js'

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
})
