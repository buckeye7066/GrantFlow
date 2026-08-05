/**
 * googleCseProvider — the official Google Custom Search JSON API rung.
 * Contract (mirrors makeSearxngProvider / makeBraveSearchProvider):
 *   1. Construction THROWS without GOOGLE_CSE_KEY + GOOGLE_CSE_CX — an
 *      unconfigured provider must be absent, never half-alive.
 *   2. Results are normalized [{url,title,snippet}], deduped by lowercased
 *      URL, capped at the API's hard num=10.
 *   3. A 403/429 quota/authorization refusal THROWS `code:'google_quota'`
 *      (the ladder's degrade-until-UTC-midnight signal).
 *   4. Every OTHER failure (transport throw, non-200, unparseable body)
 *      returns [] — failure-tolerant like the rest of the ladder.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const getWithRetryMock = vi.fn()
vi.mock('../services/shared/httpClient.js', () => ({
  getWithRetry: (...a) => getWithRetryMock(...a),
}))

const { makeGoogleCseProvider } = await import('../services/shared/googleCseProvider.js')

const envKeys = ['GOOGLE_CSE_KEY', 'GOOGLE_CSE_CX']
const savedEnv = {}
beforeEach(() => {
  for (const k of envKeys) { savedEnv[k] = process.env[k]; delete process.env[k] }
  getWithRetryMock.mockReset()
})
afterEach(() => {
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

function configure() {
  process.env.GOOGLE_CSE_KEY = 'test-google-key'
  process.env.GOOGLE_CSE_CX = 'test-cx-id'
}

function apiResponse(items, status = 200) {
  return { status, data: { items } }
}

describe('construction', () => {
  it('throws without GOOGLE_CSE_KEY and GOOGLE_CSE_CX', () => {
    expect(() => makeGoogleCseProvider()).toThrow(/GOOGLE_CSE_KEY/)
  })

  it('throws when only ONE of the two is set', () => {
    process.env.GOOGLE_CSE_KEY = 'k'
    expect(() => makeGoogleCseProvider()).toThrow(/GOOGLE_CSE_CX/)
    delete process.env.GOOGLE_CSE_KEY
    process.env.GOOGLE_CSE_CX = 'cx'
    expect(() => makeGoogleCseProvider()).toThrow(/GOOGLE_CSE_KEY/)
  })

  it('throws on whitespace-only values (a blank env var is not config)', () => {
    process.env.GOOGLE_CSE_KEY = '   '
    process.env.GOOGLE_CSE_CX = 'cx'
    expect(() => makeGoogleCseProvider()).toThrow()
  })

  it('constructs when both are set', () => {
    configure()
    expect(() => makeGoogleCseProvider()).not.toThrow()
  })
})

describe('the happy path', () => {
  it('normalizes items to {url,title,snippet} and passes key/cx/q/num on the request', async () => {
    configure()
    const search = makeGoogleCseProvider({ count: 5 })
    getWithRetryMock.mockResolvedValue(apiResponse([
      { link: 'https://tn.gov/collegepays', title: '  TN HOPE Scholarship  ', snippet: ' state aid ' },
      { link: 'https://bradleyfoundation.org/grants', title: 'Bradley Foundation', snippet: 'grants' },
    ]))

    const results = await search({ query: 'TN HOPE scholarship' })
    expect(results).toEqual([
      { url: 'https://tn.gov/collegepays', title: 'TN HOPE Scholarship', snippet: 'state aid' },
      { url: 'https://bradleyfoundation.org/grants', title: 'Bradley Foundation', snippet: 'grants' },
    ])

    expect(getWithRetryMock).toHaveBeenCalledTimes(1)
    const [url, , opts] = getWithRetryMock.mock.calls[0]
    expect(url).toContain('https://www.googleapis.com/customsearch/v1')
    expect(url).toContain('key=test-google-key')
    expect(url).toContain('cx=test-cx-id')
    expect(url).toContain(`q=${encodeURIComponent('TN HOPE scholarship')}`)
    expect(url).toContain('num=5')
    // retries:0 — a quota refusal is stable for the UTC day; a transient 5xx
    // falls through to SearXNG. Retrying here only spends ladder latency.
    expect(opts).toMatchObject({ retries: 0 })
  })

  it('caps num at the API hard limit of 10 (constructor count AND per-call count)', async () => {
    configure()
    const search = makeGoogleCseProvider({ count: 25 })
    getWithRetryMock.mockResolvedValue(apiResponse([]))
    await search({ query: 'q' })
    expect(getWithRetryMock.mock.calls[0][0]).toContain('num=10')

    getWithRetryMock.mockClear()
    await search({ query: 'q', count: 50 })
    expect(getWithRetryMock.mock.calls[0][0]).toContain('num=10')
  })

  it('parses a STRING body as JSON', async () => {
    configure()
    const search = makeGoogleCseProvider()
    getWithRetryMock.mockResolvedValue({
      status: 200,
      data: JSON.stringify({ items: [{ link: 'https://example.org/a', title: 'A', snippet: 's' }] }),
    })
    const results = await search({ query: 'q' })
    expect(results).toEqual([{ url: 'https://example.org/a', title: 'A', snippet: 's' }])
  })

  it('dedupes by lowercased URL (trailing slash included) and drops non-http links', async () => {
    configure()
    const search = makeGoogleCseProvider()
    getWithRetryMock.mockResolvedValue(apiResponse([
      { link: 'https://Example.org/Grants', title: 'A', snippet: '' },
      { link: 'https://example.org/grants/', title: 'dupe (case + trailing slash)', snippet: '' },
      { link: 'ftp://example.org/file', title: 'not http', snippet: '' },
      { link: '', title: 'no link', snippet: '' },
      { link: 'https://other.org/b', title: 'B', snippet: '' },
    ]))
    const results = await search({ query: 'q' })
    expect(results.map((r) => r.url)).toEqual(['https://Example.org/Grants', 'https://other.org/b'])
  })

  it('returns [] for an empty/blank query without touching the network', async () => {
    configure()
    const search = makeGoogleCseProvider()
    expect(await search({ query: '   ' })).toEqual([])
    expect(await search({})).toEqual([])
    expect(getWithRetryMock).not.toHaveBeenCalled()
  })
})

describe('the quota degrade signal (403/429 → code google_quota)', () => {
  it.each([403, 429])('a %i response THROWS with code google_quota and the API reason', async (status) => {
    configure()
    const search = makeGoogleCseProvider()
    getWithRetryMock.mockResolvedValue({
      status,
      data: { error: { errors: [{ reason: 'dailyLimitExceeded' }] } },
    })
    let thrown = null
    try { await search({ query: 'q' }) } catch (err) { thrown = err }
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown.code).toBe('google_quota')
    expect(thrown.status).toBe(status)
    expect(thrown.message).toContain('dailyLimitExceeded')
  })

  it('a 403 with an unparseable body still throws google_quota (detail degrades to http_403)', async () => {
    configure()
    const search = makeGoogleCseProvider()
    getWithRetryMock.mockResolvedValue({ status: 403, data: 'not json {{' })
    let thrown = null
    try { await search({ query: 'q' }) } catch (err) { thrown = err }
    expect(thrown?.code).toBe('google_quota')
    expect(thrown?.message).toContain('http_403')
  })
})

describe('failure tolerance (everything else → [])', () => {
  it('returns [] when the request itself throws', async () => {
    configure()
    const search = makeGoogleCseProvider()
    getWithRetryMock.mockRejectedValue(new Error('timeout of 8000ms exceeded'))
    expect(await search({ query: 'q' })).toEqual([])
  })

  it('returns [] on a non-200, non-quota status', async () => {
    configure()
    const search = makeGoogleCseProvider()
    getWithRetryMock.mockResolvedValue({ status: 500, data: 'server error' })
    expect(await search({ query: 'q' })).toEqual([])
  })

  it('returns [] on an unparseable 200 body', async () => {
    configure()
    const search = makeGoogleCseProvider()
    getWithRetryMock.mockResolvedValue({ status: 200, data: 'not json {{' })
    expect(await search({ query: 'q' })).toEqual([])
  })

  it('returns [] on a 200 body with no items array', async () => {
    configure()
    const search = makeGoogleCseProvider()
    getWithRetryMock.mockResolvedValue({ status: 200, data: { searchInformation: { totalResults: '0' } } })
    expect(await search({ query: 'q' })).toEqual([])
  })
})
