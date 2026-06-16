/**
 * Larry — fit scoring.
 *
 * "Fit" answers the question: how likely is this organization to actually
 * benefit from GrantFlow? GrantFlow's audience is grant-seekers — orgs that
 * apply for grants, not orgs that issue them. We score on:
 *
 *   - applicant type: nonprofit / school / fire dept / small business etc.
 *   - public programs (mission listed, services described, etc.)
 *   - past grant history (a grant-recipient is a strong fit)
 *   - reachable contact (we can actually pitch them)
 *   - organizational maturity (EIN, legal name, real website)
 *
 * Important rule: missing data does NOT exclude a prospect. Per the user's
 * standing rule, missing fields default to neutral, not exclusionary. Score
 * is a measure of confidence, not a hard gate.
 */

import { CONTACT_VERIFICATION_STATUS, FIT_REASON_CODES } from './larryTypes.js'

const KNOWN_GRANT_SEEKER_TYPES = new Set([
  'nonprofit',
  'church',
  'religious',
  'ministry',
  'school',
  'school_district',
  'college',
  'university',
  'volunteer_fire_department',
  'fire_department',
  'ems',
  'first_responder',
  'community_clinic',
  'food_bank',
  'shelter',
  'community_foundation',
  'small_business',
  'student',
  'family',
  'individual_need',
  'rural_organization',
])

const NON_GRANT_SEEKER_TYPES = new Set([
  'federal_agency',
  'state_agency',
  'for_profit_large',
  'publicly_traded',
])

const SMALL_BUDGET_HINTS = [
  'volunteer-led',
  'volunteer led',
  'all volunteer',
  'no paid staff',
  'shoestring',
  'small budget',
]

const RURAL_HINTS = ['rural', 'small town', 'unincorporated', 'frontier']

/**
 * Pure fit-scoring. Returns {score, reasons:[{code, weight, detail}]}.
 * Score is in 0..100 and the reasons array always shows the contributing
 * codes so the lead packet can explain *why* the score is what it is.
 */
export function computeFitScore(prospect, { config = null } = {}) {
  void config
  if (!prospect || typeof prospect !== 'object') {
    return { score: 0, reasons: [] }
  }
  const reasons = []
  let score = 0

  const type = String(prospect.applicant_type || prospect.organization_type || '').toLowerCase()

  if (type && NON_GRANT_SEEKER_TYPES.has(type)) {
    return {
      score: 0,
      reasons: [{ code: 'non_grant_seeker', weight: 0, detail: `${type} is not a GrantFlow audience` }],
    }
  }

  if (type && KNOWN_GRANT_SEEKER_TYPES.has(type)) {
    score += 25
    reasons.push({
      code: FIT_REASON_CODES.KNOWN_GRANT_SEEKER_TYPE,
      weight: 25,
      detail: `applicant_type=${type}`,
    })
  } else if (type) {
    score += 8
    reasons.push({
      code: FIT_REASON_CODES.KNOWN_GRANT_SEEKER_TYPE,
      weight: 8,
      detail: `applicant_type=${type} (uncategorized but plausible)`,
    })
  }

  if (prospect.ein) {
    score += 10
    reasons.push({ code: FIT_REASON_CODES.EIN_PRESENT, weight: 10, detail: 'EIN on file' })
  }

  if (prospect.website_url) {
    score += 8
    reasons.push({
      code: FIT_REASON_CODES.WEBSITE_LIVE,
      weight: 8,
      detail: prospect.website_url,
    })
  }

  if (prospect.contact_verification_status === CONTACT_VERIFICATION_STATUS.VERIFIED) {
    score += 12
    reasons.push({ code: FIT_REASON_CODES.HAS_VERIFIED_CONTACT, weight: 12 })
  } else if (prospect.contact_verification_status === CONTACT_VERIFICATION_STATUS.PARTIAL) {
    score += 6
    reasons.push({
      code: FIT_REASON_CODES.HAS_VERIFIED_CONTACT,
      weight: 6,
      detail: 'partial verification',
    })
  }

  if (prospect.city && prospect.state) {
    score += 5
    reasons.push({
      code: FIT_REASON_CODES.STATE_AND_LOCAL_CLEAR,
      weight: 5,
      detail: `${prospect.city}, ${prospect.state}`,
    })
  }

  const programs = Array.isArray(prospect.programs_json) ? prospect.programs_json : []
  if (programs.length > 0) {
    score += 10
    reasons.push({
      code: FIT_REASON_CODES.HAS_PUBLIC_PROGRAMS,
      weight: 10,
      detail: `${programs.length} programs listed`,
    })
  }

  const signals = prospect.signals_json && typeof prospect.signals_json === 'object' ? prospect.signals_json : {}
  if (signals.recent_grant_history) {
    score += 15
    reasons.push({
      code: FIT_REASON_CODES.RECENT_GRANT_ACTIVITY,
      weight: 15,
      detail: signals.recent_grant_history,
    })
  }
  if (signals.budget_hint && SMALL_BUDGET_HINTS.some((h) => String(signals.budget_hint).toLowerCase().includes(h))) {
    score += 5
    reasons.push({
      code: FIT_REASON_CODES.SMALL_BUDGET_GRANT_SEEKER,
      weight: 5,
      detail: signals.budget_hint,
    })
  }
  if (signals.geography_hint && RURAL_HINTS.some((h) => String(signals.geography_hint).toLowerCase().includes(h))) {
    score += 5
    reasons.push({
      code: FIT_REASON_CODES.RURAL_OR_UNDERSERVED,
      weight: 5,
      detail: signals.geography_hint,
    })
  }
  if (signals.volunteer_led === true || /volunteer/i.test(String(signals.staff_model || ''))) {
    score += 5
    reasons.push({
      code: FIT_REASON_CODES.VOLUNTEER_LED_ORG,
      weight: 5,
    })
  }

  const needs = Array.isArray(prospect.need_categories_json) ? prospect.need_categories_json : []
  if (needs.length > 0) {
    score += 5
    reasons.push({
      code: FIT_REASON_CODES.MISSION_ALIGNS_WITH_NEED_CATEGORIES,
      weight: 5,
      detail: `${needs.length} need categories listed`,
    })
  }

  return { score: Math.max(0, Math.min(100, score)), reasons }
}
