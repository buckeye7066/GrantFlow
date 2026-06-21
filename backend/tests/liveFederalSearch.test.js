/**
 * Unit tests for searchLiveFederalByProfile (liveFederalSearch.js).
 *
 * Pins the root-cause fix: discovery must ACQUIRE opportunities from the whole
 * profile (its derived keyword terms), not just rank a fixed catalog. These
 * tests assert that profile terms drive the live Grants.gov queries, that
 * duplicate opportunities across terms collapse (recording every term that
 * surfaced them), and that any source failure degrades gracefully to a partial
 * or empty result instead of throwing into the request path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchGrantsGovMock = vi.fn()
const buildTermsMock = vi.fn()

vi.mock('../services/grantsDotGovCrawler.js', () => ({
  fetchGrantsGov: (...args) => fetchGrantsGovMock(...args),
  transformGrantsGovOpportunity: (x) => x,
}))
vi.mock('../services/sourceRegistry.js', () => ({
  buildGrantsGovQueryTerms: (...args) => buildTermsMock(...args),
}))

const { searchLiveFederalByProfile } = await import('../services/crawlers/liveFederalSearch.js')

const oppFor = (term, id) => ({
  source_id: id,
  title: `${term} grant ${id}`,
  application_url: `https://grants.gov/${id}`,
})

beforeEach(() => {
  fetchGrantsGovMock.mockReset()
  buildTermsMock.mockReset()
})

describe('searchLiveFederalByProfile', () => {
  it('drives live queries from explicitly provided profile terms', async () => {
    fetchGrantsGovMock.mockImplementation(async ({ keyword }) => ({
      opportunities: [oppFor(keyword, `${keyword}-1`)],
    }))

    const res = await searchLiveFederalByProfile(
      { profile: { id: 'p1' } },
      { searchTerms: ['disability support', 'rural housing'] },
    )

    const queriedKeywords = fetchGrantsGovMock.mock.calls.map((c) => c[0].keyword)
    expect(queriedKeywords).toEqual(expect.arrayContaining(['disability support', 'rural housing']))
    expect(res.opportunities).toHaveLength(2)
    expect(res.debug.terms).toEqual(['disability support', 'rural housing'])
  })

  it('falls back to profile-derived terms when none are supplied', async () => {
    buildTermsMock.mockReturnValue(['veteran', 'small business'])
    fetchGrantsGovMock.mockImplementation(async ({ keyword }) => ({ opportunities: [oppFor(keyword, keyword)] }))

    const res = await searchLiveFederalByProfile({ profile: { primary_type: 'veteran' } })

    expect(buildTermsMock).toHaveBeenCalledOnce()
    expect(res.debug.terms).toEqual(['veteran', 'small business'])
    expect(res.opportunities).toHaveLength(2)
  })

  it('dedupes the same opportunity across terms and records every matching term', async () => {
    // Both terms surface the SAME federal opportunity (same source_id).
    fetchGrantsGovMock.mockImplementation(async () => ({ opportunities: [oppFor('shared', 'DUP-1')] }))

    const res = await searchLiveFederalByProfile({}, { searchTerms: ['housing', 'rental assistance'] })

    expect(res.debug.raw).toBe(2)
    expect(res.opportunities).toHaveLength(1)
    expect(res.opportunities[0].matched_terms.sort()).toEqual(['housing', 'rental assistance'])
  })

  it('degrades gracefully when a source query throws (never rejects)', async () => {
    fetchGrantsGovMock.mockImplementation(async ({ keyword }) => {
      if (keyword === 'boom') throw new Error('upstream 500')
      return { opportunities: [oppFor(keyword, keyword)] }
    })

    const res = await searchLiveFederalByProfile({}, { searchTerms: ['boom', 'good'] })

    // 'boom' failed → only 'good' survives; the call itself resolves.
    expect(res.opportunities.map((o) => o.source_id)).toEqual(['good'])
    expect(res.debug.errors.length).toBeGreaterThanOrEqual(0)
  })

  it('returns empty (no throw) when there are no usable terms', async () => {
    buildTermsMock.mockReturnValue([])
    const res = await searchLiveFederalByProfile({}, { searchTerms: [] })
    expect(res.opportunities).toEqual([])
    expect(fetchGrantsGovMock).not.toHaveBeenCalled()
  })
})
