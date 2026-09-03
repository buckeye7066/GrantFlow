/**
 * Explicit proof for tests that intend to model a surfaced direct ACCEPT.
 *
 * Production never receives this helper. Tests must opt in so an unproven
 * ACCEPT remains hidden by default, matching the runtime contract.
 */
export const VERIFIED_FOUR_TRUTH_PROOF = Object.freeze({
  direct_funding: true,
  all_passed: true,
  real: Object.freeze({
    passed: true,
    reality_status: 'VERIFIED',
    evidence_url: 'https://www.grants.gov/search-results-detail/test-fixture',
    content_hash_present: true,
    evidence_captured_at: '2026-09-01T00:00:00.000Z',
  }),
  relatable: Object.freeze({
    passed: true,
    canonical_decision: 'ACCEPT',
  }),
  meets_profile_need: Object.freeze({
    passed: true,
    profile_needs_defaulted: false,
    matched_needs: Object.freeze(['fixture_need']),
  }),
  profile_qualifies: Object.freeze({
    passed: true,
    eligibility: 'eligible',
  }),
})

function parseExplain(value) {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function verifiedFourTruthExplain(existing = {}) {
  return JSON.stringify({
    ...parseExplain(existing),
    four_truth_proof: VERIFIED_FOUR_TRUTH_PROOF,
  })
}

export function withVerifiedFourTruth(row = {}) {
  return {
    ...row,
    four_truth_proof: row.four_truth_proof || VERIFIED_FOUR_TRUTH_PROOF,
    match_explain_json: verifiedFourTruthExplain(
      row.match_explain_json || row.match_explain || {},
    ),
  }
}
