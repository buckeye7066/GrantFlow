/**
 * Unit tests for local web search (liveWebSearch.js + webSearchEngine.js).
 *
 * Pins the local-funding gap fix: federal APIs never surface a county
 * scholarship or city foundation grant — those live on the open web. These
 * tests assert that the whole profile (geography + needs + type) drives the
 * web queries, that results become profile-tagged LEADS, that duplicate URLs
 * collapse across queries, and that the web layer degrades gracefully.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const searchWebMock = vi.fn()
vi.mock('../services/crawlers/webSearchEngine.js', () => ({
  searchWeb: (...a) => searchWebMock(...a),
}))

const { searchLocalWebByProfile, buildLocalFundingQueries } = await import(
  '../services/crawlers/liveWebSearch.js'
)

const ctx = {
  profile: { primary_type: 'individual' },
  signals: {
    location: { city: 'Cleveland', county: 'Bradley', state: 'TN' },
    needs: ['paramedic training'],
    interests: ['ems'],
  },
}

beforeEach(() => {
  searchWebMock.mockReset()
})

describe('buildLocalFundingQueries', () => {
  it('anchors queries on the profile geography and needs', () => {
    const qs = buildLocalFundingQueries(ctx)
    expect(qs.length).toBeGreaterThan(0)
    const joined = qs.join(' | ').toLowerCase()
    expect(joined).toContain('bradley county')
    expect(joined).toContain('cleveland tn')
    // a need term ("paramedic training") should drive at least one query
    expect(joined).toMatch(/paramedic/)
  })

  it('returns nothing useful when the profile has no geography or needs', () => {
    const qs = buildLocalFundingQueries({ profile: {}, signals: {} })
    // No anchors → no queries (don't emit generic national noise; that's the
    // federal layer's job).
    expect(qs).toEqual([])
  })
})

describe('searchLocalWebByProfile', () => {
  it('runs the profile queries and turns results into profile-tagged leads', async () => {
    searchWebMock.mockImplementation(async (query) => [
      { url: `https://bradleyfoundation.org/${encodeURIComponent(query)}`, title: `Lead for ${query}`, snippet: 'Apply here' },
    ])

    const res = await searchLocalWebByProfile(ctx)
    expect(searchWebMock).toHaveBeenCalled()
    expect(res.opportunities.length).toBeGreaterThan(0)
    const lead = res.opportunities[0]
    expect(lead.source).toBe('web_search')
    expect(lead.record_origin).toBe('web_search')
    expect(lead.is_lead).toBe(true)
    expect(lead.state).toBe('TN')
    expect(lead.url).toMatch(/^https?:\/\//)
  })

  it('dedupes the same URL across queries and records every query', async () => {
    // Every query returns the SAME url → must collapse to one lead.
    searchWebMock.mockImplementation(async (query) => [
      { url: 'https://example.org/grant', title: 'Shared', snippet: 's', _q: query },
    ])
    const res = await searchLocalWebByProfile(ctx)
    const matches = res.opportunities.filter((o) => o.source_id === 'https://example.org/grant')
    expect(matches).toHaveLength(1)
    expect(matches[0].matched_terms.length).toBeGreaterThan(1)
  })

  it('degrades gracefully when web search fails (no throw, empty leads)', async () => {
    searchWebMock.mockRejectedValue(new Error('network down'))
    const res = await searchLocalWebByProfile(ctx)
    expect(res.opportunities).toEqual([])
  })

  it('returns empty when there are no queries to run', async () => {
    const res = await searchLocalWebByProfile({ profile: {}, signals: {} })
    expect(res.opportunities).toEqual([])
    expect(searchWebMock).not.toHaveBeenCalled()
  })
})
