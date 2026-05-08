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
  if (src.includes('directory') || src.includes('212')) return 'directory'
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

  const url = pickString(opp.application_url, opp.url, opp.source_url)
  const sourceUrl = pickString(opp.source_url, opp.url, opp.application_url)

  const score = pickNumber(opp.match_score, opp.match, opp.score)
  const confidence = pickNumber(opp.match_confidence, opp.confidence)

  const trust = pickString(opp.source_trust_tier, opp.trust_tier, opp.trustTier)
  const linkStatus = pickString(opp.link_status, opp.linkStatus) ||
    (opp.last_verified_at && opp.url_status_code && opp.url_status_code < 400 ? 'verified' : 'unverified')

  return {
    id: opp.id ?? opp.source_id ?? opp.opportunity_id ?? null,
    title: pickString(opp.title, opp.program_name, opp.name) || 'Untitled opportunity',
    sponsor: pickString(opp.sponsor, opp.funder, opp.organization, opp.agency) || '',
    description: pickString(opp.description, opp.descriptionMd, opp.summary) || '',
    application_url: url,
    source_url: sourceUrl,
    source: pickString(opp.source, opp.crawler_type, opp.record_origin) || 'unknown',
    kind,
    opportunity_kind: kind,
    source_trust_tier: trust || (kind === 'directory' ? 'verified_directory' : 'open_web'),
    link_status: linkStatus,
    deadline: pickString(opp.deadline, opp.deadlineAt, opp.deadline_date),
    deadline_type: pickString(opp.deadline_type, opp.deadlineType),
    amount_min: pickNumber(opp.amount_min, opp.awardMin, opp.min_amount),
    amount_max: pickNumber(opp.amount_max, opp.awardMax, opp.max_amount),
    amount_description: pickString(opp.amount_description, opp.amount, opp.award_description),
    eligibility_summary: pickString(opp.eligibility_summary, opp.eligibility, opp.eligibilitySummary),
    match_score: score ?? 0,
    match_decision: pickString(opp.match_decision, opp.decision) || (score >= 70 ? 'ACCEPT' : score >= 35 ? 'REVIEW' : 'REJECT'),
    match_confidence: confidence ?? null,
    matched_profile_facts: matchedFacts,
    ineligibility_reasons: ineligibility,
    next_action: pickString(opp.next_action, opp.nextAction),
    threshold_relaxed: Boolean(opp.threshold_relaxed || opp.threshold_relaxed_reason),
    relaxed_reason: pickString(opp.relaxed_reason, opp.threshold_relaxed_reason, opp.threshold_fallback_message),
  }
}

export default toCanonicalResult
