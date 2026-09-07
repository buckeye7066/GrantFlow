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

function uniqueStrings(values) {
  const out = []
  for (const v of Array.isArray(values) ? values : []) {
    const t = String(v ?? '').trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

function parseList(value) {
  if (Array.isArray(value)) return uniqueStrings(value)
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? uniqueStrings(parsed) : []
    } catch {
      return []
    }
  }
  return []
}

function statedApplicantTypes(opportunity) {
  return uniqueStrings([
    ...parseList(opportunity?.applicant_types),
    ...parseList(opportunity?.entity_types_allowed),
  ]).filter((t) => t !== '*' && t.toLowerCase() !== 'any')
}

function eligibilityProse(opportunity) {
  return uniqueStrings([
    ...(typeof opportunity?.eligibility_text === 'string' ? [opportunity.eligibility_text] : []),
    ...(typeof opportunity?.eligibility === 'string' ? [opportunity.eligibility] : []),
    ...(typeof opportunity?.eligibility_requirements === 'string' ? [opportunity.eligibility_requirements] : []),
    ...parseList(opportunity?.eligibility_bullets),
  ])
}

/**
 * Re-derive the three PROFILE-side truths of an existing proof from a fresh
 * canonical decision, keeping the REAL leg exactly as captured.
 *
 * Why this exists (prod 2026-09-07): the stale-explain drain re-scores every
 * pair whose explain predates the current signal version, and it re-scores
 * through the canonical engine — which never builds a four-truth proof. It
 * then persisted the canonical explain in place of the crawler-os one, so a
 * proven direct ACCEPT became an unprovable row and vanished from Discover
 * (452 crawler-os rows refreshed, 96 still carrying proof, against ~80%
 * carrying it before). The REAL leg is capture-time evidence — reality
 * verdict, evidence URL, content hash, capture timestamp — and the catalog
 * row holds none of it, so it can only be carried forward. The other three
 * legs are functions of the profile and the current engine and MUST be
 * recomputed, or a proof would keep certifying needs the profile no longer
 * declares (the tags-are-not-needs class).
 *
 * Returns null when there is no previous proof to refresh: nothing here
 * manufactures reality evidence.
 */
export function refreshFourTruthProof(previous, { canonical, opportunity = null, needsDefaulted, refreshedBy = 'stale_match_explain_refresh' } = {}) {
  const prev = fundingTruthProofFrom(previous)
  if (!prev || !prev.real) return null
  const decision = String(canonical?.decision ?? '').trim().toUpperCase()
  const scoreRaw = Number(canonical?.score ?? canonical?.match_score)
  const matchedNeeds = uniqueStrings([
    ...(canonical?.matchedNeeds ?? []),
    ...(canonical?.match_explain?.matchedNeeds ?? []),
    ...(canonical?.match_explain?.matched_needs ?? []),
  ])
  const eligibility = canonical?.eligible ?? canonical?.match_explain?.eligibility_fit ?? 'maybe'
  const eligibilityKey = String(eligibility ?? '').trim().toLowerCase()
  const defaulted = typeof needsDefaulted === 'boolean'
    ? needsDefaulted
    : prev.meets_profile_need?.profile_needs_defaulted === true
  const applicantEvidence = statedApplicantTypes(opportunity)
  const applicantEvidenceFinal = applicantEvidence.length > 0
    ? applicantEvidence
    : uniqueStrings(prev.profile_qualifies?.applicant_type_evidence)
  const prose = eligibilityProse(opportunity)
  const proseFinal = prose.length > 0 ? prose : uniqueStrings(prev.profile_qualifies?.eligibility_prose_evidence)
  const signals = [
    ...(canonical?.match_explain?.matchedSignals ?? []),
    ...(canonical?.match_explain?.matched_signals ?? []),
  ].map((v) => String(v ?? '').toLowerCase())
  const applicantMatched = signals.includes('applicant_type')

  const proof = {
    direct_funding: prev.direct_funding === true,
    real: { ...prev.real },
    relatable: {
      passed: decision === 'ACCEPT',
      canonical_decision: decision || 'REVIEW',
      score: Number.isFinite(scoreRaw) ? Math.round(scoreRaw) : 0,
    },
    meets_profile_need: {
      passed: matchedNeeds.length > 0 && defaulted === false,
      matched_needs: matchedNeeds,
      profile_needs_defaulted: defaulted,
    },
    profile_qualifies: {
      passed: POSITIVE_ELIGIBILITY.has(eligibilityKey) &&
        (applicantEvidenceFinal.length > 0 || proseFinal.length > 0) &&
        applicantMatched,
      eligibility,
      applicant_type_evidence: applicantEvidenceFinal,
      eligibility_prose_evidence: proseFinal,
      missing_eligibility_fields: uniqueStrings(canonical?.missingEligibilityFields ?? canonical?.match_explain?.missing_eligibility_fields),
    },
    refreshed_at: new Date().toISOString(),
    refreshed_by: refreshedBy,
  }
  proof.all_passed = proof.direct_funding && proof.real.passed === true && proof.relatable.passed &&
    proof.meets_profile_need.passed && proof.profile_qualifies.passed
  return proof
}

/** The truths a refreshed proof fails, for an honest held-at-REVIEW reason. */
export function failedFourTruths(proof) {
  if (!proof) return ['real', 'relatable', 'meets_profile_need', 'profile_qualifies']
  return [
    ['real', proof.real?.passed === true],
    ['relatable', proof.relatable?.passed === true],
    ['meets_profile_need', proof.meets_profile_need?.passed === true],
    ['profile_qualifies', proof.profile_qualifies?.passed === true],
  ].filter(([, ok]) => !ok).map(([name]) => name)
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
  refreshFourTruthProof,
  failedFourTruths,
}
