// Live incident 2026-09-11: SAM.gov answered a spent daily quota with HTTP 429 and
// `Retry-After: <next UTC midnight>`. requestJson slept that date (~3h) inside the
// request, the shared SAM catalog promise never settled, and every
// GET /api/foundations/federal/search timed out at 30s with nothing logged.
import { afterEach, describe, expect, it } from 'vitest'
import { __resetAxiosForTests, __setAxiosForTests, requestJson } from '../src/integrations/httpClient.js'
import {
  __resetAssistanceCatalogCacheForTests,
  fetchAssistanceListings,
} from '../src/integrations/samAssistanceListings.js'

const THREE_HOURS_MS = 3 * 60 * 60 * 1000

const quotaSpent = (calls) => async (config) => {
  calls.push(config)
  return {
    status: 429,
    headers: { 'retry-after': new Date(Date.now() + THREE_HOURS_MS).toUTCString() },
    data: { code: '900804', message: 'Message throttled out' },
  }
}

afterEach(() => {
  __resetAxiosForTests()
  __resetAssistanceCatalogCacheForTests()
})

describe('requestJson Retry-After cap', () => {
  it('fails at once with the retry time when Retry-After is hours away', async () => {
    const calls = []
    __setAxiosForTests(quotaSpent(calls))
    const started = Date.now()
    const error = await requestJson({ url: 'https://api.sam.gov/x', provider: 'sam.test', maxRetries: 2 }).catch((e) => e)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(calls).toHaveLength(1)
    expect(error.response.status).toBe(429)
    expect(Date.parse(error.retryAt) - Date.now()).toBeGreaterThan(2 * 60 * 60 * 1000)
  }, 5000)

  it('still waits out a short Retry-After and retries', async () => {
    let calls = 0
    __setAxiosForTests(async () => (++calls === 1
      ? { status: 429, headers: { 'retry-after': '0' }, data: {} }
      : { status: 200, headers: {}, data: { ok: true } }))
    await expect(requestJson({ url: 'https://api.sam.gov/x', maxRetries: 2 })).resolves.toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  it('a spent SAM quota fails the federal catalog search fast instead of hanging', async () => {
    process.env.SAM_GOV_PUBLIC_API_KEY = 'test-key'
    const calls = []
    __setAxiosForTests(quotaSpent(calls))
    const error = await fetchAssistanceListings({ keyword: 'housing' }).catch((e) => e)
    expect(error.response.status).toBe(429)
    expect(error.retryAt).toBeTruthy()
    expect(calls).toHaveLength(1)
  }, 5000)
})
