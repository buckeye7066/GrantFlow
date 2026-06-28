import { computeMatchDecision } from '../matchDecisionEngine.js'
import {
  assessOpportunityTrust,
  buildTrustMetadata,
} from '../opportunityTrust.js'
import {
  deriveMatchReasonCodes,
  MATCH_REASON_CODES,
} from './reasons.js'
import { evaluateProfileSpecificGate } from './profileSpecificGate.js'

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

  let decision = computeMatchDecision(rawProfile, opportunity, {
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
  if (trust.downgrade) {
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
    match_confidence: Number.isFinite(Number(decision?.confidence))
      ? Number(decision.confidence)
      : null,
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

  for (const opp of Array.isArray(opportunities) ? opportunities : []) {
    const result = canonicalResultForProfile(profileContext, opp, opts)
    if (result.display && result.opportunity) {
      kept.push(result.opportunity)
    } else {
      const key = result.dropReason || 'unknown'
      dropped[key] = (dropped[key] || 0) + 1
    }
  }

  kept.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
  return { kept, dropped }
}

export default {
  canonicalResultForProfile,
  canonicalizeOpportunityList,
  isDirectoryRecord,
}
