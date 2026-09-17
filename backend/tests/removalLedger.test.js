/**
 * Removal ledger — every candidate a discovery selector loads must land in
 * exactly one bucket (returned, or a named removal), or the ledger says so.
 */
import { describe, it, expect } from 'vitest'
import { displayRefusal, qualifiesForDisplay } from '../config/matchSurfacing.js'
import { buildRemovalLedger, tallyDisplayRefusals } from '../services/matching/removalLedger.js'
import { loadRegressionFixture, CASE_IDS } from './fixtures/regression/anastasia-2026-09-17/index.js'

const fixture = loadRegressionFixture()

function provenAcceptRow() {
  const match = fixture.matchByOpportunityId(CASE_IDS.jacksonvilleNoGeo)
  const opp = fixture.opportunityById(CASE_IDS.jacksonvilleNoGeo)
  return {
    ...opp,
    match_decision: match.match_decision,
    match_score: match.match_score,
    match_explain_json: match.match_explain_json,
    is_active: 1,
    is_hidden: 0,
  }
}

describe('displayRefusal — a refused row always names its reason', () => {
  it('returns null for a row qualifiesForDisplay accepts (captured proven accept)', () => {
    const row = provenAcceptRow()
    expect(qualifiesForDisplay(row, 7)).toBe(true)
    expect(displayRefusal(row, 7)).toBeNull()
  })

  it('names a canonical reject regardless of score', () => {
    const row = { ...provenAcceptRow(), match_decision: 'reject', match_score: 80 }
    expect(qualifiesForDisplay(row, 7)).toBe(false)
    expect(displayRefusal(row, 7)).toEqual({ reason: 'rejected', failed: ['decision'] })
  })

  it('names a review row (held for a human, never direct funding)', () => {
    const row = { ...provenAcceptRow(), match_decision: 'review' }
    expect(displayRefusal(row, 7)).toEqual({ reason: 'review_not_accept', failed: ['decision'] })
  })

  it('names lifecycle quarantine before any decision reading', () => {
    const row = { ...provenAcceptRow(), is_hidden: 1 }
    expect(displayRefusal(row, 7)).toEqual({ reason: 'lifecycle', failed: ['lifecycle'] })
  })

  it('names the failed four-truth legs for an unproven direct ACCEPT', () => {
    const row = { ...provenAcceptRow(), match_explain_json: JSON.stringify({ canonical_decision: 'ACCEPT' }) }
    const refusal = displayRefusal(row, 7)
    expect(refusal.reason).toBe('four_truth_unproven')
    expect(refusal.failed).toEqual(expect.arrayContaining(['real', 'relatable', 'meets_profile_need', 'profile_qualifies']))
  })

  it('defers to the pointer refusal for directory rows', () => {
    const row = { ...provenAcceptRow(), opportunity_kind: 'DIRECTORY', match_decision: 'reject' }
    expect(displayRefusal(row, 7)).toEqual({ reason: 'pointer_rejected', failed: ['decision'] })
  })

  it('tallies refusals by reason and ignores qualifying rows', () => {
    const rows = [
      provenAcceptRow(),
      { ...provenAcceptRow(), match_decision: 'reject' },
      { ...provenAcceptRow(), match_decision: 'reject' },
      { ...provenAcceptRow(), match_decision: 'review' },
    ]
    expect(tallyDisplayRefusals(rows, 7)).toEqual({ rejected: 2, review_not_accept: 1 })
  })
})

describe('buildRemovalLedger — arithmetic reconciliation', () => {
  it('reconciles a primary pass with no recovery', () => {
    const ledger = buildRemovalLedger({
      loaded: 10,
      canonicalDropped: { decision: 2, trust: 1 },
      filterRemoved: 1,
      displayRefused: { review_not_accept: 2 },
      truthBoundaryRemoved: 0,
      dedupeRemoved: 1,
      pipelineExcluded: 1,
      returned: 2,
    })
    expect(ledger.removed_total).toBe(8)
    expect(ledger.reconciles).toBe(true)
    expect(ledger.unaccounted).toBe(0)
    expect(ledger.recovery).toBeNull()
  })

  it('reconciles a G2 recovery pass that re-admitted refused rows', () => {
    // 5 loaded → 0 qualified (all 5 refused as review) → ladder re-admits 3 →
    // truth boundary removes 3 (review rows are never direct funding) → 0 returned.
    const ledger = buildRemovalLedger({
      loaded: 5,
      canonicalDropped: {},
      displayRefused: { review_not_accept: 5 },
      recovery: { tier: 'RELAXED_DIRECT', readmitted: 3 },
      truthBoundaryRemoved: 3,
      returned: 0,
    })
    expect(ledger.recovery).toEqual({ tier: 'RELAXED_DIRECT', readmitted: 3 })
    expect(ledger.reconciles).toBe(true)
  })

  it('flags an unaccounted row instead of hiding it', () => {
    const ledger = buildRemovalLedger({ loaded: 4, canonicalDropped: { decision: 1 }, returned: 2 })
    expect(ledger.reconciles).toBe(false)
    expect(ledger.unaccounted).toBe(1)
  })

  it('never lets malformed counts go negative or NaN', () => {
    const ledger = buildRemovalLedger({ loaded: 'x', returned: -3, filterRemoved: NaN, canonicalDropped: { a: 'b' } })
    expect(ledger.loaded).toBe(0)
    expect(ledger.returned).toBe(0)
    expect(ledger.removed.filter).toBe(0)
    expect(ledger.removed_total).toBe(0)
    expect(ledger.reconciles).toBe(true)
  })
})
