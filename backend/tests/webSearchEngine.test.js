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
  // vitest.setup.js sets GRANTFLOW_TEST_RUNNER=1 so no test hits live web
  // search as a side effect. THIS file is the dedicated engine test — it
  // fully mocks the network (httpClient + both providers), so it opts back
  // in via the engine's explicit escape hatch to exercise the real paths.
  process.env.GRANTFLOW_ALLOW_LIVE_WEB_IN_TESTS = 'true'
  _resetWebSearchEngineForTests()
})

afterEach(() => {
  delete process.env.BRAVE_SEARCH_API_KEY
  delete process.env.SEARXNG_URL
  delete process.env.GRANTFLOW_ALLOW_LIVE_WEB_IN_TESTS
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

  it('trips a process-level breaker on a 202 block so later queries never re-probe', async () => {
    // First query hits the datacenter-IP block (non-200) → one network attempt.
    getWithRetryMock.mockResolvedValueOnce({ status: 202, data: '' })
    expect(await searchWeb('first query')).toEqual([])
    expect(getWithRetryMock).toHaveBeenCalledTimes(1)

    // Every subsequent query short-circuits: the breaker means NO more network
    // calls (this is the fix — the old code re-probed DDG, burning the timeout
    // on every query in a discovery run).
    expect(await searchWeb('second query')).toEqual([])
    expect(await searchWeb('third query')).toEqual([])
    expect(getWithRetryMock).toHaveBeenCalledTimes(1)
  })

  it('trips the breaker when the response has no result markup (anti-bot challenge)', async () => {
    getWithRetryMock.mockResolvedValueOnce({ status: 200, data: '<html>challenge, no results</html>' })
    expect(await searchWeb('first')).toEqual([])
    expect(await searchWeb('second')).toEqual([])
    expect(getWithRetryMock).toHaveBeenCalledTimes(1)
  })

  it('trips the breaker on a thrown timeout so later queries never re-probe', async () => {
    // The real datacenter-IP failure mode is a HANG (timeout throw), not a 202.
    // The old code caught the throw, returned [], but re-probed on every query —
    // so a discovery run paid N×8s. The breaker must trip on the throw too.
    getWithRetryMock.mockRejectedValueOnce(new Error('timeout of 8000ms exceeded'))
    expect(await searchWeb('first query')).toEqual([])
    expect(await searchWeb('second query')).toEqual([])
    expect(await searchWeb('third query')).toEqual([])
    expect(getWithRetryMock).toHaveBeenCalledTimes(1)
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
    // The result names BOTH distinctive query terms (Bradley + County) so the
    // degenerate-SERP gate reads it as on-topic — the healthy-primary case.
    searxngSearchFn.mockResolvedValue([
      { url: 'https://county.gov/scholarship', title: 'Bradley County Scholarship', snippet: 'apply' },
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

describe('the degenerate-SERP gate (SearXNG first-word collapse, 2026-07-27)', () => {
  // The REAL prod fixture: SearXNG's engine fleet collapsed to scraped bing,
  // which answered "Cleveland State Community College scholarships" with
  // Cleveland-Ohio TOURISM pages — a SERP for the query's first word only.
  const SCHOOL_QUERY = 'Cleveland State Community College scholarships'
  // The Wikipedia snippet REALLY says "state of Ohio" — the single
  // quasi-generic word "state" is why an any-one-term relevance test
  // under-fired on this very SERP (verified live 2026-07-27). The fixture
  // keeps it so a weakened gate fails these tests.
  const JUNK_SERP = [
    { url: 'https://en.wikipedia.org/wiki/Cleveland', title: 'Cleveland - Wikipedia', snippet: 'Cleveland is a city in the U.S. state of Ohio' },
    { url: 'https://www.thisiscleveland.com/', title: 'Things to Do, Events, Restaurants & Hotels', snippet: 'Cleveland vacation guide' },
    { url: 'https://travel.usnews.com/Cleveland_OH/Things_To_Do/', title: '14 Fun Things to Do in Cleveland, Ohio', snippet: 'travel' },
  ]
  const REAL_HIT = {
    url: 'https://clevelandstatecc.scholarships.ngwebsolutions.com/Scholarships/Search',
    title: 'Cleveland State Community College Foundation Scholarships',
    snippet: 'Browse available Foundation Scholarship awards',
  }

  it('looksDegenerateSerp: flags the real prod junk SERP', async () => {
    const { looksDegenerateSerp } = await import('../services/shared/webSearchEngine.js')
    expect(looksDegenerateSerp(SCHOOL_QUERY, JUNK_SERP)).toBe(true)
  })

  it('looksDegenerateSerp: a single on-topic result clears the whole set', async () => {
    const { looksDegenerateSerp } = await import('../services/shared/webSearchEngine.js')
    expect(looksDegenerateSerp(SCHOOL_QUERY, [...JUNK_SERP, REAL_HIT])).toBe(false)
  })

  it('looksDegenerateSerp: never fires on single-distinctive-term or empty inputs', async () => {
    const { looksDegenerateSerp } = await import('../services/shared/webSearchEngine.js')
    expect(looksDegenerateSerp('scholarships Cleveland', JUNK_SERP)).toBe(false) // one distinctive term
    expect(looksDegenerateSerp(SCHOOL_QUERY, [])).toBe(false)
    expect(looksDegenerateSerp('', JUNK_SERP)).toBe(false)
  })

  it('fails over to Brave when SearXNG answers with a first-word SERP', async () => {
    process.env.SEARXNG_URL = 'https://searx.example.com'
    process.env.BRAVE_SEARCH_API_KEY = 'test-key'
    _resetWebSearchEngineForTests()
    searxngSearchFn.mockResolvedValue(JUNK_SERP)
    braveSearchFn.mockResolvedValue([REAL_HIT])

    const results = await searchWeb(SCHOOL_QUERY)
    expect(searxngSearchFn).toHaveBeenCalled()
    expect(braveSearchFn).toHaveBeenCalled()
    expect(results[0].url).toBe(REAL_HIT.url)
  })

  it('returns the held SearXNG set unchanged when Brave cannot improve on it', async () => {
    process.env.SEARXNG_URL = 'https://searx.example.com'
    process.env.BRAVE_SEARCH_API_KEY = 'test-key'
    _resetWebSearchEngineForTests()
    searxngSearchFn.mockResolvedValue(JUNK_SERP)
    braveSearchFn.mockResolvedValue([]) // budget-paused / no results

    const results = await searchWeb(SCHOOL_QUERY)
    expect(results.map((r) => r.url)).toEqual(JUNK_SERP.map((r) => r.url))
  })

  it('never consults Brave for a healthy SearXNG SERP', async () => {
    process.env.SEARXNG_URL = 'https://searx.example.com'
    process.env.BRAVE_SEARCH_API_KEY = 'test-key'
    _resetWebSearchEngineForTests()
    searxngSearchFn.mockResolvedValue([REAL_HIT, ...JUNK_SERP])

    const results = await searchWeb(SCHOOL_QUERY)
    expect(braveSearchFn).not.toHaveBeenCalled()
    expect(results[0].url).toBe(REAL_HIT.url)
  })
})

describe('the fallback-engines rung (SearXNG engines=yahoo, 2026-07-27)', () => {
  const SCHOOL_QUERY = 'Cleveland State Community College scholarships'
  const JUNK = [
    { url: 'https://en.wikipedia.org/wiki/Cleveland', title: 'Cleveland - Wikipedia', snippet: 'Cleveland is a city in the U.S. state of Ohio' },
  ]
  const YAHOO_HIT = {
    url: 'https://www.clevelandstatecc.edu/paying-for-college/scholarships/',
    title: 'Scholarships | Cleveland State Community College',
    snippet: 'Cleveland State Community College Foundation scholarships',
  }

  it('retries the SAME instance with the fallback allowlist before spending Brave budget', async () => {
    process.env.SEARXNG_URL = 'https://searx.example.com'
    process.env.BRAVE_SEARCH_API_KEY = 'test-key'
    _resetWebSearchEngineForTests()
    searxngSearchFn.mockImplementation(async ({ engines }) =>
      engines === 'yahoo,mojeek,yandex' ? [YAHOO_HIT] : JUNK,
    )

    const results = await searchWeb(SCHOOL_QUERY)
    expect(searxngSearchFn).toHaveBeenCalledTimes(2)
    expect(searxngSearchFn.mock.calls[1][0].engines).toBe('yahoo,mojeek,yandex')
    expect(braveSearchFn).not.toHaveBeenCalled()
    expect(results[0].url).toBe(YAHOO_HIT.url)
  })

  it('falls through to Brave when the fallback engines are junk too', async () => {
    process.env.SEARXNG_URL = 'https://searx.example.com'
    process.env.BRAVE_SEARCH_API_KEY = 'test-key'
    _resetWebSearchEngineForTests()
    searxngSearchFn.mockResolvedValue(JUNK) // both calls junk
    braveSearchFn.mockResolvedValue([YAHOO_HIT])

    const results = await searchWeb(SCHOOL_QUERY)
    expect(searxngSearchFn).toHaveBeenCalledTimes(2)
    expect(braveSearchFn).toHaveBeenCalled()
    expect(results[0].url).toBe(YAHOO_HIT.url)
  })

  it('honors SEARXNG_FALLBACK_ENGINES and skips the rung when set empty', async () => {
    process.env.SEARXNG_URL = 'https://searx.example.com'
    process.env.BRAVE_SEARCH_API_KEY = 'test-key'
    process.env.SEARXNG_FALLBACK_ENGINES = ''
    _resetWebSearchEngineForTests()
    searxngSearchFn.mockResolvedValue(JUNK)
    braveSearchFn.mockResolvedValue([])

    const results = await searchWeb(SCHOOL_QUERY)
    expect(searxngSearchFn).toHaveBeenCalledTimes(1) // no second call
    // Brave empty → held junk returned unchanged (never lose results).
    expect(results.map((r) => r.url)).toEqual(JUNK.map((r) => r.url))
    delete process.env.SEARXNG_FALLBACK_ENGINES
  })
})

describe('the cross-query identity breaker (degraded-instance signature)', () => {
  // Junk that the RELEVANCE gate cannot catch: a Montana-tourism SERP really
  // does cover "montana" and "state" at word boundaries, so it reads on-topic
  // for "Montana State University Billings scholarships". What it cannot fake
  // is being the IDENTICAL set for a DIFFERENT query.
  const MONTANA_JUNK = [
    { url: 'https://www.visitmt.com/', title: 'Visit Montana', snippet: 'Montana is a state with Billings, Bozeman and more' },
    { url: 'https://en.wikipedia.org/wiki/Montana', title: 'Montana - Wikipedia', snippet: 'Montana is a state in the western United States' },
    { url: 'https://mt.gov/', title: 'Montana official state website', snippet: 'the state of Montana' },
  ]
  const GOOD_HIT = {
    url: 'https://www.msubillings.edu/finaid/scholarships.htm',
    title: 'Scholarships - Montana State University Billings',
    snippet: 'MSU Billings scholarship opportunities',
  }

  it('an identical set for a DIFFERENT query trips the breaker and prefers fallback engines', async () => {
    process.env.SEARXNG_URL = 'https://searx.example.com'
    _resetWebSearchEngineForTests()
    searxngSearchFn.mockImplementation(async ({ engines }) =>
      engines === 'yahoo,mojeek,yandex' ? [GOOD_HIT] : MONTANA_JUNK,
    )

    // Query 1: junk covers its terms → relevance gate passes it (returned).
    const first = await searchWeb('Montana State University Billings scholarships')
    expect(first.map((r) => r.url)).toEqual(MONTANA_JUNK.map((r) => r.url))

    // Query 2 (different string, same set): identity breaker fires → fallback
    // engines answer.
    const second = await searchWeb('Montana State University Billings foundation scholarships')
    expect(second[0].url).toBe(GOOD_HIT.url)

    // Query 3: breaker active → default engines are SKIPPED entirely.
    searxngSearchFn.mockClear()
    const third = await searchWeb('Montana State University Billings endowed scholarships')
    expect(third[0].url).toBe(GOOD_HIT.url)
    expect(searxngSearchFn).toHaveBeenCalledTimes(1)
    expect(searxngSearchFn.mock.calls[0][0].engines).toBe('yahoo,mojeek,yandex')
  })

  it('the SAME query repeated never trips the breaker', async () => {
    process.env.SEARXNG_URL = 'https://searx.example.com'
    _resetWebSearchEngineForTests()
    searxngSearchFn.mockResolvedValue(MONTANA_JUNK)

    const q = 'Montana State University Billings scholarships'
    const first = await searchWeb(q)
    const second = await searchWeb(q)
    expect(first.map((r) => r.url)).toEqual(MONTANA_JUNK.map((r) => r.url))
    expect(second.map((r) => r.url)).toEqual(MONTANA_JUNK.map((r) => r.url))
    // Only ever called with the default engine set — the breaker stayed cold.
    for (const call of searxngSearchFn.mock.calls) expect(call[0].engines).toBeUndefined()
  })
})
