/**
 * refreshFourTruthProof — the REAL leg is capture-time evidence and is carried
 * verbatim; the three profile-side legs are recomputed from the fresh
 * canonical decision. Nothing here manufactures reality evidence.
 */
import { describe, it, expect } from 'vitest'
import {
  refreshFourTruthProof,
  failedFourTruths,
  hasPositiveFourTruthProof,
} from '../config/fundingTruthPolicy.js'

const PREVIOUS = Object.freeze({
  direct_funding: true,
  all_passed: true,
  real: {
    gate: 'crawler_os.realityGate.enforceReality',
    passed: true,
    reality_status: 'verified',
    evidence_url: 'https://www.mtsu.edu/scholarships/',
    evidence_captured_at: '2026-09-07T17:34:30.628Z',
    content_hash_present: true,
  },
  relatable: { passed: true, canonical_decision: 'ACCEPT', score: 84 },
  meets_profile_need: { passed: true, matched_needs: ['veteran', 'education'], profile_needs_defaulted: false },
  profile_qualifies: {
    passed: true, eligibility: true, applicant_type_evidence: ['student'],
    eligibility_prose_evidence: ['Transfer students with a 3.0 GPA'], missing_eligibility_fields: [],
  },
})

const ROW = Object.freeze({
  entity_types_allowed: '["student"]',
  eligibility_text: 'Transfer students with a 3.0 GPA',
})

function canonical(overrides = {}) {
  return {
    decision: 'ACCEPT',
    score: 88,
    eligible: true,
    matchedNeeds: ['education'],
    missingEligibilityFields: [],
    match_explain: { matchedSignals: ['applicant_type', 'geo:state', 'needs'] },
    ...overrides,
  }
}

describe('refreshFourTruthProof', () => {
  it('keeps the REAL leg verbatim and recomputes the other three from the new decision', () => {
    const proof = refreshFourTruthProof(PREVIOUS, { canonical: canonical(), opportunity: ROW, needsDefaulted: false })
    expect(proof.real).toEqual(PREVIOUS.real)
    expect(proof.relatable).toEqual({ passed: true, canonical_decision: 'ACCEPT', score: 88 })
    // The stale "veteran" need is gone: needs come from THIS decision only.
    expect(proof.meets_profile_need.matched_needs).toEqual(['education'])
    expect(proof.meets_profile_need.passed).toBe(true)
    expect(proof.profile_qualifies.passed).toBe(true)
    expect(proof.all_passed).toBe(true)
    expect(hasPositiveFourTruthProof({ four_truth_proof: proof })).toBe(true)
    expect(proof.refreshed_by).toBe('stale_match_explain_refresh')
  })

  it('a REVIEW decision fails relatable, and the failed truths are named', () => {
    const proof = refreshFourTruthProof(PREVIOUS, { canonical: canonical({ decision: 'REVIEW' }), opportunity: ROW, needsDefaulted: false })
    expect(proof.relatable.passed).toBe(false)
    expect(proof.all_passed).toBe(false)
    expect(failedFourTruths(proof)).toEqual(['relatable'])
  })

  it('type-shaped default needs never satisfy meets_profile_need', () => {
    const proof = refreshFourTruthProof(PREVIOUS, { canonical: canonical(), opportunity: ROW, needsDefaulted: true })
    expect(proof.meets_profile_need.passed).toBe(false)
    expect(proof.meets_profile_need.profile_needs_defaulted).toBe(true)
    expect(failedFourTruths(proof)).toEqual(['meets_profile_need'])
  })

  it('profile_qualifies needs stated applicant evidence AND the engine matching it', () => {
    const noSignal = refreshFourTruthProof(PREVIOUS, {
      canonical: canonical({ match_explain: { matchedSignals: ['geo:state'] } }), opportunity: ROW, needsDefaulted: false,
    })
    expect(noSignal.profile_qualifies.passed).toBe(false)
    // Evidence falls back to what the previous proof recorded when the row carries none.
    const bareRow = refreshFourTruthProof(PREVIOUS, { canonical: canonical(), opportunity: {}, needsDefaulted: false })
    expect(bareRow.profile_qualifies.applicant_type_evidence).toEqual(['student'])
    expect(bareRow.profile_qualifies.passed).toBe(true)
  })

  it('returns null when there is no previous proof — reality evidence is never invented', () => {
    expect(refreshFourTruthProof(null, { canonical: canonical() })).toBeNull()
    expect(refreshFourTruthProof({ gate: 'attendance' }, { canonical: canonical() })).toBeNull()
    expect(refreshFourTruthProof({ four_truth_proof: 'not json' }, { canonical: canonical() })).toBeNull()
  })

  it('reads the proof from a persisted match row shape', () => {
    const proof = refreshFourTruthProof(
      { match_explain_json: JSON.stringify({ four_truth_proof: PREVIOUS }) },
      { canonical: canonical(), opportunity: ROW, needsDefaulted: false },
    )
    expect(proof.real.evidence_url).toBe('https://www.mtsu.edu/scholarships/')
  })
})
