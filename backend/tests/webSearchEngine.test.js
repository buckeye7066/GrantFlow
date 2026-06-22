/**
 * Unit tests for the shared web-search engine (webSearchEngine.js).
 *
 * Verifies the two back-ends: Brave (used when BRAVE_SEARCH_API_KEY is set) and
 * the keyless DuckDuckGo HTML fallback, plus result hygiene (uddg redirect
 * unwrapping, skip-host filtering) and graceful failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getWithRetryMock = vi.fn()
const braveSearchFn = vi.fn()
const makeBraveMock = vi.fn(() => braveSearchFn)
const searxngSearchFn = vi.fn()
const makeSearxngMock = vi.fn(() => searxngSearchFn)

vi.mock('../services/shared/httpClient.js', () => ({
  getWithRetry: (...a) => getWithRetryMock(...a),
}))
vi.mock('../services/yana/webSearchProvider.js', () => ({
  makeBraveSearchProvider: (...a) => makeBraveMock(...a),
}))
vi.mock('../services/shared/searxngProvider.js', () => ({
  makeSearxngProvider: (...a) => makeSearxngMock(...a),
}))

const { searchWeb, _resetWebSearchEngineForTests } = await import(
  '../services/shared/webSearchEngine.js'
)

// Minimal DuckDuckGo HTML: one real result (via uddg redirect) + one social
// host that must be filtered out.
const DDG_HTML = `
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbradleyfoundation.org%2Fgrants">Bradley Foundation Grants</a>
    <div class="result__snippet">Local scholarships and grants</div>
  </div>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.facebook.com%2Fsomepage">Facebook</a>
    <div class="result__snippet">social</div>
  </div>
`

beforeEach(() => {
  getWithRetryMock.mockReset()
  braveSearchFn.mockReset()
  makeBraveMock.mockClear()
  searxngSearchFn.mockReset()
  makeSearxngMock.mockClear()
  delete process.env.BRAVE_SEARCH_API_KEY
  delete process.env.SEARXNG_URL
  _resetWebSearchEngineForTests()
})

afterEach(() => {
  delete process.env.BRAVE_SEARCH_API_KEY
  delete process.env.SEARXNG_URL
  _resetWebSearchEngineForTests()
})

describe('searchWeb (DuckDuckGo fallback, no key)', () => {
  it('parses results, unwraps uddg redirects, and drops social hosts', async () => {
    getWithRetryMock.mockResolvedValue({ data: DDG_HTML })
    const results = await searchWeb('"Bradley County" scholarship')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://bradleyfoundation.org/grants')
    expect(results[0].title).toBe('Bradley Foundation Grants')
    expect(makeBraveMock).not.toHaveBeenCalled() // no key → Brave never constructed
  })

  it('returns [] (no throw) when the fetch fails', async () => {
    getWithRetryMock.mockRejectedValue(new Error('timeout'))
    const results = await searchWeb('anything')
    expect(results).toEqual([])
  })

  it('returns [] for an empty query without hitting the network', async () => {
    const results = await searchWeb('   ')
    expect(results).toEqual([])
    expect(getWithRetryMock).not.toHaveBeenCalled()
  })
})

describe('searchWeb (Brave, when keyed)', () => {
  it('prefers Brave and normalizes its results', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'test-key'
    _resetWebSearchEngineForTests()
    braveSearchFn.mockResolvedValue([
      { url: 'https://example.org/a', title: 'A', snippet: 'desc a' },
      { url: 'https://facebook.com/x', title: 'social', snippet: '' }, // filtered
    ])

    const results = await searchWeb('local grant')
    expect(makeBraveMock).toHaveBeenCalled()
    expect(results.map((r) => r.url)).toEqual(['https://example.org/a'])
    expect(getWithRetryMock).not.toHaveBeenCalled() // Brave satisfied it; no DDG
  })

  it('falls back to DuckDuckGo when Brave throws', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'test-key'
    _resetWebSearchEngineForTests()
    braveSearchFn.mockRejectedValue(new Error('brave 500'))
    getWithRetryMock.mockResolvedValue({ data: DDG_HTML })

    const results = await searchWeb('local grant')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://bradleyfoundation.org/grants')
  })
})

describe('searchWeb (SearXNG primary + provider chain)', () => {
  it('prefers SearXNG over Brave and DuckDuckGo when SEARXNG_URL is set', async () => {
    process.env.SEARXNG_URL = 'https://searx.example.com'
    process.env.BRAVE_SEARCH_API_KEY = 'test-key'
    _resetWebSearchEngineForTests()
    searxngSearchFn.mockResolvedValue([
      { url: 'https://county.gov/scholarship', title: 'County Scholarship', snippet: 'apply' },
      { url: 'https://facebook.com/x', title: 'social', snippet: '' }, // filtered
    ])

    const results = await searchWeb('"Bradley County" scholarship')
    expect(makeSearxngMock).toHaveBeenCalled()
    expect(results.map((r) => r.url)).toEqual(['https://county.gov/scholarship'])
    expect(braveSearchFn).not.toHaveBeenCalled() // SearXNG satisfied it; no Brave
    expect(getWithRetryMock).not.toHaveBeenCalled() // and no DDG
  })

  it('falls back to Brave when SearXNG returns nothing', async () => {
    process.env.SEARXNG_URL = 'https://searx.example.com'
    process.env.BRAVE_SEARCH_API_KEY = 'test-key'
    _resetWebSearchEngineForTests()
    searxngSearchFn.mockResolvedValue([]) // empty → chain continues
    braveSearchFn.mockResolvedValue([{ url: 'https://example.org/a', title: 'A', snippet: 'desc a' }])

    const results = await searchWeb('local grant')
    expect(searxngSearchFn).toHaveBeenCalled()
    expect(braveSearchFn).toHaveBeenCalled()
    expect(results.map((r) => r.url)).toEqual(['https://example.org/a'])
  })

  it('falls back to DuckDuckGo when SearXNG throws and Brave is not keyed', async () => {
    process.env.SEARXNG_URL = 'https://searx.example.com'
    _resetWebSearchEngineForTests()
    searxngSearchFn.mockRejectedValue(new Error('searxng down'))
    getWithRetryMock.mockResolvedValue({ data: DDG_HTML })

    const results = await searchWeb('local grant')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://bradleyfoundation.org/grants')
    expect(makeBraveMock).not.toHaveBeenCalled() // no Brave key
  })
})
