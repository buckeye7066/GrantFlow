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
import { buildFourTruthProof } from '../crawler-os/matchEngine.js'

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

// 2026-09-11: an independent review of 24 surfaced direct ACCEPTs against the
// funders' own pages found 15 false. The reviewed catalog-rescore-link rows
// stated no applicant types and proved profile_qualifies on page copy. These
// cases use the reviewed rows' verbatim eligibility text.
describe('applicant evidence: the funder must say who may apply', () => {
  const gatePass = (bucket) => ({ decision: 'pass', reason: null, matched_bucket: bucket })
  const accepted = (bucket) => canonical({
    match_explain: { matchedSignals: ['applicant_type', 'needs'], applicant_type_gate: gatePass(bucket) },
  })
  const NO_PRIOR_EVIDENCE = Object.freeze({
    ...PREVIOUS,
    profile_qualifies: { ...PREVIOUS.profile_qualifies, applicant_type_evidence: [], eligibility_prose_evidence: [] },
  })
  const qualifies = (opportunity, decision = accepted('individual')) =>
    refreshFourTruthProof(NO_PRIOR_EVIDENCE, { canonical: decision, opportunity, needsDefaulted: false }).profile_qualifies

  it('page copy with no stated applicant types does not qualify, even with the engine signal', () => {
    for (const text of ['Career Services', 'High Job Placement Rate', 'Scholarships & Waivers - Apply Now']) {
      const leg = qualifies({ entity_types_allowed: '[]', eligibility_text: text })
      expect(leg.passed, text).toBe(false)
      expect(leg.applicant_evidence_via).toBeNull()
    }
  })

  it('prose that names a different applicant class does not qualify an individual', () => {
    for (const text of [
      'Local Educational Agencies (LEAs) State Educational Agencies (SEAs)',
      'Grants are awarded to qualifying organizations including non-profits that are tax exempt',
    ]) {
      expect(qualifies({ entity_types_allowed: '[]', eligibility_text: text }).passed, text).toBe(false)
    }
  })

  it('prose that names the matched applicant class qualifies and records why', () => {
    const leg = qualifies({ eligibility_text: 'Open to individual homeowners in the county.' })
    expect(leg.passed).toBe(true)
    expect(leg.applicant_evidence_via).toBe('eligibility_prose:individual')
  })

  it('a token inside a longer word is not evidence', () => {
    expect(qualifies({ eligibility_text: 'Nominated by the college president.' }).passed).toBe(false)
  })

  it('reads stored eligibility bullets written as JSON objects', () => {
    const leg = qualifies({ eligibility_bullets: ['{"text":"Open to veterans and their families","bullets":[]}'] })
    expect(leg.passed).toBe(true)
    expect(leg.applicant_evidence_via).toMatch(/^eligibility_prose:/)
  })

  it('stated applicant types still qualify without prose', () => {
    const leg = qualifies({ entity_types_allowed: '["student"]' }, accepted('individual'))
    expect(leg.passed).toBe(true)
    expect(leg.applicant_evidence_via).toBe('stated_applicant_types')
  })

  it('an official unrestricted applicant code captured from the award detail is evidence', () => {
    const leg = qualifies({
      entity_types_allowed: '[]',
      field_provenance: { applicant_types: {
        source: 'grants.gov', method: 'fetchOpportunity', allowed_codes: ['99'],
        value: ['Unrestricted (open to any type of entity)'],
      } },
    })
    expect(leg.passed).toBe(true)
    expect(leg.applicant_evidence_via).toBe('unrestricted_applicant_code')
  })

  it("a lane's ['*'] fallback states nothing and is not evidence", () => {
    expect(qualifies({ entity_types_allowed: '["*"]' }).passed).toBe(false)
  })

  it("the engine's applicant-type gate pass counts as its match even without the applicant_type signal", () => {
    // TennCare 1915(c) waivers for an owner-verified enrollee (prod 2026-09-12):
    // the gate passed on the row's stated types, matchedSignals had no applicant_type.
    const gateOnly = canonical({
      match_explain: {
        matchedSignals: ['geo:state', 'keywords', 'category', 'needs'],
        applicant_type_gate: { decision: 'pass', reason: 'explicit_applicant_types_match', matched_bucket: 'individual' },
      },
    })
    const leg = qualifies({ entity_types_allowed: '["individual","family","veteran","disabled","caregiver"]' }, gateOnly)
    expect(leg.passed).toBe(true)
    expect(leg.applicant_evidence_via).toBe('stated_applicant_types')

    const neither = canonical({
      match_explain: { matchedSignals: ['geo:state', 'needs'], applicant_type_gate: { decision: 'review', matched_bucket: null } },
    })
    expect(qualifies({ entity_types_allowed: '["individual"]' }, neither).passed).toBe(false)
  })

  it('without a matched applicant bucket, prose cannot be evidence', () => {
    const noBucket = canonical({ match_explain: { matchedSignals: ['applicant_type', 'needs'] } })
    expect(qualifies({ eligibility_text: 'Open to individuals who live in the county' }, noBucket).passed).toBe(false)
  })

  it('the crawler-os proof builder applies the same rule', () => {
    const opportunity = {
      kind: 'DIRECT_GRANT',
      reality_status: 'VERIFIED',
      evidence: { url: 'https://example.org/program', content_hash: 'abc123', fetched_at: '2026-09-11T00:00:00Z' },
      applicant_types: [],
      eligibility_text: 'Career Services',
    }
    const decision = {
      decision: 'ACCEPT', score: 19, eligible: true, matchedNeeds: ['employment'],
      match_explain: { matchedSignals: ['applicant_type', 'needs'], applicant_type_gate: gatePass('individual') },
    }
    const thesis = { needs_defaulted: false }
    expect(buildFourTruthProof(opportunity, thesis, decision, { realityPassed: true }).profile_qualifies.passed).toBe(false)
    const named = { ...opportunity, eligibility_text: 'Open to individuals who live in the county' }
    expect(buildFourTruthProof(named, thesis, decision, { realityPassed: true }).profile_qualifies.passed).toBe(true)
  })
})
