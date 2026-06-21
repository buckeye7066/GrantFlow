/**
 * Unit tests for the self-hosted SearXNG search provider (searxngProvider.js).
 *
 * Covers endpoint construction, JSON parse + normalization, result hygiene
 * (http(s)-only, de-dupe, count cap), and graceful failure (no throws). The
 * HTTP client is mocked — no network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const getWithRetryMock = vi.fn()

vi.mock('../services/crawlers/httpClient.js', () => ({
  getWithRetry: (...a) => getWithRetryMock(...a),
}))

const { makeSearxngProvider } = await import('../services/crawlers/searxngProvider.js')

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
})
