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

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value.answers && typeof value.answers === 'object' ? value.answers : value)
    : {}
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (value instanceof Set) return [...value]
  if (value === null || value === undefined || value === '') return []
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed)) return parsed
      } catch {
        // Fall through to delimiter splitting.
      }
    }
    return trimmed.split(/[,;|\n]+/).map((entry) => entry.trim()).filter(Boolean)
  }
  return [value]
}

function derivePolicyProfileNorm(profileContext = {}) {
  const profile = profileContext?.profile ?? profileContext ?? {}
  const sections = profileContext?.sections ?? {}
  const education = asObject(sections.education)
  const occupation = asObject(sections.occupation)
  const family = asObject(sections.family_life ?? sections.family)
  const military = asObject(sections.military_service)
  const demographics = asObject(sections.demographics)
  const organization = asObject(sections.organization_details)
  const type = String(
    profile.applicant_type ?? profile.primary_type ?? profile.profile_type ?? organization.organization_type ?? '',
  ).trim().toLowerCase()
  const applications = asObject(sections.university_applications).applications
  const studentEvidence = Boolean(
    /student|college|school/.test(type) ||
    education.current_institution || education.current_college || education.intended_major ||
    education.field_of_study || Number(education.gpa) > 0 ||
    (Array.isArray(applications) && applications.length > 0)
  )
  const businessEvidence = Boolean(
    /business|company|farm|entrepreneur/.test(type) ||
    occupation.small_business_owner === true ||
    occupation.farmer === true
  )
  const nonprofitEvidence = Boolean(
    /nonprofit|church|ministry|charity|foundation/.test(type) ||
    profile.ein || organization.ein
  )

  return {
    entityType: type || null,
    isStudent: studentEvidence,
    isBusiness: businessEvidence,
    isNonprofit: nonprofitEvidence,
    isCaregiver: Boolean(family.caregiver || family.is_caregiver),
    hasFosterIndicator: Boolean(family.foster_youth || family.former_foster_youth),
    isWidow: Boolean(family.widow_widower || family.surviving_spouse),
    isOrphan: Boolean(family.orphan),
    isImmigrant: Boolean(
      demographics.immigrant_status &&
      !/^(none|no|false|unknown|not applicable)$/i.test(String(demographics.immigrant_status).trim())
    ),
    isInternationalStudent: Boolean(
      /international|foreign student|non[- ]?citizen|visa/i.test(
        String(demographics.immigrant_status ?? demographics.citizenship_status ?? ''),
      )
    ),
    hasChildren: Boolean(
      family.has_children || family.caregiver ||
      Number(family.number_of_children ?? family.number_of_dependents ?? 0) > 0
    ),
    isVeteran: Boolean(military.veteran || military.disabled_veteran),
    education: {
      currentInstitution: education.current_institution ?? education.current_college ?? null,
      intendedMajor: education.intended_major ?? education.field_of_study ?? null,
      targetColleges: asArray(education.target_colleges),
    },
    academics: {
      gpa: num(education.gpa, null),
      act: num(education.act_score, null),
      sat: num(education.sat_score, null),
    },
    occupation,
    industry: occupation.industry ?? null,
    needCategories: [
      ...asArray(profile.needs),
      ...asArray(profile.need_categories),
      ...asArray(profileContext?.facets?.intent?.primary_need_category),
    ],
    effectiveFacets: [
      type,
      ...asArray(profile.tags),
      ...asArray(profile.interests),
    ].filter(Boolean),
  }
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
  const profileNorm = profileContext?.profileNorm ??
    profileContext?.normalized ??
    derivePolicyProfileNorm(profileContext)

  const policy = evaluateNeedFirstMatchPolicy({
    profileContext,
    profileNorm,
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
