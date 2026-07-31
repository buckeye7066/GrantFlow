/**
 * Unit tests for the self-hosted SearXNG search provider (searxngProvider.js).
 *
 * Covers endpoint construction, JSON parse + normalization, result hygiene
 * (http(s)-only, de-dupe, count cap), and graceful failure (no throws). The
 * HTTP client is mocked — no network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const getWithRetryMock = vi.fn()

vi.mock('../services/shared/httpClient.js', () => ({
  getWithRetry: (...a) => getWithRetryMock(...a),
}))

const { makeSearxngProvider } = await import('../services/shared/searxngProvider.js')

const SEARXNG_JSON = {
  results: [
    { url: 'https://bradleyfoundation.org/grants', title: 'Bradley Foundation Grants', content: 'Local scholarships' },
    { url: 'https://bradleyfoundation.org/grants/', title: 'dup (trailing slash)', content: 'dup' }, // de-duped
    { url: 'ftp://nope.example/x', title: 'non-http', content: 'skip' }, // non-http dropped
    { url: 'https://example.org/b', title: 'B', snippet: 'via snippet field' },
  ],
}

beforeEach(() => {
  getWithRetryMock.mockReset()
})

describe('makeSearxngProvider', () => {
  it('throws when no base URL is configured', () => {
    expect(() => makeSearxngProvider({ baseUrl: '' })).toThrow(/SEARXNG_URL/)
  })

  it('builds the /search JSON endpoint and parses results', async () => {
    getWithRetryMock.mockResolvedValue({ status: 200, data: SEARXNG_JSON })
    const search = makeSearxngProvider({ baseUrl: 'https://searx.example.com' })
    const results = await search({ query: '"Bradley County" scholarship' })

    // Endpoint + JSON format requested.
    const calledUrl = getWithRetryMock.mock.calls[0][0]
    expect(calledUrl).toContain('https://searx.example.com/search?')
    expect(calledUrl).toContain('format=json')

    // Normalized, de-duped, non-http dropped, snippet/content both honored.
    expect(results.map((r) => r.url)).toEqual([
      'https://bradleyfoundation.org/grants',
      'https://example.org/b',
    ])
    expect(results[0].title).toBe('Bradley Foundation Grants')
    expect(results[0].snippet).toBe('Local scholarships')
    expect(results[1].snippet).toBe('via snippet field')
  })

  it('accepts a base URL that already includes /search', async () => {
    getWithRetryMock.mockResolvedValue({ status: 200, data: { results: [] } })
    const search = makeSearxngProvider({ baseUrl: 'https://searx.example.com/search/' })
    await search({ query: 'x' })
    expect(getWithRetryMock.mock.calls[0][0]).toContain('https://searx.example.com/search?')
  })

  it('honors the count cap', async () => {
    getWithRetryMock.mockResolvedValue({ status: 200, data: SEARXNG_JSON })
    const search = makeSearxngProvider({ baseUrl: 'https://searx.example.com', count: 1 })
    const results = await search({ query: 'grant' })
    expect(results).toHaveLength(1)
  })

  it('parses a string JSON body', async () => {
    getWithRetryMock.mockResolvedValue({ status: 200, data: JSON.stringify(SEARXNG_JSON) })
    const search = makeSearxngProvider({ baseUrl: 'https://searx.example.com' })
    const results = await search({ query: 'grant' })
    expect(results.length).toBeGreaterThan(0)
  })

  it('returns [] for an empty query without hitting the network', async () => {
    const search = makeSearxngProvider({ baseUrl: 'https://searx.example.com' })
    expect(await search({ query: '  ' })).toEqual([])
    expect(getWithRetryMock).not.toHaveBeenCalled()
  })

  it('returns [] (no throw) on a non-200 status', async () => {
    getWithRetryMock.mockResolvedValue({ status: 502, data: 'bad gateway' })
    const search = makeSearxngProvider({ baseUrl: 'https://searx.example.com' })
    expect(await search({ query: 'grant' })).toEqual([])
  })

  it('returns [] (no throw) when the request rejects', async () => {
    getWithRetryMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const search = makeSearxngProvider({ baseUrl: 'https://searx.example.com' })
    expect(await search({ query: 'grant' })).toEqual([])
  })

  it('returns [] when the body is not parseable JSON', async () => {
    getWithRetryMock.mockResolvedValue({ status: 200, data: '<html>not json</html>' })
    const search = makeSearxngProvider({ baseUrl: 'https://searx.example.com' })
    expect(await search({ query: 'grant' })).toEqual([])
  })

  /**
   * Relevance ranking BEFORE truncation.
   *
   * The live failure (prod SearXNG, measured 2026-07-31 over 8 profile-shaped
   * queries): the instance returns 30+ results, the caller wants 8, and the
   * provider filled those 8 by walking the engine's own ranking — which put
   * scraped bing/yahoo's first-word junk on top ("Ohio - Wikipedia", "Texas
   * Maps & Facts") while yandex/seznam's real funders sat below the cut.
   * 46.9% of every returned top-8 was junk, and EVERY query had enough real
   * results deeper in the same pool to fill the budget completely.
   *
   * These fail on the pre-fix provider, which truncated at `want` while
   * walking the raw order.
   */
  describe('relevance ranking before the count cap', () => {
    const QUERY = 'Tennessee disability housing grants'
    const junk = (n) => ({ url: `https://tnvacation.example/${n}`, title: `Visit Tennessee ${n}`, content: 'tourism' })
    const REAL_A = { url: 'https://tndisability.org/programs/small-grants/', title: 'Small Grants | Tennessee Disability Coalition', content: '' }
    const REAL_B = { url: 'https://thda.org/tn-housing-trust-fund', title: 'Tennessee Housing Trust Fund', content: '' }

    it('surfaces real sources buried BELOW the cut, and drops no budget', async () => {
      // 8 junk results ahead of 2 real ones; caller wants 4.
      const results = [...Array.from({ length: 8 }, (_, i) => junk(i)), REAL_A, REAL_B]
      getWithRetryMock.mockResolvedValue({ status: 200, data: { results } })
      const search = makeSearxngProvider({ baseUrl: 'https://searx.example.com' })
      const out = await search({ query: QUERY, count: 4 })

      expect(out).toHaveLength(4) // budget still filled
      // Both real sources are now IN the returned set; before the fix neither
      // could be, because both sat at raw positions 9 and 10.
      expect(out.map((r) => r.url)).toEqual(
        expect.arrayContaining([REAL_A.url, REAL_B.url]),
      )
      // ...and they lead it.
      expect(out[0].url).toBe(REAL_A.url)
      expect(out[1].url).toBe(REAL_B.url)
    })

    it('never shrinks a result set — all-weak results come back unchanged', async () => {
      const results = Array.from({ length: 5 }, (_, i) => junk(i))
      getWithRetryMock.mockResolvedValue({ status: 200, data: { results } })
      const search = makeSearxngProvider({ baseUrl: 'https://searx.example.com' })
      const out = await search({ query: QUERY, count: 4 })

      // Weak results are DEMOTED, never deleted: with nothing strong to
      // promote, the caller receives exactly what it received before the fix.
      expect(out).toHaveLength(4)
      expect(out.map((r) => r.url)).toEqual(results.slice(0, 4).map((r) => r.url))
    })

    it('leaves ordering alone for a query with fewer than 2 distinctive terms', async () => {
      const results = [junk(0), REAL_A]
      getWithRetryMock.mockResolvedValue({ status: 200, data: { results } })
      const search = makeSearxngProvider({ baseUrl: 'https://searx.example.com' })
      // 'scholarships' is a stopword -> 0 distinctive terms -> nothing to rank on.
      const out = await search({ query: 'scholarships', count: 2 })
      expect(out.map((r) => r.url)).toEqual([junk(0).url, REAL_A.url])
    })

    it('still reports engine telemetry gathered from the WHOLE pool', async () => {
      const results = [
        { ...junk(0), engines: ['bing'] },
        { ...REAL_A, engines: ['yandex'] },
      ]
      getWithRetryMock.mockResolvedValue({
        status: 200,
        data: { results, unresponsive_engines: [['brave', 'Suspended']] },
      })
      const search = makeSearxngProvider({ baseUrl: 'https://searx.example.com' })
      const out = await search({ query: QUERY, count: 1 })
      // Reordering must not narrow what looksEngineCollapse sees, or a
      // bing-only SERP could start reading as healthy.
      expect(out.searxngMeta.result_engines).toEqual(['bing', 'yandex'])
      expect(out.searxngMeta.unresponsive_engines).toEqual([{ engine: 'brave', reason: 'Suspended' }])
    })
  })
})
