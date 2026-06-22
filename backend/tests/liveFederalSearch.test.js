/**
 * Unit tests for searchLiveFederalByProfile (liveFederalSearch.js).
 *
 * Pins the root-cause fix: discovery must ACQUIRE opportunities from the whole
 * profile (its derived keyword terms) across EVERY federal source, not just
 * rank a fixed catalog. These tests assert that profile terms drive each
 * source's queries, that results merge/dedupe across sources, and that any one
 * source failing degrades gracefully instead of starving the others or throwing
 * into the request path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchGrantsGovMock = vi.fn()
const fetchSamGovMock = vi.fn()
const fetchUSASpendingMock = vi.fn()
const fetchNihMock = vi.fn()
const buildTermsMock = vi.fn()

// Mock the NORMALIZED shim that liveFederalSearch actually imports (returns
// { opportunities }). Mocking the raw grantsDotGovCrawler here previously masked
// a real shape bug where the live search read .opportunities off a { oppHits }
// response and silently got ZERO Grants.gov results.
vi.mock('../services/sources/grantsGov.js', () => ({
  fetchGrantsGov: (...a) => fetchGrantsGovMock(...a),
}))
vi.mock('../services/sources/samGov.js', () => ({ fetchSamGov: (...a) => fetchSamGovMock(...a) }))
vi.mock('../services/sources/usaSpending.js', () => ({ fetchUSASpending: (...a) => fetchUSASpendingMock(...a) }))
vi.mock('../src/integrations/nihReporter.js', () => ({ fetchOpportunities: (...a) => fetchNihMock(...a) }))
vi.mock('../services/sourceRegistry.js', () => ({ buildGrantsGovQueryTerms: (...a) => buildTermsMock(...a) }))

const { searchLiveFederalByProfile } = await import('../services/shared/liveFederalSearch.js')

const opp = (source, id, extra = {}) => ({
  source,
  source_id: id,
  title: `${source} ${id}`,
  application_url: `https://example.gov/${source}/${id}`,
  ...extra,
})

beforeEach(() => {
  for (const m of [fetchGrantsGovMock, fetchSamGovMock, fetchUSASpendingMock, fetchNihMock, buildTermsMock]) m.mockReset()
  // Sensible defaults: each source returns one row tagged to its keyword/terms.
  fetchGrantsGovMock.mockImplementation(async ({ keyword }) => ({ opportunities: [opp('grants.gov', keyword)] }))
  fetchSamGovMock.mockImplementation(async ({ keyword }) => ({ opportunities: [opp('sam.gov', keyword)] }))
  fetchUSASpendingMock.mockImplementation(async () => ({ opportunities: [opp('usaspending.gov', 'past-1', { is_active: 0 })] }))
  fetchNihMock.mockImplementation(async () => [opp('nih.reporter', 'proj-1')])
})

describe('searchLiveFederalByProfile (multi-source)', () => {
  it('drives every source from the profile terms and merges results', async () => {
    const res = await searchLiveFederalByProfile({ profile: { id: 'p1' } }, { searchTerms: ['disability', 'housing'] })

    // Grants.gov + SAM.gov are per-term; USASpending + NIH are single-call.
    expect(fetchGrantsGovMock.mock.calls.map((c) => c[0].keyword)).toEqual(
      expect.arrayContaining(['disability', 'housing']),
    )
    expect(fetchSamGovMock.mock.calls.map((c) => c[0].keyword)).toEqual(
      expect.arrayContaining(['disability', 'housing']),
    )
    expect(fetchUSASpendingMock).toHaveBeenCalledOnce()
    expect(fetchUSASpendingMock.mock.calls[0][0].keywords).toEqual(['disability', 'housing'])
    expect(fetchNihMock).toHaveBeenCalledOnce()
    expect(fetchNihMock.mock.calls[0][0].text).toBe('disability, housing')

    const sources = new Set(res.opportunities.map((o) => o.source))
    expect(sources).toEqual(new Set(['grants.gov', 'sam.gov', 'usaspending.gov', 'nih.reporter']))
  })

  it('preserves the USASpending past-award (is_active=0) row for the caller to treat as intelligence', async () => {
    const res = await searchLiveFederalByProfile({}, { searchTerms: ['research'] })
    const usa = res.opportunities.find((o) => o.source === 'usaspending.gov')
    expect(usa).toBeTruthy()
    expect(usa.is_active).toBe(0) // caller (route) excludes these from display, keeps for persistence
  })

  it('isolates a failing source — others still return', async () => {
    fetchSamGovMock.mockRejectedValue(new Error('SAM 503'))
    const res = await searchLiveFederalByProfile({}, { searchTerms: ['veteran'] })

    const sources = new Set(res.opportunities.map((o) => o.source))
    expect(sources.has('sam.gov')).toBe(false)
    expect(sources.has('grants.gov')).toBe(true)
    expect(res.debug.sources['sam_gov'].count).toBe(0)
  })

  it('dedupes the same source row across terms and records every matching term', async () => {
    fetchGrantsGovMock.mockImplementation(async () => ({ opportunities: [opp('grants.gov', 'DUP-1')] }))
    fetchSamGovMock.mockImplementation(async () => ({ opportunities: [] }))
    fetchUSASpendingMock.mockImplementation(async () => ({ opportunities: [] }))
    fetchNihMock.mockImplementation(async () => [])

    const res = await searchLiveFederalByProfile({}, { searchTerms: ['a', 'b'] })
    const dup = res.opportunities.filter((o) => o.source_id === 'DUP-1')
    expect(dup).toHaveLength(1)
    expect(dup[0].matched_terms.sort()).toEqual(['a', 'b'])
  })

  it('can restrict to a subset of sources', async () => {
    const res = await searchLiveFederalByProfile({}, { searchTerms: ['x'], sources: ['grants_gov'] })
    expect(fetchSamGovMock).not.toHaveBeenCalled()
    expect(fetchUSASpendingMock).not.toHaveBeenCalled()
    expect(res.opportunities.every((o) => o.source === 'grants.gov')).toBe(true)
  })

  it('falls back to profile-derived terms and returns empty (no throw) when none', async () => {
    buildTermsMock.mockReturnValue([])
    const res = await searchLiveFederalByProfile({}, { searchTerms: [] })
    expect(res.opportunities).toEqual([])
    expect(fetchGrantsGovMock).not.toHaveBeenCalled()
  })
})
