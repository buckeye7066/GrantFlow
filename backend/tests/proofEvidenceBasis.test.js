/**
 * evidence_basis on the four-truth proof (2026-09-17, result-quality PR3).
 *
 * The legs' `passed` booleans are unchanged; this block records how much
 * evidence stood behind `profile_qualifies` and `relatable` so no surface can
 * say "eligibility and location check out" over a row that stated neither.
 */
import { describe, it, expect } from 'vitest'
import { proofEvidenceBasis, refreshFourTruthProof, hasPositiveFourTruthProof } from '../config/fundingTruthPolicy.js'
import { buildFourTruthProof } from '../crawler-os/matchEngine.js'
import { loadRegressionFixture, CASE_IDS } from './fixtures/regression/tn-student-2026-09-17/index.js'

const fixture = loadRegressionFixture()

describe('proofEvidenceBasis', () => {
  it('prefers the engine-recorded eligibility_evidence', () => {
    expect(proofEvidenceBasis({ eligibility_evidence: 'structured_flags' }, { geography: { national: true, states: [] } }))
      .toEqual({ eligibility: 'structured_flags', geography: 'national' })
    expect(proofEvidenceBasis({ match_explain: { eligibility_evidence: 'none' } }, { state: 'TN' }))
      .toEqual({ eligibility: 'none', geography: 'stated' })
  })

  it('derives eligibility from the row when the decision predates the level (prose > applicant types > unknown)', () => {
    expect(proofEvidenceBasis({}, { eligibility_text: 'Must be enrolled full-time.', state: 'TN' }).eligibility).toBe('prose')
    expect(proofEvidenceBasis({}, { eligibility_bullets: '["TN residents"]', state: 'TN' }).eligibility).toBe('prose')
    expect(proofEvidenceBasis({}, { entity_types_allowed: '["individual"]', state: 'TN' }).eligibility).toBe('applicant_types_only')
    expect(proofEvidenceBasis({}, { state: 'TN' }).eligibility).toBe('unknown')
  })

  it('reads geography from an OS opportunity or a catalog row, and never guesses', () => {
    expect(proofEvidenceBasis({}, { geography: { national: false, states: ['NC'] } }).geography).toBe('stated')
    expect(proofEvidenceBasis({}, { geography: { national: false, states: [] } }).geography).toBe('unknown')
    expect(proofEvidenceBasis({}, { is_national: 1 }).geography).toBe('national')
    expect(proofEvidenceBasis({}, { is_national: 'false', state: null }).geography).toBe('unknown')
    expect(proofEvidenceBasis({}, { geo_eligibility: '{"national":false,"states":["TN"]}' }).geography).toBe('stated')
    expect(proofEvidenceBasis({}, null)).toEqual({ eligibility: 'unknown', geography: 'unknown' })
  })

  it('falls back to the previous proof only when the row itself says nothing', () => {
    const previous = { evidence_basis: { eligibility: 'prose', geography: 'stated' } }
    expect(proofEvidenceBasis({}, {}, previous)).toEqual({ eligibility: 'prose', geography: 'stated' })
    expect(proofEvidenceBasis({ eligibility_evidence: 'none' }, { is_national: true }, previous))
      .toEqual({ eligibility: 'none', geography: 'national' })
  })
})

describe('the captured 2026-09-17 rows, as the card will now read them', () => {
  it('Jacksonville (state NULL): eligibility prose stated, service area unknown', () => {
    const row = fixture.opportunityById(CASE_IDS.jacksonvilleNoGeo)
    const explain = fixture.parseExplain(fixture.matchByOpportunityId(CASE_IDS.jacksonvilleNoGeo))
    const basis = proofEvidenceBasis({ match_explain: explain }, row, explain.four_truth_proof)
    expect(basis).toEqual({ eligibility: 'prose', geography: 'unknown' })
  })

  it('ECF Family Caregiver Stipend (no eligibility text): applicant types only, location stated', () => {
    const row = fixture.opportunityById(CASE_IDS.ecfCaregiverStipend)
    const explain = fixture.parseExplain(fixture.matchByOpportunityId(CASE_IDS.ecfCaregiverStipend))
    // The captured decision predates eligibility_evidence; the row has entity_types_allowed
    // from the adapter config and no prose, so the honest basis is applicant types only.
    const basis = proofEvidenceBasis({ match_explain: explain }, row, explain.four_truth_proof)
    expect(basis.eligibility).not.toBe('prose')
    expect(basis.geography).toBe('stated')
  })
})

describe('both proof builders emit evidence_basis without changing what they prove', () => {
  const canonical = {
    decision: 'ACCEPT',
    score: 40,
    eligible: true,
    eligibility_evidence: 'applicant_types_only',
    matchedNeeds: ['housing'],
    missingEligibilityFields: [],
    match_explain: { matchedSignals: ['applicant_type', 'needs'], applicant_type_gate: { decision: 'pass', matched_bucket: 'individual' } },
  }

  it('buildFourTruthProof (crawler-os) — OS-normalized opportunity', () => {
    const opportunity = {
      kind: 'DIRECT_GRANT',
      applicant_types: ['individual'],
      geography: { national: false, states: [] },
      reality_status: 'verified',
      evidence: { url: 'https://example.org/x', content_hash: 'abc', fetched_at: '2026-09-17T00:00:00Z' },
    }
    const proof = buildFourTruthProof(opportunity, { needs_defaulted: false }, canonical, { realityPassed: true })
    expect(proof.evidence_basis).toEqual({ eligibility: 'applicant_types_only', geography: 'unknown' })
    // The legs are what they were: a stated applicant type still qualifies.
    expect(proof.profile_qualifies.passed).toBe(true)
    expect(proof.all_passed).toBe(true)
    expect(hasPositiveFourTruthProof({ four_truth_proof: proof })).toBe(true)
  })

  it('refreshFourTruthProof — catalog row, carrying the REAL leg', () => {
    const previous = {
      direct_funding: true,
      real: { passed: true, reality_status: 'verified', evidence_url: 'https://example.org/x', evidence_captured_at: '2026-09-17T00:00:00Z', content_hash_present: true },
      relatable: { passed: true, canonical_decision: 'ACCEPT', score: 40 },
      meets_profile_need: { passed: true, matched_needs: ['housing'], profile_needs_defaulted: false },
      profile_qualifies: { passed: true, eligibility: true, applicant_type_evidence: ['individual'], eligibility_prose_evidence: [] },
    }
    const proof = refreshFourTruthProof(previous, {
      canonical,
      opportunity: { entity_types_allowed: '["individual"]', state: 'TN', is_national: 0 },
      needsDefaulted: false,
    })
    expect(proof.evidence_basis).toEqual({ eligibility: 'applicant_types_only', geography: 'stated' })
    expect(proof.relatable).toEqual({ passed: true, canonical_decision: 'ACCEPT', score: 40 })
  })
})
