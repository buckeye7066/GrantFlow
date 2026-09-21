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

import { resolveApplicationUrl, readApplicationTargetRefusal } from '../../../shared/applicationTarget.js'
import { opportunityKindOf } from '../../../shared/opportunityFundability.js'

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
  if (opportunityKindOf(opp) === 'PAST_AWARD_INTEL') return 'past_award_intel'
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

function parseExplain(opp) {
  for (const raw of [opp?.match_explain, opp?.match_explain_json]) {
    if (!raw) continue
    if (typeof raw === 'object') return raw
    try {
      const parsed = JSON.parse(String(raw))
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // not JSON — fall through
    }
  }
  return null
}

function nonEmptyList(value) {
  if (Array.isArray(value)) return value.filter((x) => typeof x === 'string' && x.trim()).length > 0
  if (typeof value === 'string') {
    const s = value.trim()
    if (!s) return false
    try { return nonEmptyList(JSON.parse(s)) } catch { return true }
  }
  return false
}

const ELIGIBILITY_EVIDENCE = new Set(['prose', 'structured_flags', 'applicant_types_only', 'none'])

/**
 * How much eligibility evidence backs this match, for the card's honesty chip.
 * Ladder, most authoritative first: the engine's recorded level (PR2+), the
 * four-truth proof's evidence_basis, the proof's own evidence arrays (rows
 * scored before the level existed), the row's eligibility text. Anything else
 * is `unknown` — rendered conservatively, never as a check that was made.
 */
function deriveEligibilityEvidence(opp, explain) {
  const recorded = String(explain?.eligibility_evidence ?? explain?.four_truth_proof?.evidence_basis?.eligibility ?? '').toLowerCase()
  if (ELIGIBILITY_EVIDENCE.has(recorded)) return recorded
  const qualifies = explain?.four_truth_proof?.profile_qualifies
  if (nonEmptyList(qualifies?.eligibility_prose_evidence)) return 'prose'
  if (nonEmptyList(opp?.eligibility_text) || nonEmptyList(opp?.eligibility_bullets)) return 'prose'
  if (nonEmptyList(qualifies?.applicant_type_evidence)) return 'applicant_types_only'
  return 'unknown'
}

function truthy(value) {
  return value === true || value === 1 || ['true', '1'].includes(String(value ?? '').toLowerCase())
}

/** Did the source state WHERE the money is valid? national | stated | unknown. */
function deriveGeoEvidence(opp, explain) {
  const recorded = String(explain?.four_truth_proof?.evidence_basis?.geography ?? '').toLowerCase()
  if (['national', 'stated', 'unknown'].includes(recorded)) return recorded
  if (truthy(opp?.is_national)) return 'national'
  const state = pickString(opp?.state, opp?.geography_state)
  if (state && state.toLowerCase() !== 'nationwide') return 'stated'
  if (state && state.toLowerCase() === 'nationwide') return 'national'
  return 'unknown'
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

  const applicationUrl = resolveApplicationUrl(opp)
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

  const explain = parseExplain(opp)
  const eligibilityEvidence = pickString(opp.eligibility_evidence) ?? deriveEligibilityEvidence(opp, explain)
  const geoEvidence = pickString(opp.geo_evidence) ?? deriveGeoEvidence(opp, explain)

  return {
    id: opp.id ?? opp.source_id ?? opp.opportunity_id ?? null,
    title: pickString(opp.title, opp.program_name, opp.name) || 'Untitled opportunity',
    sponsor: pickString(opp.sponsor, opp.funder, opp.organization, opp.agency) || '',
    description: pickString(opp.description, opp.descriptionMd, opp.summary) || '',
    application_url: applicationUrl,
    ...(readApplicationTargetRefusal(opp) ? { application_target: readApplicationTargetRefusal(opp) } : {}),
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
    // How much the engine actually verified (prose | structured_flags |
    // applicant_types_only | none | unknown) and whether the source stated a
    // service area (national | stated | unknown). The card renders a "confirm
    // before applying" chip for anything below prose / an unstated area.
    eligibility_evidence: eligibilityEvidence,
    geo_evidence: geoEvidence,
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
