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

vi.mock('../services/crawlers/httpClient.js', () => ({
  getWithRetry: (...a) => getWithRetryMock(...a),
}))
vi.mock('../services/yana/webSearchProvider.js', () => ({
  makeBraveSearchProvider: (...a) => makeBraveMock(...a),
}))

const { searchWeb, _resetWebSearchEngineForTests } = await import(
  '../services/crawlers/webSearchEngine.js'
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
  delete process.env.BRAVE_SEARCH_API_KEY
  _resetWebSearchEngineForTests()
})

afterEach(() => {
  delete process.env.BRAVE_SEARCH_API_KEY
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
