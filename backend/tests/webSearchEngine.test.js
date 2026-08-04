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
const googleSearchFn = vi.fn()
const makeGoogleMock = vi.fn(() => googleSearchFn)
const tryConsumeGoogleMock = vi.fn()

vi.mock('../services/shared/httpClient.js', () => ({
  getWithRetry: (...a) => getWithRetryMock(...a),
}))
vi.mock('../services/yana/webSearchProvider.js', () => ({
  makeBraveSearchProvider: (...a) => makeBraveMock(...a),
}))
vi.mock('../services/shared/searxngProvider.js', () => ({
  makeSearxngProvider: (...a) => makeSearxngMock(...a),
}))
vi.mock('../services/shared/googleCseProvider.js', () => ({
  makeGoogleCseProvider: (...a) => makeGoogleMock(...a),
}))
vi.mock('../services/shared/googleBudget.js', () => ({
  tryConsumeGoogleQuery: (...a) => tryConsumeGoogleMock(...a),
}))
const cacheGetMock = vi.fn()
const cachePutMock = vi.fn()
vi.mock('../services/shared/webSearchCache.js', () => ({
  getCachedSearch: (...a) => cacheGetMock(...a),
  putCachedSearch: (...a) => cachePutMock(...a),
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
  googleSearchFn.mockReset()
  makeGoogleMock.mockClear()
  tryConsumeGoogleMock.mockReset()
  tryConsumeGoogleMock.mockResolvedValue({ allowed: true })
  cacheGetMock.mockReset()
  cacheGetMock.mockResolvedValue(null)
  cachePutMock.mockReset()
  cachePutMock.mockResolvedValue(true)
  delete process.env.BRAVE_SEARCH_API_KEY
  delete process.env.SEARXNG_URL
  delete process.env.GOOGLE_CSE_KEY
  delete process.env.GOOGLE_CSE_CX
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
  delete process.env.GOOGLE_CSE_KEY
  delete process.env.GOOGLE_CSE_CX
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
      engines === 'yandex,seznam,yahoo' ? [YAHOO_HIT] : JUNK,
    )

    const results = await searchWeb(SCHOOL_QUERY)
    expect(searxngSearchFn).toHaveBeenCalledTimes(2)
    expect(searxngSearchFn.mock.calls[1][0].engines).toBe('yandex,seznam,yahoo')
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

describe('the persistent SERP cache rung (nightly-load reducer, 2026-07-28)', () => {
  const HIT = [{ url: 'https://county.gov/scholarship', title: 'Bradley County Scholarship', snippet: 'apply' }]

  it('a cache hit short-circuits every provider', async () => {
    process.env.SEARXNG_URL = 'https://searx.example.com'
    process.env.BRAVE_SEARCH_API_KEY = 'test-key'
    _resetWebSearchEngineForTests()
    cacheGetMock.mockResolvedValue(HIT)

    const results = await searchWeb('"Bradley County" scholarship')
    expect(results).toEqual(HIT)
    expect(searxngSearchFn).not.toHaveBeenCalled()
    expect(braveSearchFn).not.toHaveBeenCalled()
    expect(getWithRetryMock).not.toHaveBeenCalled()
    expect(cachePutMock).not.toHaveBeenCalled()
  })

  it('a healthy SearXNG SERP is stored in the cache', async () => {
    process.env.SEARXNG_URL = 'https://searx.example.com'
    _resetWebSearchEngineForTests()
    searxngSearchFn.mockResolvedValue([
      { url: 'https://county.gov/scholarship', title: 'Bradley County Scholarship', snippet: 'apply' },
    ])

    const results = await searchWeb('"Bradley County" scholarship')
    expect(results).toHaveLength(1)
    expect(cachePutMock).toHaveBeenCalledTimes(1)
    expect(cachePutMock.mock.calls[0][0]).toBe('"Bradley County" scholarship')
  })

  it('a held degenerate SERP is NEVER cached (junk cannot poison the next day)', async () => {
    process.env.SEARXNG_URL = 'https://searx.example.com'
    _resetWebSearchEngineForTests()
    // First-word junk for a multi-term query, no fallback answers, no Brave:
    searxngSearchFn.mockResolvedValue([
      { url: 'https://en.wikipedia.org/wiki/Cleveland', title: 'Cleveland - Wikipedia', snippet: 'Cleveland is a city in the U.S. state of Ohio' },
    ])

    const results = await searchWeb('Cleveland State Community College scholarships')
    expect(results).toHaveLength(1) // held set still returned (never lose results)
    expect(cachePutMock).not.toHaveBeenCalled()
  })
})

describe('the engine-collapse gate (bing-only fleet telemetry, 2026-07-28)', () => {
  // The 2026-07-28 prod state: brave + google-cse "Suspended: too many
  // requests", startpage/qwant CAPTCHA'd — every result came from scraped bing
  // and covered ENOUGH query words to slip past the relevance gate
  // ("wheelchair van grants tennessee mobility" → wheelchair-shopping junk
  // that names 'wheelchair' and 'mobility'). The engine telemetry the provider
  // now attaches is the mechanical tell.
  const QUERY = 'wheelchair van grants tennessee mobility'
  const BING_JUNK = withMeta(
    [
      { url: 'https://mobilitydeck.com/best-wheelchairs/', title: 'Best Wheelchairs 2026', snippet: 'wheelchair and mobility product roundup' },
      { url: 'https://en.wikipedia.org/wiki/Wheelchair', title: 'Wheelchair - Wikipedia', snippet: 'a wheelchair is a mobility device' },
      { url: 'https://www.karmanhealthcare.com/blog/', title: 'Wheelchair Blog', snippet: 'mobility tips for wheelchair users' },
    ],
    {
      result_engines: ['bing'],
      unresponsive_engines: [
        { engine: 'brave', reason: 'Suspended: too many requests' },
        { engine: 'startpage', reason: 'Suspended: CAPTCHA' },
        { engine: 'qwant', reason: 'CAPTCHA' },
      ],
    },
  )
  const REAL_HIT = {
    url: 'https://www.themobilityresource.com/wheelchair-van-grants-tennessee/',
    title: 'Wheelchair Van Grants in Tennessee | The Mobility Resource',
    snippet: 'grants for wheelchair accessible vans in Tennessee',
  }

  function withMeta(results, meta) {
    Object.defineProperty(results, 'searxngMeta', { value: meta, enumerable: false })
    return results
  }

  it('looksEngineCollapse: fires on bing-only results with 2+ suspended engines', async () => {
    const { looksEngineCollapse } = await import('../services/shared/webSearchEngine.js')
    expect(looksEngineCollapse(BING_JUNK.searxngMeta)).toBe(true)
  })

  it('looksEngineCollapse: never fires on a diverse fleet, one suspension, or missing telemetry', async () => {
    const { looksEngineCollapse } = await import('../services/shared/webSearchEngine.js')
    expect(looksEngineCollapse({ result_engines: ['bing', 'yandex'], unresponsive_engines: BING_JUNK.searxngMeta.unresponsive_engines })).toBe(false)
    expect(looksEngineCollapse({ result_engines: ['bing'], unresponsive_engines: [{ engine: 'qwant', reason: 'CAPTCHA' }] })).toBe(false)
    expect(looksEngineCollapse(undefined)).toBe(false)
    expect(looksEngineCollapse({ result_engines: [], unresponsive_engines: [] })).toBe(false)
  })

  it('a collapsed-fleet SERP is held and the fallback engines answer, even when it reads topical', async () => {
    process.env.SEARXNG_URL = 'https://searx.example.com'
    process.env.BRAVE_SEARCH_API_KEY = 'test-key'
    _resetWebSearchEngineForTests()
    searxngSearchFn.mockImplementation(async ({ engines }) =>
      engines === 'yandex,seznam,yahoo' ? [REAL_HIT] : BING_JUNK,
    )

    const results = await searchWeb(QUERY)
    expect(searxngSearchFn).toHaveBeenCalledTimes(2)
    expect(searxngSearchFn.mock.calls[1][0].engines).toBe('yandex,seznam,yahoo')
    expect(braveSearchFn).not.toHaveBeenCalled()
    expect(results[0].url).toBe(REAL_HIT.url)
  })

  it('the held bing-only set is still returned when every fallback comes up empty (never lose results)', async () => {
    process.env.SEARXNG_URL = 'https://searx.example.com'
    _resetWebSearchEngineForTests()
    searxngSearchFn.mockImplementation(async ({ engines }) => (engines ? [] : BING_JUNK))

    const results = await searchWeb(QUERY)
    expect(results.map((r) => r.url)).toEqual(BING_JUNK.map((r) => r.url))
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
      engines === 'yandex,seznam,yahoo' ? [GOOD_HIT] : MONTANA_JUNK,
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
    expect(searxngSearchFn.mock.calls[0][0].engines).toBe('yandex,seznam,yahoo')
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

describe('the empty-default rung (all engines suspended, Brave paused)', () => {
  it('an EMPTY default SERP still consults the fallback engines before giving up', async () => {
    process.env.SEARXNG_URL = 'https://searx.example.com'
    _resetWebSearchEngineForTests()
    // Default engine set: every engine suspended → zero results (observed live
    // 2026-07-27). Fallback allowlist still answers. No Brave key at all —
    // the keyless ladder alone must carry the query.
    searxngSearchFn.mockImplementation(async ({ engines }) =>
      engines ? [{ url: 'https://uwf.academicworks.com/', title: 'UWF Scholarships — AcademicWorks', snippet: 'University of West Florida scholarship portal' }] : [],
    )

    const results = await searchWeb('University of West Florida scholarships')
    expect(searxngSearchFn).toHaveBeenCalledTimes(2)
    expect(searxngSearchFn.mock.calls[1][0].engines).toBe('yandex,seznam,yahoo')
    expect(results[0].url).toBe('https://uwf.academicworks.com/')
  })

  it('a transport-level SearXNG failure does NOT re-hit the dead instance on the fallback rung', async () => {
    process.env.SEARXNG_URL = 'https://searx.example.com'
    _resetWebSearchEngineForTests()
    searxngSearchFn.mockRejectedValue(new Error('ECONNREFUSED'))
    getWithRetryMock.mockResolvedValue({ data: DDG_HTML })

    const results = await searchWeb('local grant')
    expect(searxngSearchFn).toHaveBeenCalledTimes(1) // no second call at the same dead endpoint
    expect(results[0].url).toBe('https://bradleyfoundation.org/grants') // DDG still ran
  })
})

describe('the Google CSE rung (rung 0.5 — official API above SearXNG, 2026-08-04)', () => {
  const GOOGLE_HIT = [
    { url: 'https://tn.gov/collegepays', title: 'TN HOPE Scholarship', snippet: 'state aid' },
  ]
  const SEARX_HIT = [
    { url: 'https://county.gov/scholarship', title: 'Bradley County Scholarship', snippet: 'apply' },
  ]
  const QUERY = '"Bradley County" scholarship'

  function keyGoogle() {
    process.env.GOOGLE_CSE_KEY = 'g-key'
    process.env.GOOGLE_CSE_CX = 'g-cx'
  }

  it('answers FIRST when keyed and budget-allowed — SearXNG never consulted — and the SERP is cached', async () => {
    keyGoogle()
    process.env.SEARXNG_URL = 'https://searx.example.com'
    _resetWebSearchEngineForTests()
    googleSearchFn.mockResolvedValue(GOOGLE_HIT)

    const results = await searchWeb(QUERY)
    expect(makeGoogleMock).toHaveBeenCalled()
    expect(tryConsumeGoogleMock).toHaveBeenCalledTimes(1)
    expect(results).toEqual(GOOGLE_HIT)
    expect(searxngSearchFn).not.toHaveBeenCalled()
    expect(getWithRetryMock).not.toHaveBeenCalled() // no DDG
    expect(cachePutMock).toHaveBeenCalledTimes(1)
    expect(cachePutMock.mock.calls[0][0]).toBe(QUERY)
    expect(cachePutMock.mock.calls[0][1]).toEqual(GOOGLE_HIT)
  })

  it('a cache hit never reaches the budget OR Google — no quota spend on a cached query', async () => {
    keyGoogle()
    process.env.SEARXNG_URL = 'https://searx.example.com'
    _resetWebSearchEngineForTests()
    // Seed the cache: this is the "second call of the day" for this query.
    cacheGetMock.mockResolvedValue(SEARX_HIT)

    const results = await searchWeb(QUERY)
    expect(results).toEqual(SEARX_HIT)
    expect(tryConsumeGoogleMock).not.toHaveBeenCalled() // budget never consulted
    expect(googleSearchFn).not.toHaveBeenCalled()
    expect(searxngSearchFn).not.toHaveBeenCalled()
  })

  it('the first Google answer serves the second identical query from cache (one budget spend total)', async () => {
    keyGoogle()
    _resetWebSearchEngineForTests()
    googleSearchFn.mockResolvedValue(GOOGLE_HIT)

    const first = await searchWeb(QUERY)
    expect(first).toEqual(GOOGLE_HIT)
    expect(cachePutMock).toHaveBeenCalledTimes(1)
    // Simulate the cache layer now holding what searchWeb stored.
    cacheGetMock.mockResolvedValue(cachePutMock.mock.calls[0][1])

    const second = await searchWeb(QUERY)
    expect(second).toEqual(GOOGLE_HIT)
    expect(googleSearchFn).toHaveBeenCalledTimes(1) // ONE real Google query
    expect(tryConsumeGoogleMock).toHaveBeenCalledTimes(1) // ONE budget spend
  })

  it('a budget denial falls through to SearXNG with NO error and NO Google call', async () => {
    keyGoogle()
    process.env.SEARXNG_URL = 'https://searx.example.com'
    _resetWebSearchEngineForTests()
    tryConsumeGoogleMock.mockResolvedValue({ allowed: false, reason: 'daily_budget_exhausted' })
    searxngSearchFn.mockResolvedValue(SEARX_HIT)

    const results = await searchWeb(QUERY)
    expect(googleSearchFn).not.toHaveBeenCalled() // denied → network never paid
    expect(searxngSearchFn).toHaveBeenCalled()
    expect(results.map((r) => r.url)).toEqual(SEARX_HIT.map((r) => r.url))
  })

  it('a google_quota throw degrades the rung: later queries skip Google (and its budget) entirely, SearXNG still answers', async () => {
    keyGoogle()
    process.env.SEARXNG_URL = 'https://searx.example.com'
    _resetWebSearchEngineForTests()
    googleSearchFn.mockRejectedValue(Object.assign(new Error('quota exceeded'), { code: 'google_quota' }))
    searxngSearchFn.mockResolvedValue(SEARX_HIT)

    // First call: budget spent, Google refuses with the quota signal, ladder continues.
    const first = await searchWeb(QUERY)
    expect(first.map((r) => r.url)).toEqual(SEARX_HIT.map((r) => r.url))
    expect(googleSearchFn).toHaveBeenCalledTimes(1)
    expect(tryConsumeGoogleMock).toHaveBeenCalledTimes(1)

    // Same-process follow-ups: the rung is degraded until the next UTC
    // midnight — no Google call AND no budget consult (a dead rung must not
    // keep spending pacer slots).
    const second = await searchWeb(QUERY)
    expect(second.map((r) => r.url)).toEqual(SEARX_HIT.map((r) => r.url))
    expect(googleSearchFn).toHaveBeenCalledTimes(1)
    expect(tryConsumeGoogleMock).toHaveBeenCalledTimes(1)
  })

  it('a NON-quota Google failure does NOT degrade the rung (next query retries Google)', async () => {
    keyGoogle()
    process.env.SEARXNG_URL = 'https://searx.example.com'
    _resetWebSearchEngineForTests()
    googleSearchFn.mockRejectedValue(new Error('socket hang up'))
    searxngSearchFn.mockResolvedValue(SEARX_HIT)

    await searchWeb(QUERY)
    await searchWeb(QUERY)
    expect(googleSearchFn).toHaveBeenCalledTimes(2) // transient failure → still consulted
  })

  it('an EMPTY Google answer falls through to SearXNG, and the empty set is NEVER cached as the answer', async () => {
    keyGoogle()
    process.env.SEARXNG_URL = 'https://searx.example.com'
    _resetWebSearchEngineForTests()
    googleSearchFn.mockResolvedValue([]) // site-restricted CX / thin SERP
    searxngSearchFn.mockResolvedValue(SEARX_HIT)

    const results = await searchWeb(QUERY)
    expect(results.map((r) => r.url)).toEqual(SEARX_HIT.map((r) => r.url))
    // Exactly one cache write, and it is the SearXNG set — not Google's [].
    expect(cachePutMock).toHaveBeenCalledTimes(1)
    expect(cachePutMock.mock.calls[0][1].map((r) => r.url)).toEqual(SEARX_HIT.map((r) => r.url))
  })

  it('a Google answer of ONLY skip-host junk falls through instead of being returned or cached', async () => {
    keyGoogle()
    process.env.SEARXNG_URL = 'https://searx.example.com'
    _resetWebSearchEngineForTests()
    googleSearchFn.mockResolvedValue([{ url: 'https://facebook.com/somepage', title: 'social', snippet: '' }])
    searxngSearchFn.mockResolvedValue(SEARX_HIT)

    const results = await searchWeb(QUERY)
    expect(results.map((r) => r.url)).toEqual(SEARX_HIT.map((r) => r.url))
    expect(cachePutMock).toHaveBeenCalledTimes(1)
    expect(cachePutMock.mock.calls[0][1].map((r) => r.url)).toEqual(SEARX_HIT.map((r) => r.url))
  })

  it('Google results are hygiened like every other rung (skip hosts filtered, count capped)', async () => {
    keyGoogle()
    _resetWebSearchEngineForTests()
    googleSearchFn.mockResolvedValue([
      ...GOOGLE_HIT,
      { url: 'https://facebook.com/x', title: 'social', snippet: '' }, // filtered
    ])

    const results = await searchWeb(QUERY)
    expect(results.map((r) => r.url)).toEqual(['https://tn.gov/collegepays'])
  })

  it('unconfigured (no GOOGLE_CSE_* env) → Google is never constructed and the budget is never consulted', async () => {
    process.env.SEARXNG_URL = 'https://searx.example.com'
    _resetWebSearchEngineForTests()
    searxngSearchFn.mockResolvedValue(SEARX_HIT)

    const results = await searchWeb(QUERY)
    expect(results.map((r) => r.url)).toEqual(SEARX_HIT.map((r) => r.url))
    expect(makeGoogleMock).not.toHaveBeenCalled()
    expect(tryConsumeGoogleMock).not.toHaveBeenCalled()
    expect(googleSearchFn).not.toHaveBeenCalled()
  })
})
