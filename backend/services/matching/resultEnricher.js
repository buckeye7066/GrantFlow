import { computeMatchDecision } from '../matchDecisionEngine.js'
import {
  assessOpportunityTrust,
  buildTrustMetadata,
} from '../opportunityTrust.js'
import {
  deriveMatchReasonCodes,
  MATCH_REASON_CODES,
} from './reasons.js'
import {
  evaluateProfileSpecificGate,
  hasAuthoritativeStoredDecision,
  SUPPRESSIBLE_NO_FIT_RULE_IDS,
} from './profileSpecificGate.js'

/**
 * True only for a value that is genuinely a finite number (or the string form of
 * one). `Number(null)`, `Number('')` and `Number([])` are all 0 — a plain
 * `Number.isFinite(Number(x))` therefore reads ABSENT as the measured value ZERO.
 * Every "unknown vs 0" distinction in this file must route through here.
 */
export function isFiniteNumberLike(value) {
  if (typeof value === 'number') return Number.isFinite(value)
  // A numeric STRING is the shape SQLite/pg drivers hand back for REAL columns;
  // everything else (null, undefined, boolean, [], {}) coerces to 0 or NaN and
  // must never be mistaken for a measurement.
  if (typeof value !== 'string') return false
  if (value.trim() === '') return false
  return Number.isFinite(Number(value))
}

export function isDirectoryRecord(opp) {
  const text = [
    opp?.title,
    opp?.name,
    opp?.description,
    opp?.summary,
    opp?.eligibility,
    opp?.opportunity_type,
    opp?.type,
    opp?.funding_type,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return Boolean(
    opp?.is_directory_resource ||
      String(opp?.source || '').startsWith('directory') ||
      String(opp?.source || '').includes('local_directory') ||
      String(opp?.record_origin || '').startsWith('directory') ||
      String(opp?.type || '').toUpperCase() === 'DIRECTORY' ||
      String(opp?.opportunity_type || '').toUpperCase() === 'DIRECTORY' ||
      String(opp?.opportunity_kind || '').toLowerCase() === 'directory' ||
      /\b(boots to business|veterans business outreach centers?|veteran-owned business resources|military onesource|transition assistance program)\b/.test(text),
  )
}

function clampScore(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.round(Math.max(0, Math.min(100, n)))
}

function buildFallbackFacts(decision, reasonCodes) {
  const facts = []
  if (Array.isArray(decision?.matchedNeeds)) {
    for (const need of decision.matchedNeeds) {
      if (need) facts.push(`Need: ${need}`)
    }
  }
  if (Array.isArray(decision?.matchedProfileTraits)) {
    for (const trait of decision.matchedProfileTraits) {
      if (trait) facts.push(`Profile signal: ${trait}`)
    }
  }
  if (facts.length === 0 && Array.isArray(reasonCodes)) {
    for (const code of reasonCodes.slice(0, 4)) {
      if (code) facts.push(`Match reason: ${String(code).replace(/_/g, ' ')}`)
    }
  }
  return facts
}

/**
 * Canonical user-facing opportunity evaluator.
 *
 * This is the one display/persistence adapter that combines:
 *   - consumer trust/reality gate
 *   - canonical match decision
 *   - explainable reason codes
 *   - stable UI fields
 *
 * It deliberately ignores crawler prefilter scores as final truth.
 */
export function canonicalResultForProfile(profileContext, opportunity, opts = {}) {
  const {
    preserveDirectories = true,
    trustOptions = {},
    trustDowngradePenalty = 5,
    rejectHardIneligible = true,
  } = opts

  // A row that already carries a stored above-floor engine decision IS the
  // authority — the matchEngine (the sole decision engine) evaluated it against
  // the FULL profile. Treat it as authoritative BY DEFAULT so display code never
  // silently re-adjudicates it (a second eligibility trial) or recomputes and
  // rewrites its stored score (parity drift). Only an EXPLICIT
  // useStoredDecision:false opts out (kept for the strict/unscored-lead path and
  // its guard test). This closes the discovery.js class: two production read
  // routes (fundingSources.js, matching.js) passed useStoredDecision:true but
  // discovery.js OMITTED it, so the primary Discover surface silently overturned
  // engine decisions. Fixing the default at this choke point fixes every caller
  // at once instead of relying on each caller to remember the flag.
  const useStoredDecision = opts.useStoredDecision !== false

  if (!opportunity || typeof opportunity !== 'object') {
    return {
      display: false,
      dropReason: 'invalid_opportunity',
      opportunity: null,
      decision: null,
      trust: null,
    }
  }

  const rawProfile = profileContext?.profile ?? profileContext
  const profileSections = profileContext?.sections ?? null
  const signals = profileContext?.signals ?? null
  const directory = isDirectoryRecord(opportunity)

  const profileGate = evaluateProfileSpecificGate(profileContext, opportunity, {
    mode: opts.profileGateMode || 'display',
    allowUnmatchedDirectoryFallback: opts.allowUnmatchedDirectoryFallback === true,
    // Propagate the authoritative-stored-decision context so the gate can
    // suppress the NO-FIT (content-shape) rule family for rows the matchEngine
    // already scored above the surfacing floor (type-agnostic).
    useStoredDecision,
  })
  if (!profileGate.pass) {
    return {
      display: false,
      dropReason: profileGate.ruleId || 'profile_specific_gate',
      opportunity,
      decision: null,
      trust: null,
      profileGate,
    }
  }

  const trust = assessOpportunityTrust(opportunity, {
    allowDirectory: true,
    allowExpired: false,
    ...trustOptions,
  })

  if (!trust.display && !(preserveDirectories && directory)) {
    return {
      display: false,
      dropReason: 'trust',
      opportunity,
      decision: null,
      trust,
    }
  }

  // Perf: when the caller already has an authoritative, stored match decision
  // (crawler-os pre-scores every profile↔opportunity pair into
  // profile_opportunity_matches), re-running computeMatchDecision() for EVERY
  // row at query time is the dominant cost of a slow search (~24s) AND is
  // redundant — the stored score is what we sort by. Reuse it; only fall back to
  // a live recompute when no stored decision is present.
  const hasStoredDecision =
    useStoredDecision &&
    (Boolean(opportunity.match_decision) || Number.isFinite(Number(opportunity.match_score)))
  let decision = hasStoredDecision
    ? {
        decision: opportunity.match_decision ?? 'REVIEW',
        score: Number(opportunity.match_score ?? 0),
        explanation: opportunity.match_explanation ?? null,
        confidence: isFiniteNumberLike(opportunity.match_confidence) ? Number(opportunity.match_confidence) : null,
        matched_profile_facts: Array.isArray(opportunity.match_reasons) ? opportunity.match_reasons : [],
        matchedNeeds: Array.isArray(opportunity.matched_needs) ? opportunity.matched_needs : [],
        ineligibilityReasons: Array.isArray(opportunity.ineligibility_reasons) ? opportunity.ineligibility_reasons : [],
        matcherVersion: opportunity.matcher_version ?? 'crawler-os',
      }
    : computeMatchDecision(rawProfile, opportunity, {
        profileSections,
        signals,
      })

  if (decision?.decision === 'REJECT') {
    if (directory && preserveDirectories) {
      decision = {
        ...decision,
        decision: 'REVIEW',
        explanation: `${decision.explanation || 'Directory result preserved for review.'} Directory/referral resources are preserved as reviewable search aids, not direct grants.`,
      }
    } else if (rejectHardIneligible) {
      return {
        display: false,
        dropReason: 'decision',
        opportunity,
        decision,
        trust,
      }
    }
  }

  const reasonCodes = deriveMatchReasonCodes(decision, opportunity, trust)
  const fallbackReason =
    decision?.decision === 'ACCEPT'
      ? MATCH_REASON_CODES.STRONG_SCORE
      : MATCH_REASON_CODES.REVIEW_SCORE
  const matchReasons = reasonCodes.length > 0 ? reasonCodes : [fallbackReason]

  let score = clampScore(decision?.score)
  // A persisted score/decision pair is the audited canonical artifact. Trust
  // metadata may explain or sort a live recomputation, but query-time display
  // enrichment must not silently rewrite a stored score and create parity drift.
  if (trust.downgrade && !hasStoredDecision) {
    score = clampScore(score - trustDowngradePenalty)
  }

  const trustMeta = buildTrustMetadata(trust) || {}
  const matchedFacts = Array.isArray(decision?.matched_profile_facts) && decision.matched_profile_facts.length > 0
    ? decision.matched_profile_facts
    : buildFallbackFacts(decision, matchReasons)

  const canonicalOpportunity = {
    ...opportunity,
    match_score: score,
    match_reasons: matchReasons,
    match_decision: decision?.decision ?? 'REVIEW',
    decision: decision?.decision ?? 'REVIEW',
    match_explanation: decision?.explanation ?? null,
    match_decision_explanation: decision?.explanation ?? null,
    // UNKNOWN CONFIDENCE MUST STAY UNKNOWN. `Number(null)` is 0 and
    // `Number.isFinite(0)` is true, so the old guard converted "we have no
    // confidence for this pair" into a hard, published `0` — which the card
    // renders as "· 0% conf" (FundingResultCard.jsx: a null renders NO chip at
    // all). The 2026-08-01 production audit found every stored row NULL, so the
    // bug printed "0% conf" on every card. New crawler-os rows now persist a
    // measured value, while historical and non-measuring lanes may still be
    // NULL. Reject null/''/NaN BEFORE coercing.
    match_confidence: isFiniteNumberLike(decision?.confidence) ? Number(decision.confidence) : null,
    matched_needs: Array.isArray(decision?.matchedNeeds)
      ? decision.matchedNeeds
      : [],
    matched_profile_facts: matchedFacts,
    profile_gate_reasons: profileGate.matchedRules || [],
    ineligibility_reasons: Array.isArray(decision?.ineligibilityReasons)
      ? decision.ineligibilityReasons
      : [],
    matcher_version: decision?.matcherVersion ?? null,
    evaluated_at: decision?.evaluatedAt ?? null,
    trust_tier: opportunity.trust_tier ?? trustMeta.trust_tier,
    source_trust: opportunity.source_trust ?? trustMeta.source_trust,
    trust_flags: opportunity.trust_flags ?? trustMeta.trust_flags,
    trust_reasons: opportunity.trust_reasons ?? trustMeta.trust_reasons,
    trust_downgrade: opportunity.trust_downgrade ?? trustMeta.trust_downgrade,
    trust_downgrade_reason:
      opportunity.trust_downgrade_reason ?? trustMeta.trust_downgrade_reason,
    actionable_url: opportunity.actionable_url ?? trustMeta.actionable_url,
    url:
      trust.primaryUrl ??
      opportunity.application_url ??
      opportunity.url ??
      opportunity.source_url ??
      null,
  }

  return {
    display: true,
    dropReason: null,
    opportunity: canonicalOpportunity,
    decision,
    trust,
  }
}

export function canonicalizeOpportunityList(profileContext, opportunities = [], opts = {}) {
  const dropped = {}
  const kept = []
  // Reconciliation sentinel (catches the whole over-drop CLASS at runtime): a
  // row the matchEngine scored above the surfacing floor that the funnel drops
  // for a NO-FIT (content-shape) reason is a silent un-surfacing. After this
  // fix it must always be 0; a non-zero count in route diagnostics/telemetry is
  // an observable regression signal (Sam-consumable) rather than a bug a human
  // has to notice. Legitimate drops (eligibility mismatch, trust, dedup,
  // pipeline) are NOT counted here.
  const unsurfacedAboveFloorNoFit = []
  // Mirror the funnel's authoritative-by-default rule so the sentinel recognizes
  // a stored above-floor row even when the caller omitted the flag (the exact
  // discovery.js blind spot — the sentinel used to read the same broken opts and
  // report green while dropping engine-endorsed rows).
  const sentinelOpts = { ...opts, useStoredDecision: opts.useStoredDecision !== false }

  for (const opp of Array.isArray(opportunities) ? opportunities : []) {
    const result = canonicalResultForProfile(profileContext, opp, opts)
    if (result.display && result.opportunity) {
      kept.push(result.opportunity)
    } else {
      const key = result.dropReason || 'unknown'
      dropped[key] = (dropped[key] || 0) + 1
      if (
        SUPPRESSIBLE_NO_FIT_RULE_IDS.has(key) &&
        hasAuthoritativeStoredDecision(opp, sentinelOpts)
      ) {
        unsurfacedAboveFloorNoFit.push({
          opportunity_id: opp?.id ?? opp?.opportunity_id ?? null,
          reason: key,
          match_score: Number(opp?.match_score ?? 0),
        })
      }
    }
  }

  kept.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
  return { kept, dropped, unsurfacedAboveFloorNoFit }
}

/**
 * Reusable reconciliation assertion. Flags any stored ABOVE-FLOOR match that the
 * canonical funnel would drop for a NO-FIT (content-shape) reason — the silent
 * un-surfacing class. Returns the offending rows; when `opts.throwOnViolation`
 * is set (used by the profile-type matrix guard test) it throws instead, so a
 * regression reds the test suite. It re-uses the exact production funnel, so it
 * can never diverge from real behavior.
 */
export function assertNoSilentUnsurfacing(profileContext, opportunities = [], opts = {}) {
  const { unsurfacedAboveFloorNoFit } = canonicalizeOpportunityList(
    profileContext,
    opportunities,
    { useStoredDecision: true, ...opts },
  )
  if (opts.throwOnViolation && unsurfacedAboveFloorNoFit.length > 0) {
    const detail = unsurfacedAboveFloorNoFit
      .map((r) => `${r.opportunity_id}(${r.reason}, score=${r.match_score})`)
      .join(', ')
    throw new Error(
      `assertNoSilentUnsurfacing: ${unsurfacedAboveFloorNoFit.length} stored above-floor ` +
        `match(es) dropped for a no-fit reason: ${detail}`,
    )
  }
  return unsurfacedAboveFloorNoFit
}

export default {
  canonicalResultForProfile,
  canonicalizeOpportunityList,
  assertNoSilentUnsurfacing,
  isDirectoryRecord,
}
