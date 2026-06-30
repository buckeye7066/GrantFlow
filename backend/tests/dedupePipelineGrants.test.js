/**
 * Tests the shared pipeline-grant dedup used by BOTH /api/grants (lists) and
 * /api/pipeline/stats (funnel), so duplicate rows for the same opportunity never
 * double-count or double-list (the HMIT/Distance-Learning duplicates + the
 * "Discovery 188 vs Discovered 11" discrepancy).
 */
import { describe, it, expect } from 'vitest'
import { dedupePipelineGrants, opportunityKey } from '../../shared/dedupePipelineGrants.js'

describe('opportunityKey', () => {
  it('keys on funding_opportunity_id when present', () => {
    expect(opportunityKey({ funding_opportunity_id: 'op1', title: 'X' })).toBe('fo:op1')
  })
  it('falls back to title+funder', () => {
    expect(opportunityKey({ title: 'HMIT Grant', funder: 'NSF' })).toBe('tf:hmit grant|nsf')
    expect(opportunityKey({ title: 'HMIT Grant', sponsor: 'NSF' })).toBe('tf:hmit grant|nsf')
  })
  it('returns null when un-keyable (never merged)', () => {
    expect(opportunityKey({})).toBeNull()
  })
})

describe('dedupePipelineGrants', () => {
  it('collapses duplicate rows for the same opportunity, keeping the most-progressed', () => {
    const rows = [
      { id: 'a', funding_opportunity_id: 'op1', status: 'discovered' },
      { id: 'b', funding_opportunity_id: 'op1', status: 'drafting' }, // more progressed
      { id: 'c', funding_opportunity_id: 'op2', status: 'interested' },
    ]
    const out = dedupePipelineGrants(rows)
    expect(out).toHaveLength(2)
    const op1 = out.find((g) => g.funding_opportunity_id === 'op1')
    expect(op1.id).toBe('b') // drafting beats discovered
  })

  it('never drops an awarded duplicate', () => {
    const rows = [
      { id: 'a', funding_opportunity_id: 'op1', status: 'submitted', amount_awarded: 0 },
      { id: 'b', funding_opportunity_id: 'op1', status: 'discovered', amount_awarded: 5000 },
    ]
    const out = dedupePipelineGrants(rows)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('b') // awarded wins even though its stage is earlier
  })

  it('dedups by title+funder when funding_opportunity_id is absent', () => {
    const rows = [
      { id: 'a', title: 'Distance Learning', funder: 'DoE', status: 'discovered' },
      { id: 'b', title: 'distance learning', funder: 'doe', status: 'interested' },
    ]
    expect(dedupePipelineGrants(rows)).toHaveLength(1)
  })

  it('passes through un-keyable rows untouched', () => {
    const rows = [{ id: 'a', status: 'discovered' }, { id: 'b', status: 'discovered' }]
    expect(dedupePipelineGrants(rows)).toHaveLength(2)
  })

  it('handles empty/non-array input', () => {
    expect(dedupePipelineGrants(null)).toEqual([])
    expect(dedupePipelineGrants(undefined)).toEqual([])
  })
})
