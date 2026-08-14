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

/**
 * A geography verdict crawler-os writes as `matched_location`: the geo tier
 * name ('state', 'national', 'county'…), 'partial', or the honest 'unknown'.
 * Only a POSITIVE verdict is evidence — silence is never a denial, and it is
 * never a match either.
 */
const NON_COMMITTAL_LOCATION = new Set(['', 'unknown', 'none', 'no_match', 'null', 'undefined'])

function parseExplain(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Resolve the explanation evidence for a decision.
 *
 * TWO SHAPES SHIP, AND THE PERSISTED ONE IS THE COMMON CASE.
 * `services/matchEngine.js` (live recompute) emits camelCase
 * `matchedSignals` / `scoreBreakdown`. `crawler-os/matchEngine.js` re-wraps the
 * same canonical verdict into the shape that is actually PERSISTED to
 * `profile_opportunity_matches.match_explain_json` — snake_case
 * `score_breakdown` plus the pre-reduced `matched_profile_type` /
 * `matched_location` / `matched_needs` / `eligibility_fit` facts (see
 * `crawler-os/storage.js`, the only writer of that column).
 *
 * On the DOMINANT read path (`resultEnricher`'s stored-decision branch, used
 * whenever crawler-os has already scored the pair) the decision object is
 * rebuilt from DB columns and carries NO `match_explain` at all — while the
 * opportunity row alongside it DOES carry `match_explain_json`, selected by
 * `routes/discovery.js` and `routes/matching.js`. Reading only
 * `decision.match_explain` therefore threw away every structural reason the
 * crawler had already proven: measured on a real persisted ACCEPT, six
 * available codes collapsed to two (`eligibility_fit`, `strong_score`), so the
 * "why did this match" chips lost geography, applicant type, keyword, category
 * and need alignment. Both shapes and both carriers are read here.
 */
function resolveExplain(decision, opportunity) {
  const fromDecision = parseExplain(decision?.match_explain)
  if (fromDecision && Object.keys(fromDecision).length > 0) return fromDecision
  return parseExplain(opportunity?.match_explain_json)
    ?? parseExplain(opportunity?.match_explain)
    ?? fromDecision
    ?? {}
}

export function deriveMatchReasonCodes(decision = {}, opportunity = {}, trust = null) {
  const codes = new Set()
  const explain = resolveExplain(decision, opportunity)
  const signals = Array.isArray(explain.matchedSignals)
    ? explain.matchedSignals
    : Array.isArray(explain.matched_signals) ? explain.matched_signals : []
  const breakdown = explain.scoreBreakdown ?? explain.score_breakdown ?? {}
  const reasonText = [
    ...(Array.isArray(decision?.reasons) ? decision.reasons : []),
    ...(Array.isArray(explain.reasons) ? explain.reasons : []),
  ].join(' ').toLowerCase()

  const matchedNeeds = Array.isArray(decision?.matchedNeeds) && decision.matchedNeeds.length > 0
    ? decision.matchedNeeds
    : Array.isArray(explain.matched_needs) ? explain.matched_needs
      : Array.isArray(explain.matchedNeeds) ? explain.matchedNeeds : []
  if (matchedNeeds.length > 0) {
    codes.add(MATCH_REASON_CODES.NEED_ALIGNMENT)
  }
  if (signals.includes('keywords') || Number(breakdown.keyword || 0) > 0 || /\bkeyword|intent|need alignment\b/.test(reasonText)) {
    codes.add(MATCH_REASON_CODES.KEYWORD_MATCH)
  }
  if (signals.includes('category') || Number(breakdown.category || 0) > 0) {
    codes.add(MATCH_REASON_CODES.CATEGORY_MATCH)
  }
  const matchedLocation = String(explain.matched_location ?? '').trim().toLowerCase()
  if (
    signals.some((signal) => String(signal).startsWith('geo:')) ||
    Number(breakdown.geo || 0) > 0 ||
    Number(breakdown.geo_factor || 0) > 0 ||
    (matchedLocation && !NON_COMMITTAL_LOCATION.has(matchedLocation))
  ) {
    codes.add(MATCH_REASON_CODES.GEOGRAPHIC_MATCH)
  }
  if (
    signals.includes('applicant_type') ||
    Number(breakdown.applicant_type || 0) > 0 ||
    explain.matched_profile_type === true
  ) {
    codes.add(MATCH_REASON_CODES.APPLICANT_TYPE_MATCH)
  }
  // `eligibility_fit` carries the canonical `eligible` verdict, which is
  // `true` / `false` / `'maybe'`. Only an affirmative verdict is evidence —
  // 'maybe' means the gate had nothing to say.
  const eligibilityFit = explain.eligibility_fit
  if (
    decision?.eligible === true ||
    decision?.decision === 'ACCEPT' ||
    eligibilityFit === true ||
    String(eligibilityFit).trim().toLowerCase() === 'yes'
  ) {
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
