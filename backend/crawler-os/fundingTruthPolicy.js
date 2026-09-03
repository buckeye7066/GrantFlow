/**
 * Crawler OS four-truth funding contract.
 *
 * A direct opportunity may be recommended or surfaced only when the persisted
 * proof shows all four positive truths: real, relatable, meets a declared
 * profile need, and the profile qualifies. Pointers/directories are research
 * leads and are governed separately by the surfacing policy.
 *
 * This module is deliberately pure and lives inside Crawler OS so discovery
 * can enforce the contract without crossing the OS package boundary. The
 * backend config facade re-exports these exact functions for every other
 * reader, keeping one authority repo-wide.
 */

const POSITIVE_ELIGIBILITY = new Set(['yes', 'eligible', 'qualified', 'true'])
const POSITIVE_REALITY = new Set(['VERIFIED', 'ROLLING'])

function parseObject(value) {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Read the proof from an in-memory decision, API row, or persisted match row. */
export function fundingTruthProofFrom(value) {
  if (!value) return null
  if (value.direct_funding !== undefined && value.real && value.relatable) return value
  if (value.four_truth_proof) return parseObject(value.four_truth_proof)
  if (value.match_explain?.four_truth_proof) return parseObject(value.match_explain.four_truth_proof)
  const explain = parseObject(value.match_explain_json)
  return parseObject(explain?.four_truth_proof)
}

/**
 * Validate every proof leg independently. all_passed is a summary, not
 * authority: a malformed payload cannot pass merely by setting that aggregate
 * boolean.
 */
export function hasPositiveFourTruthProof(value) {
  const proof = fundingTruthProofFrom(value)
  const realityStatus = String(proof?.real?.reality_status ?? '').trim().toUpperCase()
  const capturedAt = Date.parse(String(proof?.real?.evidence_captured_at ?? ''))
  const matchedNeeds = proof?.meets_profile_need?.matched_needs
  const eligibility = String(proof?.profile_qualifies?.eligibility ?? '').trim().toLowerCase()

  return proof?.direct_funding === true &&
    proof?.all_passed === true &&
    proof?.real?.passed === true &&
    POSITIVE_REALITY.has(realityStatus) &&
    Boolean(proof?.real?.evidence_url) &&
    proof?.real?.content_hash_present === true &&
    Number.isFinite(capturedAt) &&
    proof?.relatable?.passed === true &&
    String(proof?.relatable?.canonical_decision ?? '').trim().toUpperCase() === 'ACCEPT' &&
    proof?.meets_profile_need?.passed === true &&
    proof?.meets_profile_need?.profile_needs_defaulted === false &&
    Array.isArray(matchedNeeds) && matchedNeeds.length > 0 &&
    proof?.profile_qualifies?.passed === true &&
    POSITIVE_ELIGIBILITY.has(eligibility)
}

/** A direct recommendation requires both the current ACCEPT and positive proof. */
export function isVerifiedDirectFundingRecommendation(opportunity, decision) {
  if (!opportunity || !decision) return false
  return String(decision.decision ?? decision.match_decision ?? '').trim().toUpperCase() === 'ACCEPT' &&
    hasPositiveFourTruthProof(decision)
}

export default {
  fundingTruthProofFrom,
  hasPositiveFourTruthProof,
  isVerifiedDirectFundingRecommendation,
}
