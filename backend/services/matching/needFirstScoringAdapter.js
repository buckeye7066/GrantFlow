import {
  FIT_EVIDENCE_HALF_CREDIT,
  MIN_CALIBRATED_INVENTORY,
  SCORE_FLOOR,
} from '../../config/matchThresholds.js'
import {
  enforceNeedFirstDecision,
  evaluateNeedFirstMatchPolicy,
} from './needFirstMatchPolicy.js'

export const NEED_FIRST_SCORING_VERSION = 'need_first_v1'

function num(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clampScore(value) {
  return Math.round(Math.max(SCORE_FLOOR, Math.min(100, num(value, SCORE_FLOOR))))
}

function boundedFitScore(canonical = {}) {
  const breakdown = canonical?.match_explain?.scoreBreakdown ??
    canonical?.match_explain?.score_breakdown ?? {}
  const total = num(breakdown.data_point_total, 0)
  const matchedCredit = num(
    breakdown.data_point_credit ?? canonical?.match_explain?.dataPointEvidence?.credit,
    0,
  )
  const originalBonus = num(
    breakdown.data_point_bonus_credit ?? canonical?.match_explain?.dataPointEvidence?.bonus_credit,
    0,
  )
  const boundedBonus = Math.min(FIT_EVIDENCE_HALF_CREDIT, Math.max(0, originalBonus))

  if (total <= 0 || originalBonus <= boundedBonus) {
    return {
      score: clampScore(canonical?.score),
      originalBonus,
      boundedBonus,
      adjusted: false,
    }
  }

  const denominator = Math.max(total, MIN_CALIBRATED_INVENTORY)
  const eligibilityFactor = num(
    breakdown.eligibility_factor ?? breakdown.eligibilityFactor,
    1,
  )
  const geographyFactor = num(
    breakdown.geo_factor ?? breakdown.geography_factor ?? breakdown.geoFactor,
    1,
  )
  const boundedCoverage = Math.min(
    100,
    ((matchedCredit + boundedBonus) / denominator) * 100,
  )
  const recomputed = clampScore(
    boundedCoverage * eligibilityFactor * geographyFactor,
  )

  return {
    score: Math.min(clampScore(canonical?.score), recomputed),
    originalBonus,
    boundedBonus,
    adjusted: true,
  }
}

/**
 * Apply the profile-purpose policy to one canonical match result.
 *
 * The existing canonical engine remains responsible for normalization,
 * eligibility, geography, confidence, and evidence extraction. This adapter
 * changes only two things:
 *   1. the documented fit bonus is truly bounded to half a data point; and
 *   2. peripheral/administrative facts cannot substitute for a direct funding
 *      purpose in the profile.
 */
export function applyNeedFirstScoring({
  canonical = {},
  profileContext = {},
  opportunity = {},
  oppNorm = null,
} = {}) {
  const dataPointEvidence = canonical?.match_explain?.dataPointEvidence ?? {}
  const matchedNeeds = Array.isArray(canonical?.matchedNeeds)
    ? canonical.matchedNeeds
    : Array.isArray(canonical?.match_explain?.matchedNeeds)
      ? canonical.match_explain.matchedNeeds
      : []

  const policy = evaluateNeedFirstMatchPolicy({
    profileContext,
    profileNorm: profileContext?.profileNorm ?? profileContext?.normalized ?? null,
    opportunity,
    oppNorm,
    dataPointEval: {
      matched: Array.isArray(dataPointEvidence.matched)
        ? dataPointEvidence.matched
        : [],
      credit: num(dataPointEvidence.credit, 0),
    },
    matchedNeeds,
  })

  const fit = boundedFitScore(canonical)
  let score = fit.score
  if (Number.isFinite(Number(policy.scoreCap))) {
    score = Math.min(score, Number(policy.scoreCap))
  }
  score = clampScore(score)

  const decisionResult = enforceNeedFirstDecision({
    decision: canonical?.decision ?? 'REVIEW',
    explanation: canonical?.explanation ?? null,
    reasons: Array.isArray(canonical?.reasons) ? canonical.reasons : [],
  }, policy)

  if (policy.resource) {
    decisionResult.decision = 'REVIEW'
  }

  const previousExplain = canonical?.match_explain ?? {}
  const previousBreakdown = previousExplain.scoreBreakdown ??
    previousExplain.score_breakdown ?? {}
  const previousEvidence = previousExplain.dataPointEvidence ?? {}
  const totalCredit = Math.max(
    0,
    num(previousEvidence.credit ?? previousBreakdown.data_point_credit, 0) + fit.boundedBonus,
  )

  const matchExplain = {
    ...previousExplain,
    needFirstPolicy: policy,
    scoring_policy_version: NEED_FIRST_SCORING_VERSION,
    dataPointEvidence: {
      ...previousEvidence,
      bonus_credit: Math.round(fit.boundedBonus * 10) / 10,
      total_credit: Math.round(totalCredit * 10) / 10,
    },
    scoreBreakdown: {
      ...previousBreakdown,
      scoring_policy_version: NEED_FIRST_SCORING_VERSION,
      need_first_purpose_anchor: policy.purposeAnchor,
      need_first_decision: policy.decision,
      need_first_score_cap: policy.scoreCap,
      need_first_hard_mismatch: policy.hardMismatch,
      data_point_bonus_credit: Math.round(fit.boundedBonus * 10) / 10,
      data_point_total_credit: Math.round(totalCredit * 10) / 10,
      total_before_need_first: clampScore(canonical?.score),
      total: score,
    },
  }

  const reasons = [
    ...(Array.isArray(decisionResult.reasons) ? decisionResult.reasons : []),
  ]
  if (fit.adjusted) {
    reasons.push(
      `Specialized-fit credit bounded from ${Math.round(fit.originalBonus * 10) / 10} to ${Math.round(fit.boundedBonus * 10) / 10} data points`,
    )
  }
  if (policy.purposeReasons.length > 0) {
    reasons.push(...policy.purposeReasons)
  }

  return {
    ...canonical,
    score,
    decision: decisionResult.decision,
    explanation: decisionResult.explanation,
    reasons: [...new Set(reasons.filter(Boolean))],
    matchedNeeds,
    match_explain: matchExplain,
    matcherVersion: canonical?.matcherVersion ?? NEED_FIRST_SCORING_VERSION,
    scoringPolicyVersion: NEED_FIRST_SCORING_VERSION,
  }
}

export default {
  NEED_FIRST_SCORING_VERSION,
  applyNeedFirstScoring,
}
