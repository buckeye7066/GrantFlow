export const MATCH_REASON_CODES = Object.freeze({
  NEED_ALIGNMENT: 'need_alignment',
  KEYWORD_MATCH: 'keyword_match',
  CATEGORY_MATCH: 'category_match',
  GEOGRAPHIC_MATCH: 'geographic_match',
  APPLICANT_TYPE_MATCH: 'applicant_type_match',
  ELIGIBILITY_FIT: 'eligibility_fit',
  TRUSTED_SOURCE: 'trusted_source',
  AMOUNT_FIT: 'amount_fit',
  DEADLINE_RELEVANCE: 'deadline_relevance',
  HOUSING_FIT: 'housing_fit',
  STRONG_SCORE: 'strong_score',
  REVIEW_SCORE: 'review_score',
  WEAK_REVIEW: 'weak_review',
})

export const MATCH_REASON_CODE_SET = new Set(Object.values(MATCH_REASON_CODES))

export function deriveMatchReasonCodes(decision = {}, opportunity = {}, trust = null) {
  const codes = new Set()
  const explain = decision?.match_explain ?? {}
  const signals = Array.isArray(explain.matchedSignals) ? explain.matchedSignals : []
  const breakdown = explain.scoreBreakdown ?? {}
  const reasonText = [
    ...(Array.isArray(decision?.reasons) ? decision.reasons : []),
    ...(Array.isArray(explain.reasons) ? explain.reasons : []),
  ].join(' ').toLowerCase()

  if (Array.isArray(decision?.matchedNeeds) && decision.matchedNeeds.length > 0) {
    codes.add(MATCH_REASON_CODES.NEED_ALIGNMENT)
  }
  if (signals.includes('keywords') || Number(breakdown.keyword || 0) > 0 || /\bkeyword|intent|need alignment\b/.test(reasonText)) {
    codes.add(MATCH_REASON_CODES.KEYWORD_MATCH)
  }
  if (signals.includes('category') || Number(breakdown.category || 0) > 0) {
    codes.add(MATCH_REASON_CODES.CATEGORY_MATCH)
  }
  if (signals.some((signal) => String(signal).startsWith('geo:')) || Number(breakdown.geo || 0) > 0) {
    codes.add(MATCH_REASON_CODES.GEOGRAPHIC_MATCH)
  }
  if (signals.includes('applicant_type') || Number(breakdown.applicant_type || 0) > 0) {
    codes.add(MATCH_REASON_CODES.APPLICANT_TYPE_MATCH)
  }
  if (decision?.eligible === true || decision?.decision === 'ACCEPT') {
    codes.add(MATCH_REASON_CODES.ELIGIBILITY_FIT)
  }
  // `assessOpportunityTrust` (backend/services/opportunityTrust.js) emits
  // `trustTier` as one of `trusted | standard | low`, and `sourceTrust` as a
  // STRING label `official | verified | directory | community | unknown`.
  // Earlier code compared `sourceTrust >= 80` (number), which never matched and
  // silently disabled the TRUSTED_SOURCE reason code on real official rows --
  // a Goal #9 (explainable) violation.
  const sourceTrustLabel = String(trust?.sourceTrust || '').toLowerCase()
  if (
    trust?.trustTier === 'trusted' ||
    sourceTrustLabel === 'official' ||
    sourceTrustLabel === 'verified' ||
    /verified|official|trusted/.test(String(opportunity?.source || '').toLowerCase())
  ) {
    codes.add(MATCH_REASON_CODES.TRUSTED_SOURCE)
  }
  if (Number(breakdown.amount || 0) > 0 || /\bamount eligibility\b/.test(reasonText)) {
    codes.add(MATCH_REASON_CODES.AMOUNT_FIT)
  }
  if (Number(breakdown.deadline || 0) > 0 || /\bdeadline\b/.test(reasonText)) {
    codes.add(MATCH_REASON_CODES.DEADLINE_RELEVANCE)
  }
  if (explain.usableForHousing || Number(breakdown.housing_signal_bonus || 0) > 0) {
    codes.add(MATCH_REASON_CODES.HOUSING_FIT)
  }
  if (decision?.decision === 'ACCEPT' || /\bstrong match\b/.test(reasonText)) {
    codes.add(MATCH_REASON_CODES.STRONG_SCORE)
  } else if (decision?.decision === 'REVIEW' && /\bweak match\b/.test(reasonText)) {
    codes.add(MATCH_REASON_CODES.WEAK_REVIEW)
  } else if (decision?.decision === 'REVIEW') {
    codes.add(MATCH_REASON_CODES.REVIEW_SCORE)
  }

  return Array.from(codes).filter((code) => MATCH_REASON_CODE_SET.has(code))
}
