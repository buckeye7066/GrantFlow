/**
 * Need-keyed live web lane (item funding): buildNeedWebQueries + searchNeedWebLeads.
 *
 * This is the lane behind the Item Funding page's owner-stated goal: a user
 * types a CONCRETE need ("passenger van", "help to pay for an Ethics Probe
 * Class") and GrantFlow searches the live web for funders of that exact item —
 * the profile-keyed catalog crawl has no reason to have fetched those pages.
 *
 * searchWeb (SearXNG/Brave/DDG) is mocked — tests are network-independent.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

const searchWebMock = vi.fn()
vi.mock('../services/shared/webSearchEngine.js', () => ({
  searchWeb: (...args) => searchWebMock(...args),
  default: { searchWeb: (...args) => searchWebMock(...args) },
}))

const { buildNeedWebQueries, searchNeedWebLeads } = await import('../services/shared/liveWebSearch.js')
const { expandNeed } = await import('../services/shared/needTaxonomy.js')

const nonprofitContext = {
  profile: { primary_type: 'nonprofit', state: 'TN' },
  signals: { location: { state: 'TN' } },
}

describe('buildNeedWebQueries', () => {
  it('anchors "passenger van" queries on the item + applicant type (acceptance query 1)', () => {
    const expanded = expandNeed('passenger van')
    const queries = buildNeedWebQueries('passenger van', expanded, nonprofitContext)

    expect(queries.length).toBeGreaterThan(0)
    // Every query must be anchored on the user's need — no generic drift.
    for (const q of queries) {
      expect(q.toLowerCase()).toMatch(/passenger van|van for nonprofit|15 passenger/)
    }
    // Applicant-type anchor: a nonprofit gets nonprofit-oriented funding queries.
    expect(queries.some((q) => q.includes('nonprofit'))).toBe(true)
    // Funding intent, not shopping intent.
    expect(queries.some((q) => /grant|funding/i.test(q))).toBe(true)
  })

  it('distills "help to pay for an Ethics Probe Class" to the taxonomy phrase but keeps the raw text (acceptance query 2)', () => {
    const needText = 'help to pay for an Ethics Probe Class'
    const expanded = expandNeed(needText)
    // The taxonomy must route this to license-reinstatement support via "probe class".
    expect(expanded.matchedKey).toBe('probe class')
    expect(expanded.canonicalNeed).toBe('license_reinstatement_support')

    const queries = buildNeedWebQueries(needText, expanded, { profile: { primary_type: 'individual' } })
    expect(queries.length).toBeGreaterThan(0)
    // Core queries use the distilled phrase, not the filler sentence.
    expect(queries.some((q) => q.toLowerCase().includes('probe class'))).toBe(true)
    // The raw text still appears in exactly one fallback query (nothing the
    // user typed is silently dropped).
    expect(queries.some((q) => q.toLowerCase().includes(needText.toLowerCase()))).toBe(true)
  })

  it("variant 'gift' flips intent to donation / in-kind programs", () => {
    const expanded = expandNeed('passenger van')
    const queries = buildNeedWebQueries('passenger van', expanded, nonprofitContext, { variant: 'gift' })
    expect(queries.length).toBeGreaterThan(0)
    expect(queries.some((q) => /donat|in-kind|free/i.test(q))).toBe(true)
    // Gift queries must not turn into loan/purchase queries.
    for (const q of queries) expect(q.toLowerCase()).not.toMatch(/loan|lease/)
  })

  it('returns [] for empty need text and caps the query count', () => {
    expect(buildNeedWebQueries('', null, nonprofitContext)).toEqual([])
    const queries = buildNeedWebQueries('passenger van', expandNeed('passenger van'), nonprofitContext, { maxQueries: 2 })
    expect(queries.length).toBeLessThanOrEqual(2)
  })
})

describe('searchNeedWebLeads', () => {
  // NOTE: braces matter — `() => mock.mockReset()` RETURNS the mock, and
  // vitest treats a beforeEach return value as a cleanup callback (it would
  // invoke the mock after the test, tripping the rejection-mock tests).
  beforeEach(() => {
    searchWebMock.mockReset()
  })

  it('returns deduped leads with honest provenance and NO invented fields', async () => {
    searchWebMock.mockResolvedValue([
      {
        url: 'https://www.mass.gov/how-to/apply-for-an-accessible-vehicle',
        title: 'Apply for an accessible vehicle through the Community Transit Grant Program',
        snippet: 'Nonprofits may apply for a passenger van through the state grant program.',
      },
      {
        // Same URL with trailing slash — must be deduped.
        url: 'https://www.mass.gov/how-to/apply-for-an-accessible-vehicle/',
        title: 'Apply for an accessible vehicle',
        snippet: 'Duplicate hit.',
      },
    ])

    const expanded = expandNeed('passenger van')
    const { opportunities, debug } = await searchNeedWebLeads({
      needText: 'passenger van',
      expandedNeed: expanded,
      profileContext: nonprofitContext,
    })

    expect(searchWebMock).toHaveBeenCalled()
    expect(debug.queries.length).toBeGreaterThan(0)
    expect(opportunities.length).toBe(1)

    const lead = opportunities[0]
    // Provenance is explicit — the UI renders these as labeled web leads.
    expect(lead.record_origin).toBe('web_search')
    expect(lead.source).toBe('web_search')
    expect(lead.is_lead).toBe(true)
    // The URL is the REAL search hit, unmodified.
    expect(lead.url).toBe('https://www.mass.gov/how-to/apply-for-an-accessible-vehicle')
    // Canonical G0 (no fabrication): a lead never invents an application
    // target, award amount, or deadline.
    expect(lead.application_url).toBeNull()
    expect(lead.amount_min).toBeUndefined()
    expect(lead.amount_max).toBeUndefined()
    expect(lead.deadline).toBeUndefined()
    expect(lead.match_reasons[0]).toMatch(/^Discovered via web search: /)
  })

  it('NEVER throws when searchWeb fails — degrades to zero leads', async () => {
    searchWebMock.mockImplementation(async () => {
      throw new Error('network down')
    })
    const { opportunities } = await searchNeedWebLeads({
      needText: 'passenger van',
      expandedNeed: expandNeed('passenger van'),
      profileContext: nonprofitContext,
    })
    expect(opportunities).toEqual([])
  })
})
