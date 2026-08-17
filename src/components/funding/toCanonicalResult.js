/**
 * toCanonicalResult.js
 *
 * Phase 5/6 mission rule: every funding-result page must render
 * <FundingResultCard /> using the canonical result shape (see
 * src/components/funding/canonicalResultShape.js — canonicalResultShape()).
 *
 * Backend routes (matching.js, discovery.js, opportunities.js, …) and
 * older crawler payloads expose slightly different field names. This
 * adapter normalises any "opportunity-ish" object into the canonical
 * shape so we never have to hand-map fields at every call site.
 *
 * The adapter is intentionally permissive: missing fields default to
 * neutral values (mission rule: no field should disqualify a result).
 *
 * Lightweight + pure → safe to call inside render.
 */

const VALID_DECISIONS = new Set(['ACCEPT', 'REVIEW', 'REJECT'])

/**
 * Return the backend canonical decision verbatim (normalized to upper-case) or
 * 'UNRATED' when the backend did not supply one. The UI never computes the
 * accept/review/reject verdict itself — that authority belongs solely to the
 * backend match engine (computeMatchDecision).
 */
function normalizeBackendDecision(...candidates) {
  for (const c of candidates) {
    // Explicitly guard null/undefined/empty before coercion so a null
    // candidate can never reach String() and cause a runtime error.
    if (c === null || c === undefined || c === '') continue
    const up = String(c).toUpperCase()
    if (VALID_DECISIONS.has(up)) return up
  }
  return 'UNRATED'
}

const KIND_ALIASES = new Map([
  ['direct', 'direct'],
  ['grant', 'direct'],
  ['scholarship', 'direct'],
  ['award', 'direct'],
  ['benefit', 'benefit'],
  ['program', 'benefit'],
  ['assistance', 'benefit'],
  ['cost_coverage', 'benefit'],
  ['service', 'benefit'],
  ['directory', 'directory'],
  ['referral', 'referral'],
  ['referral_directory', 'directory'],
  ['school_portal', 'school_portal'],
  ['portal', 'school_portal'],
])

function inferKind(opp) {
  const explicit = opp?.kind || opp?.opportunity_kind
  if (explicit && KIND_ALIASES.has(String(explicit).toLowerCase())) {
    return KIND_ALIASES.get(String(explicit).toLowerCase())
  }
  const oppType = String(opp?.opportunity_type || opp?.type || '').toLowerCase()
  if (KIND_ALIASES.has(oppType)) return KIND_ALIASES.get(oppType)
  const fundingType = String(opp?.funding_type || '').toLowerCase()
  if (fundingType === 'referral') return 'referral'
  if (fundingType === 'service' || fundingType === 'cost_coverage') return 'benefit'
  // Last-ditch heuristics
  const src = String(opp?.source || '').toLowerCase()
  if (src.includes('directory') || src.includes('211')) return 'directory'
  if (src.includes('school_portal') || src.includes('portal')) return 'school_portal'
  return 'direct'
}

function pickArray(...candidates) {
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) return c.filter((x) => typeof x === 'string' && x.trim())
  }
  return []
}

function pickNumber(...candidates) {
  for (const c of candidates) {
    if (c === null || c === undefined || c === '') continue
    const n = Number(c)
    if (Number.isFinite(n)) return n
  }
  return null
}

function pickString(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return null
}

/**
 * Convert any legacy/backend opportunity object into the canonical
 * FundingResultCard shape. Safe to call repeatedly — idempotent.
 */
export function toCanonicalResult(opp) {
  if (!opp || typeof opp !== 'object') return null
  const kind = inferKind(opp)
  const matchedFacts = pickArray(
    opp.matched_profile_facts,
    opp.match_reasons,
    opp.matched_fields,
    opp.matchReasons,
    opp.profile_signal_audit?.matched_facts,
  )
  const ineligibility = pickArray(opp.ineligibility_reasons, opp.eligibility_concerns)
  // Facts the engine could not confirm either way (slice 3: the "unknown" leg
  // of confirmed / unknown / disqualifying). Carried so the card can render an
  // honest "we couldn't confirm" section instead of implying full coverage.
  const unknownFacts = pickArray(
    opp.missing_eligibility_fields,
    opp.missingEligibilityFields,
    opp.unknown_eligibility_fields,
  )

  const applicationUrl = pickString(opp.application_url, opp.apply_url, opp.applicationUrl, opp.applyUrl)
  const sourceUrl = pickString(opp.source_url, opp.sourceUrl, opp.url, applicationUrl)

  const score = pickNumber(opp.match_score, opp.match, opp.score)
  const confidence = pickNumber(opp.match_confidence, opp.confidence)

  const trust = pickString(opp.source_trust_tier, opp.trust_tier, opp.trustTier)
  const rawLinkStatus = pickString(opp.link_status, opp.linkStatus)
  // The backend verifier's stored vocabulary is ok|redirect|broken|skipped|
  // unverified (linkVerificationService). The card renders the canonical
  // verified|redirect|broken|unverified|unreachable set — map the two here so a
  // proven-live link ('ok') is never rendered as an unverified amber chip and a
  // deliberately-skipped probe reads honestly as "not yet verified".
  const LINK_STATUS_CANONICAL = {
    ok: 'verified',
    skipped: 'unverified',
    suspicious: 'suspicious',
    verified: 'verified',
    redirect: 'redirect',
    broken: 'broken',
    unreachable: 'unreachable',
    unverified: 'unverified',
  }
  const linkStatus = (rawLinkStatus && LINK_STATUS_CANONICAL[rawLinkStatus.toLowerCase()]) ||
    rawLinkStatus ||
    (opp.last_verified_at && opp.url_status_code && opp.url_status_code < 400 ? 'verified' : 'unverified')

  return {
    id: opp.id ?? opp.source_id ?? opp.opportunity_id ?? null,
    title: pickString(opp.title, opp.program_name, opp.name) || 'Untitled opportunity',
    sponsor: pickString(opp.sponsor, opp.funder, opp.organization, opp.agency) || '',
    description: pickString(opp.description, opp.descriptionMd, opp.summary) || '',
    application_url: applicationUrl,
    source_url: sourceUrl,
    source: pickString(opp.source, opp.crawler_type, opp.record_origin) || 'unknown',
    kind,
    opportunity_kind: kind,
    source_trust_tier: trust || (kind === 'directory' ? 'verified_directory' : 'open_web'),
    link_status: linkStatus,
    last_verified_at: pickString(opp.last_verified_at, opp.lastVerifiedAt),
    deadline: pickString(opp.deadline, opp.deadlineAt, opp.deadline_date),
    deadline_type: pickString(opp.deadline_type, opp.deadlineType),
    // Loan / matching-funds caveats so the card can warn the user (RC-15).
    is_loan: opp.is_loan === true || opp.is_loan === 1,
    requires_match: opp.requires_match === true || opp.requires_match === 1,
    amount_min: pickNumber(opp.amount_min, opp.awardMin, opp.min_amount),
    amount_max: pickNumber(opp.amount_max, opp.awardMax, opp.max_amount),
    amount_description: pickString(opp.amount_description, opp.amount, opp.award_description),
    // Amount visibility (migrations 132/0136): honest text/status when no number.
    amount_text: pickString(opp.amount_text),
    amount_status: pickString(opp.amount_status),
    eligibility_summary: pickString(opp.eligibility_summary, opp.eligibility, opp.eligibilitySummary),
    match_score: score ?? 0,
    // The accept/review/reject decision is the backend canonical match engine's
    // to make (computeMatchDecision). The UI must NOT re-derive it from a score
    // ladder — doing so created a second, drifting decision authority in the
    // client. When the backend did not decide, surface 'UNRATED' honestly rather
    // than inventing a verdict. (Mission System 2.)
    match_decision: normalizeBackendDecision(opp.match_decision, opp.decision),
    match_confidence: confidence ?? null,
    matched_profile_facts: matchedFacts,
    ineligibility_reasons: ineligibility,
    missing_eligibility_fields: unknownFacts,
    next_action: pickString(opp.next_action, opp.nextAction),
    // Structured recommended next steps from nextStepGuidance (objects with
    // id/label/detail/priority) — carried verbatim, bounded by the backend.
    next_steps: Array.isArray(opp.next_steps)
      ? opp.next_steps.filter((s) => s && typeof s === 'object' && typeof s.label === 'string')
      : [],
    threshold_relaxed: Boolean(opp.threshold_relaxed || opp.threshold_relaxed_reason),
    relaxed_reason: pickString(opp.relaxed_reason, opp.threshold_relaxed_reason, opp.threshold_fallback_message),
  }
}

export default toCanonicalResult
