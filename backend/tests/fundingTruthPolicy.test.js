import { describe, expect, it } from 'vitest'

import {
  fundingTruthProofFrom,
  hasPositiveFourTruthProof,
  isVerifiedDirectFundingRecommendation,
} from '../config/fundingTruthPolicy.js'

const positive = {
  direct_funding: true,
  all_passed: true,
  real: {
    passed: true,
    reality_status: 'VERIFIED',
    evidence_url: 'https://funder.example/apply',
    evidence_captured_at: '2026-09-03T00:00:00.000Z',
    content_hash_present: true,
  },
  relatable: { passed: true, canonical_decision: 'ACCEPT' },
  meets_profile_need: {
    passed: true,
    matched_needs: ['transportation'],
    profile_needs_defaulted: false,
  },
  profile_qualifies: { passed: true, eligibility: 'eligible' },
}

describe('fundingTruthPolicy', () => {
  it('reads persisted and in-memory proof shapes', () => {
    expect(fundingTruthProofFrom(positive)).toBe(positive)
    expect(fundingTruthProofFrom({ match_explain: { four_truth_proof: positive } })).toBe(positive)
    expect(fundingTruthProofFrom({
      match_explain_json: JSON.stringify({ four_truth_proof: positive }),
    })).toEqual(positive)
  })

  it('requires every leg rather than trusting all_passed', () => {
    expect(hasPositiveFourTruthProof(positive)).toBe(true)
    expect(hasPositiveFourTruthProof({
      ...positive,
      profile_qualifies: { passed: false, eligibility: 'no' },
    })).toBe(false)
    expect(hasPositiveFourTruthProof({
      ...positive,
      meets_profile_need: { ...positive.meets_profile_need, matched_needs: [] },
    })).toBe(false)
    expect(hasPositiveFourTruthProof({
      ...positive,
      real: { ...positive.real, content_hash_present: false },
    })).toBe(false)
  })

  it('requires the current decision to remain ACCEPT', () => {
    expect(isVerifiedDirectFundingRecommendation(
      { id: 'opp-1' },
      { decision: 'ACCEPT', match_explain: { four_truth_proof: positive } },
    )).toBe(true)
    expect(isVerifiedDirectFundingRecommendation(
      { id: 'opp-1' },
      { decision: 'REVIEW', match_explain: { four_truth_proof: positive } },
    )).toBe(false)
  })
})
