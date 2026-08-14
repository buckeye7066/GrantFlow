/**
 * gf-batch-05 purpose guards.
 *
 * Failing-first regression tests for four live-path defects on the north-star
 * chain (determine the need -> run the correct crawlers -> use profile info to
 * find REAL sources, without overstating an outcome). Each block states the
 * pre-fix behavior it pins, so the guard cannot go inert.
 *
 * Kept in its own file so it cannot collide with another batch agent editing an
 * existing suite.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// 1. webSearchEngine: an all-skip-listed Brave answer must NOT end the ladder.
//
// PRE-FIX: the Brave rung `return`ed an empty set when every row was
// skip-listed. That threw away a real HELD SearXNG set and skipped the
// DuckDuckGo rung — the gate LOSING results instead of rerouting them, which
// the module's own contract forbids. Google and SearXNG both fall through on
// the identical condition; Brave was the lone rung that did not.
// ─────────────────────────────────────────────────────────────────────────────
const getWithRetryMock = vi.fn()
const braveSearchFn = vi.fn()
const searxngSearchFn = vi.fn()
const googleSearchFn = vi.fn()
const tryConsumeGoogleMock = vi.fn()
const cacheGetMock = vi.fn()
const cachePutMock = vi.fn()

vi.mock('../services/shared/httpClient.js', () => ({ getWithRetry: (...a) => getWithRetryMock(...a) }))
vi.mock('../services/yana/webSearchProvider.js', () => ({ makeBraveSearchProvider: () => braveSearchFn }))
vi.mock('../services/shared/searxngProvider.js', () => ({ makeSearxngProvider: () => searxngSearchFn }))
vi.mock('../services/shared/googleCseProvider.js', () => ({ makeGoogleCseProvider: () => googleSearchFn }))
vi.mock('../services/shared/googleBudget.js', () => ({ tryConsumeGoogleQuery: (...a) => tryConsumeGoogleMock(...a) }))
vi.mock('../services/shared/webSearchCache.js', () => ({
  getCachedSearch: (...a) => cacheGetMock(...a),
  putCachedSearch: (...a) => cachePutMock(...a),
}))

const { searchWeb, _resetWebSearchEngineForTests } = await import('../services/shared/webSearchEngine.js')

const DDG_HTML = `
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbradleyfoundation.org%2Fgrants">Bradley Foundation Grants</a>
    <div class="result__snippet">Local scholarships and grants</div>
  </div>
`

describe('gf-batch-05: the search ladder never LOSES results at the Brave rung', () => {
  beforeEach(() => {
    getWithRetryMock.mockReset()
    braveSearchFn.mockReset()
    searxngSearchFn.mockReset()
    googleSearchFn.mockReset()
    tryConsumeGoogleMock.mockReset()
    tryConsumeGoogleMock.mockResolvedValue({ allowed: false })
    cacheGetMock.mockReset()
    cacheGetMock.mockResolvedValue(null)
    cachePutMock.mockReset()
    cachePutMock.mockResolvedValue(true)
    delete process.env.SEARXNG_URL
    delete process.env.GOOGLE_CSE_KEY
    process.env.BRAVE_SEARCH_API_KEY = 'test-key'
    // vitest.setup.js sets GRANTFLOW_TEST_RUNNER=1, which short-circuits
    // searchWeb before ANY provider runs. Every provider here is mocked, so no
    // live request is possible — mirror the existing webSearchEngine suite.
    process.env.GRANTFLOW_ALLOW_LIVE_WEB_IN_TESTS = 'true'
    _resetWebSearchEngineForTests?.()
  })
  afterEach(() => {
    delete process.env.BRAVE_SEARCH_API_KEY
    delete process.env.SEARXNG_URL
    delete process.env.GRANTFLOW_ALLOW_LIVE_WEB_IN_TESTS
  })

  it('falls through to DuckDuckGo when Brave answers with rows that are ALL skip-listed', async () => {
    // Brave answers, but every row is a non-actionable social host that
    // `shouldSkip` removes. Pre-fix this returned [] with status 'empty'.
    braveSearchFn.mockResolvedValue([
      { url: 'https://www.facebook.com/somepage', title: 'FB', snippet: 's' },
      { url: 'https://twitter.com/someone', title: 'TW', snippet: 's' },
    ])
    getWithRetryMock.mockResolvedValue({ data: DDG_HTML })

    const results = await searchWeb('bradley county tn emergency rent assistance')

    expect(getWithRetryMock).toHaveBeenCalled() // the DDG rung was REACHED
    expect(results.map((r) => r.url)).toContain('https://bradleyfoundation.org/grants')
    expect(results.searchMeta.provider).toBe('duckduckgo')
  })

  it('returns the HELD degenerate SearXNG set rather than Brave\'s all-filtered nothing', async () => {
    process.env.SEARXNG_URL = 'http://searxng.test'
    // SearXNG answers with a set the degeneracy gate holds (identical set for a
    // different query is not needed here — a first-word SERP is enough): make
    // the fallback-engine call return the same rows so the held set survives.
    const held = [{ url: 'https://example.org/held-real-page', title: 'Bradley', snippet: 'x' }]
    searxngSearchFn.mockResolvedValue(held)
    braveSearchFn.mockResolvedValue([{ url: 'https://www.facebook.com/x', title: 'FB', snippet: 's' }])
    getWithRetryMock.mockResolvedValue({ data: '' })

    const results = await searchWeb('bradley county tn emergency rent assistance')

    // Whatever the ladder decides, it must NEVER be an empty Brave answer:
    // either the held SearXNG set or a real DDG answer, but not nothing-from-Brave.
    expect(results.searchMeta.provider).not.toBe('brave')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. profileResultFloorLedger: the boot-net OBSERVATION must not advance the
//    ATTEMPT fingerprint, or catalog-drift can never re-open an exhausted
//    profile.
//
// PRE-FIX: `refreshFloorObservation` wrote `fingerprint` on every boot for every
// profile, so by the time the nightly heal sweep read the ledger,
// `entry.fingerprint` already equalled the current world and
// `evaluateFloorEligibility`'s `drifted` was ALWAYS false.
// ─────────────────────────────────────────────────────────────────────────────
const { refreshFloorObservation } = await import('../services/coverageAudit/profileResultFloorLedger.js')
const {
  applyFloorAttempt, evaluateFloorEligibility, buildFloorFingerprint, FLOOR_OUTCOME,
} = await import('../config/profileResultFloor.js')

describe('gf-batch-05: catalog drift re-opens an exhausted profile', () => {
  it('a boot-net observation does NOT advance the attempt fingerprint', () => {
    const fpAtVerdict = buildFloorFingerprint({ target: 20, activeCatalogCount: 15000 })
    // Spend the profile out at the world it was exhausted in.
    let entry = null
    for (let i = 0; i < 3; i += 1) {
      entry = applyFloorAttempt(entry, {
        outcome: FLOOR_OUTCOME.NO_NEW_RESULTS,
        target: 20,
        awardable: 2,
        added: 0,
        evidence: 'searched 5 lanes, 0 added',
        fingerprint: fpAtVerdict,
      })
    }
    expect(entry.exhausted_at).toBeTruthy()
    expect(entry.fingerprint).toBe(fpAtVerdict)

    // The world moves past the drift step; the boot net observes (no attempt).
    const fpNow = buildFloorFingerprint({ target: 20, activeCatalogCount: 15000 + 2000 })
    expect(fpNow).not.toBe(fpAtVerdict)
    const ledger = refreshFloorObservation(
      { targets: {}, profiles: { p1: entry } }, 'p1',
      { target: 20, awardable: 2, fingerprint: fpNow },
    )
    const after = ledger.profiles.p1

    // The VERDICT's fingerprint is untouched — that is what makes drift visible.
    expect(after.fingerprint).toBe(fpAtVerdict)
    expect(after.observed_fingerprint).toBe(fpNow)

    const elig = evaluateFloorEligibility(after, { fingerprint: fpNow })
    expect(elig.eligible).toBe(true)
    expect(elig.reason).toBe('reopened_drift')
  })

  it('a profile that REACHED its target stops reporting the failed pass\'s outcome', () => {
    const fp = buildFloorFingerprint({ target: 10, activeCatalogCount: 100 })
    let entry = null
    for (let i = 0; i < 3; i += 1) {
      entry = applyFloorAttempt(entry, {
        outcome: FLOOR_OUTCOME.NO_NEW_RESULTS, target: 10, awardable: 1, added: 0, fingerprint: fp,
      })
    }
    expect(entry.last_outcome).toBe(FLOOR_OUTCOME.EXHAUSTED)

    const ledger = refreshFloorObservation(
      { targets: {}, profiles: { p2: entry } }, 'p2',
      { target: 10, awardable: 12, fingerprint: fp },
    )
    const after = ledger.profiles.p2
    expect(after.exhausted_at).toBeNull()
    expect(after.attempts).toBe(0)
    expect(after.last_outcome).toBe(FLOOR_OUTCOME.ADDED)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. relevanceFilterRules: a state NAME used as a COUNTY name is not a state
//    claim. This feeds the HARD `geographic_residents_only_exclusive` rule, and
//    county locator rows carry `state NULL`, so the title was the only input.
// ─────────────────────────────────────────────────────────────────────────────
const { RELEVANCE_RULES } = await import('../services/relevanceFilterRules.js')

describe('gf-batch-05: a county named after a state is not a state claim', () => {
  const hardGeo = () => RELEVANCE_RULES.find((r) => r.id === 'geographic_residents_only_exclusive')
  const softGeo = () => RELEVANCE_RULES.find((r) => r.id === 'geographic_title_state_mismatch')

  // NOTE on the live path, measured while writing these guards: BOTH geographic
  // rules short-circuit on `_isNationalOpportunity`, which returns TRUE when
  // `opportunity.state` is empty. So the HARD rule's `oppState || titleAbbr`
  // fallback is UNREACHABLE — reaching that line already requires a non-empty
  // `oppState`, which then wins. The title extractor's only live consumer is the
  // SOFT `geographic_title_state_mismatch` rule below. Reported, not "fixed":
  // changing missing-state-means-national has fleet-wide blast radius.

  it('does NOT flag an OHIO household on "Delaware County, OH" (pre-fix resolved DE)', () => {
    const rule = softGeo()
    expect(rule).toBeTruthy()
    const opportunity = { title: 'Delaware County, OH — Emergency Rental Assistance', state: 'OH' }
    expect(rule.profileCheck({ state: 'oh' }, '', opportunity)).toBe(false)
  })

  it('does NOT flag a PENNSYLVANIA household on "Washington County, PA" (pre-fix resolved WA)', () => {
    const rule = softGeo()
    const opportunity = { title: 'Washington County, PA — Utility Assistance', state: 'PA' }
    expect(rule.profileCheck({ state: 'pa' }, '', opportunity)).toBe(false)
  })

  it('does NOT flag a MISSOURI household on "Kansas City, MO" (pre-fix resolved KS)', () => {
    const rule = softGeo()
    const opportunity = { title: 'Kansas City, MO — Emergency Assistance Fund', state: 'MO' }
    expect(rule.profileCheck({ state: 'mo' }, '', opportunity)).toBe(false)
  })

  it('keeps a real state claim in a title ("Tennessee Promise Scholarship")', () => {
    const rule = softGeo()
    const opportunity = { title: 'Tennessee Promise Scholarship', state: 'TN' }
    // An OHIO profile is still flagged against a Tennessee-titled program.
    expect(rule.profileCheck({ state: 'oh' }, '', opportunity)).toBe(true)
    // A Tennessee profile is not.
    expect(rule.profileCheck({ state: 'tn' }, '', opportunity)).toBe(false)
  })

  it('the HARD residents-only rule still fires on a genuine other-state program', () => {
    const rule = hardGeo()
    const opportunity = { title: 'Texas Rent Relief', state: 'TX', description: 'Texas residents only.' }
    expect(rule.profileCheck({ state: 'tn' }, '', opportunity)).toBe(true)
    expect(rule.profileCheck({ state: 'tx' }, '', opportunity)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. hamiltonWeeklyDigest: an internal "mark submitted" click is NOT an
//    application submitted to the funder. This digest is AUTO-SENT.
// ─────────────────────────────────────────────────────────────────────────────
const { buildDigest } = await import('../services/hamilton/hamiltonWeeklyDigest.js')

describe('gf-batch-05: the weekly digest never reports an internal mark as a submission', () => {
  const base = { grants: [], openInvoices: [], newGrants: [], draftsReadyThisWeek: [] }

  it('labels an internal-record row as marked-submitted, not submitted', () => {
    const { text: digestText } = buildDigest({
      displayName: 'Test Household',
      signals: {
        ...base,
        submittedThisWeek: [{ title: 'FSEOG', funder: 'Federal Student Aid' }],
        submittedExternallyThisWeek: [],
        markedSubmittedThisWeek: [{ title: 'FSEOG', funder: 'Federal Student Aid' }],
      },
    })
    const text = digestText
    expect(text).toMatch(/marked submitted in your tracker/i)
    expect(text).toMatch(/no funder confirmation captured/i)
    expect(text).not.toMatch(/1 application submitted:/i)
  })

  it('labels a proof-carrying row as submitted WITH a portal confirmation', () => {
    const { text: digestText } = buildDigest({
      displayName: 'Test Household',
      signals: {
        ...base,
        submittedThisWeek: [{ title: 'NAEMT', funder: 'NAEMT' }],
        submittedExternallyThisWeek: [{ title: 'NAEMT', funder: 'NAEMT' }],
        markedSubmittedThisWeek: [],
      },
    })
    const text = digestText
    expect(text).toMatch(/portal confirmation on file/i)
  })

  it('an UNCLASSIFIED signals object falls to the internal-record bucket (honest default)', () => {
    const { text: digestText } = buildDigest({
      displayName: 'Test Household',
      signals: { ...base, submittedThisWeek: [{ title: 'FSEOG', funder: 'Federal Student Aid' }] },
    })
    const text = digestText
    expect(text).toMatch(/marked submitted in your tracker/i)
    expect(text).not.toMatch(/portal confirmation on file/i)
  })
})
