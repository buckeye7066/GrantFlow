/**
 * matchEngine.js — Canonical Matching Engine (v4.0.0)
 *
 * Single source of truth for matching profiles to funding opportunities.
 * Uses a weighted component model where each dimension produces a 0-100
 * subscale, then combines them with explicit weights:
 *
 *   Need alignment:      35%  (primary)
 *   Eligibility match:   25%
 *   Geographic relevance: 20%
 *   Category relevance:  20%
 *
 * Design principles:
 *   - Missing data → neutral baseline, never zero
 *   - No single penalty can eliminate a match
 *   - Profile depth rewards richer profiles
 *   - Floor guarantee: any validated opportunity scores ≥ 5
 *
 * Public API:
 *   scoreOpportunity(profile, opportunity)           → { score, reasons, match_explain }
 *   matchOpportunities(profile, opportunities, opts) → sorted array with score/reasons/match_explain
 *   makeDecision(score, profile, opportunity)        → { decision, explanation, reasons }
 *   computeMatchDecision(profile, opportunity, opts) → combined score + decision result
 *
 * Re-exports (backward-compat):
 *   normalizeProfile     from ./profileNormalizer.js
 *   normalizeOpportunity from ./opportunityNormalizer.js
 */

import zipcodes from 'zipcodes'
import { safeParseArrayField, resolveApplicantType, buildProfileSignals } from './profileHelpers.js'
import { normalizeProfile } from './profileNormalizer.js'
import { normalizeOpportunity, inferHousingClassification } from './opportunityNormalizer.js'
import { haversineDistanceMiles } from './sharedGeo.js'
import { listPresentProfileSignals } from './profileCoverage.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('matchEngine')
import {
  SCORE_FLOOR,
  W_NEED, W_ELIGIBILITY, W_GEO, W_CATEGORY,
  DEFAULT_MIN_SCORE, RELAX_THRESHOLDS, FALLBACK_TOP_N,
  ACCEPT_SCORE, REVIEW_SCORE,
  DECISION_ACCEPT_MIN, DECISION_CONFIDENCE_MIN,
  NEED_FULL_CREDIT_HITS,
  CONF_W_SOURCE, CONF_W_ACTIONABILITY, CONF_W_ELIGIBILITY, CONF_W_FRESHNESS,
  CONFIDENCE_SOURCE_TRUST_SCORE,
  CONFIDENCE_ACTIONABLE_FULL, CONFIDENCE_ACTIONABLE_NONE,
  CONFIDENCE_ELIGIBILITY_FULL, CONFIDENCE_ELIGIBILITY_PARTIAL, CONFIDENCE_ELIGIBILITY_NONE,
  CONFIDENCE_ELIGIBILITY_FULL_BULLETS,
  CONFIDENCE_FRESHNESS_SCORE,
  CONFIDENCE_BAND_HIGH, CONFIDENCE_BAND_MEDIUM,
} from '../config/matchThresholds.js'
import { assessOpportunityTrust } from './opportunityTrust.js'
import {
  computePreferenceNudge,
  getProfilePreferenceSignals,
  isBehaviorLearningEnabled,
} from './behaviorLearning.js'
import {
  verificationMatchAdjustment,
  opportunityTargetsOrganizations as verificationTargetsOrganizations,
} from './verification/index.js'

export { normalizeProfile, computeProfileFingerprint } from './profileNormalizer.js'
export { normalizeOpportunity, computeOpportunityFingerprint } from './opportunityNormalizer.js'

export const MATCHER_VERSION = '4.1.2'

// Re-export thresholds so consumers don't need to know about the config file
export { SCORE_FLOOR, DEFAULT_MIN_SCORE, RELAX_THRESHOLDS, FALLBACK_TOP_N }

// ---------------------------------------------------------------------------
// Source trust scoring
// ---------------------------------------------------------------------------

const OFFICIAL_SOURCE_DOMAINS = new Set([
  'grants.gov', 'sam.gov', 'hud.gov', 'acf.hhs.gov', 'ed.gov', 'sba.gov',
  'usda.gov', 'fema.gov', 'va.gov', 'ssa.gov', 'benefits.gov', 'usa.gov',
])

const TRUSTED_INTERMEDIARY_DOMAINS = new Set([
  '211.org', 'unitedway.org', 'redcross.org', 'salvationarmy.org',
  'needhelppayingbills.com', 'benefitscheckup.org', 'findhelp.org',
  'auntbertha.com', 'communityaction.org',
])

function _extractDomain(url) {
  try {
    const m = url.match(/(?:https?:\/\/)?(?:www\.)?([^/?\s]+)/)
    return m ? m[1] : ''
  } catch { return '' }
}

/**
 * Calculate source trust score (0-100). Higher = more trustworthy / official.
 */
export function calculateSourceTrust(opportunity) {
  if (!opportunity) return 20
  const url = opportunity.application_url || opportunity.apply_url ||
    opportunity.source_url || opportunity.evidence_url || opportunity.url || ''
  const urlLower = String(url).toLowerCase()
  if (!url || urlLower.trim() === '') return 10
  if (OFFICIAL_SOURCE_DOMAINS.has(_extractDomain(urlLower))) return 95
  if (urlLower.includes('.gov')) return 90
  if (urlLower.includes('.edu')) return 75
  for (const domain of TRUSTED_INTERMEDIARY_DOMAINS) {
    if (urlLower.includes(domain)) return 70
  }
  if (urlLower.includes('.org')) return 60
  const origin = opportunity.record_origin ?? ''
  if (origin === 'grants_gov' || origin === 'verified_real') return 90
  if (origin === 'curated_verified') return 80
  if (origin === 'curated_benefits' || origin === 'curated_program') return 65
  if (origin === 'live_crawl') return 40
  return 35
}

// ---------------------------------------------------------------------------
// Confidence scoring (ORTHOGONAL to MATCH score)
// ---------------------------------------------------------------------------
//
// Architecture point #7: MATCH = how well it fits (the weighted score above).
// CONFIDENCE = how sure we are it is real and actionable. They answer DIFFERENT
// questions and are computed from DIFFERENT signals, so an opportunity can be a
// 92 MATCH but a 55 CONFIDENCE when its source is weak or its eligibility text
// is incomplete. Confidence is additive metadata — it NEVER changes `score`.
//
// Four orthogonal-to-fit component subscales (each 0-100), weighted:
//   sourceTrust   — official API / verified / directory / community / unknown
//   actionability — has a real, non-placeholder application/source URL
//   eligibility   — do we actually have eligibility text (or are we guessing)
//   freshness     — rolling/ongoing or future deadline vs unknown/expired

/**
 * Map a confidence score (0-100) to a coarse band.
 * @param {number} confidence
 * @returns {'high'|'medium'|'low'}
 */
export function confidenceBand(confidence) {
  const c = Number(confidence)
  if (Number.isFinite(c) && c >= CONFIDENCE_BAND_HIGH) return 'high'
  if (Number.isFinite(c) && c >= CONFIDENCE_BAND_MEDIUM) return 'medium'
  return 'low'
}

/**
 * Eligibility-text completeness subscale (0-100). This measures whether we
 * actually KNOW the eligibility criteria — NOT whether the profile is eligible
 * (that is the MATCH engine's job). A row with several eligibility bullets is
 * "full"; one with a thin signal is "partial"; one with nothing is "none"
 * (i.e. any eligibility judgment is a guess → lower confidence).
 */
function _eligibilityCompletenessScore(opportunity) {
  const bullets = safeParseArrayField(opportunity?.eligibility_bullets, [])
    .map((b) => String(b || '').trim())
    .filter((b) => b.length > 0)
  if (bullets.length >= CONFIDENCE_ELIGIBILITY_FULL_BULLETS) return CONFIDENCE_ELIGIBILITY_FULL

  // Fall back to free-text eligibility fields some sources populate instead of
  // bullets (eligibility / eligibility_text / who_can_apply).
  const freeText = [
    opportunity?.eligibility,
    opportunity?.eligibility_text,
    opportunity?.who_can_apply,
  ]
    .map((v) => String(v || '').trim())
    .filter((v) => v.length > 0)

  if (bullets.length === 1 || freeText.some((t) => t.length >= 40)) {
    return CONFIDENCE_ELIGIBILITY_FULL
  }
  if (freeText.length > 0) return CONFIDENCE_ELIGIBILITY_PARTIAL
  return CONFIDENCE_ELIGIBILITY_NONE
}

/**
 * Freshness / deadline-validity subscale (0-100) keyed by the normalized
 * deadline status (rolling / open / unknown / closed).
 */
function _freshnessScore(deadlineStatus) {
  const key = String(deadlineStatus || 'unknown').toLowerCase()
  return CONFIDENCE_FRESHNESS_SCORE[key] ?? CONFIDENCE_FRESHNESS_SCORE.unknown
}

/**
 * Compute CONFIDENCE (0-100) and human-readable confidence_reasons for an
 * opportunity, using signals orthogonal to MATCH fit. Reuses the canonical
 * consumer-side trust classifier (opportunityTrust.assessOpportunityTrust) for
 * source-trust tier + URL actionability so confidence and the display/trust
 * layer can never drift apart.
 *
 * @param {Object} opportunity
 * @param {Object} [oppNorm] - optional pre-normalized opportunity (for deadlineStatus)
 * @returns {{ confidence: number, confidence_reasons: string[], confidence_band: string,
 *             confidence_components: object }}
 */
export function calculateConfidence(opportunity, oppNorm = null) {
  const reasons = []

  // 1. Source trust — reuse the canonical trust classifier. allowExpired etc.
  //    are irrelevant here; we only consume sourceTrust + actionability flags,
  //    not its display verdict.
  let sourceTrust = 'unknown'
  let actionable = false
  try {
    const trust = assessOpportunityTrust(opportunity, {
      allowExpired: true,
      allowLoans: true,
      allowMatchingFunds: true,
      allowDirectory: true,
    })
    sourceTrust = trust?.sourceTrust || 'unknown'
    actionable = Boolean(trust?.actionable)
  } catch {
    // Defensive: if the trust assessor throws on a malformed row, fall back to
    // the matchEngine-local source-trust heuristic and a URL presence check.
    const localTrust = calculateSourceTrust(opportunity)
    sourceTrust = localTrust >= 90 ? 'official'
      : localTrust >= 75 ? 'verified'
        : localTrust >= 60 ? 'directory'
          : localTrust >= 35 ? 'community' : 'unknown'
    const url = opportunity?.application_url || opportunity?.apply_url ||
      opportunity?.source_url || opportunity?.url || ''
    actionable = Boolean(String(url).trim())
  }

  const sourceScore = CONFIDENCE_SOURCE_TRUST_SCORE[sourceTrust] ??
    CONFIDENCE_SOURCE_TRUST_SCORE.unknown
  reasons.push(`Source trust: ${sourceTrust} (${sourceScore})`)

  // 2. Actionability — real, non-placeholder usable URL.
  const actionabilityScore = actionable ? CONFIDENCE_ACTIONABLE_FULL : CONFIDENCE_ACTIONABLE_NONE
  reasons.push(
    actionable
      ? 'Actionable: usable application/source URL'
      : 'Not actionable: no usable application/source URL',
  )

  // 3. Eligibility-text completeness.
  const eligibilityScore = _eligibilityCompletenessScore(opportunity)
  reasons.push(
    eligibilityScore >= CONFIDENCE_ELIGIBILITY_FULL
      ? 'Eligibility: detailed criteria present'
      : eligibilityScore >= CONFIDENCE_ELIGIBILITY_PARTIAL
        ? 'Eligibility: partial criteria present'
        : 'Eligibility: no criteria — eligibility is inferred',
  )

  // 4. Freshness / deadline validity.
  const deadlineStatus = oppNorm?.deadlineStatus ??
    (opportunity?.deadline_type === 'rolling' || opportunity?.deadline_type === 'ongoing'
      ? 'rolling'
      : opportunity?.deadline
        ? (new Date(opportunity.deadline) < new Date() ? 'closed' : 'open')
        : 'unknown')
  const freshnessScore = _freshnessScore(deadlineStatus)
  reasons.push(`Freshness: deadline ${deadlineStatus} (${freshnessScore})`)

  const confidence = Math.max(0, Math.min(100, Math.round(
    sourceScore * CONF_W_SOURCE +
    actionabilityScore * CONF_W_ACTIONABILITY +
    eligibilityScore * CONF_W_ELIGIBILITY +
    freshnessScore * CONF_W_FRESHNESS,
  )))

  return {
    confidence,
    confidence_reasons: reasons,
    confidence_band: confidenceBand(confidence),
    confidence_components: {
      source: sourceScore,
      actionability: actionabilityScore,
      eligibility: eligibilityScore,
      freshness: freshnessScore,
      sourceTrust,
      deadlineStatus,
    },
  }
}

// ---------------------------------------------------------------------------
// Eligibility evaluation
// ---------------------------------------------------------------------------

// A title that names a specific COUNTY or local SCHOOL DISTRICT / education
// foundation. These are intensely local awards (one district / one county). We
// match the structural shape only — "<Name> County Schools", "<Name> County
// Public Schools", "<Name> School District", "<Name> Unified", "<Name>
// Education Foundation", "<Name> County" — so it works regardless of which US
// county it is, without needing a county→state lookup table.
const LOCAL_DISTRICT_TITLE_RX = new RegExp(
  [
    /\b[a-z][a-z.'-]+\s+county\s+(?:public\s+)?schools?\b/i.source,
    /\b[a-z][a-z.'-]+\s+(?:unified\s+)?school\s+district\b/i.source,
    /\b[a-z][a-z.'-]+\s+education\s+foundation\b/i.source,
    /\b[a-z][a-z.'-]+\s+county\b/i.source,
  ].join('|'),
  'i',
)

function titleNamesLocalDistrict(title) {
  const t = String(title || '').trim()
  if (!t) return false
  return LOCAL_DISTRICT_TITLE_RX.test(t)
}

/**
 * True when the opportunity is national, in-state for ANY of the profile's
 * states, or its location is simply unknown (missing = neutral). Only when this
 * is FALSE — the opp resolves to a state that is NOT any of the profile's — does
 * the out-of-state local-award flag fire. State is resolved from the normalized
 * geography first, then the title, mirroring scoreGeoComponent.
 */
function geoLooksNationalOrInState(profileNorm, oppNorm) {
  const geo = oppNorm?.geography ?? {}
  if (geo.isNational || oppNorm?.isNational) return true

  const profStateList = (Array.isArray(profileNorm?.states) && profileNorm.states.length)
    ? profileNorm.states.map((s) => normalizeState(s)).filter(Boolean)
    : (profileNorm?.state ? [normalizeState(profileNorm.state)] : [])
  // Unknown profile location ⇒ neutral (never penalize).
  if (profStateList.length === 0) return true

  const oppState = normalizeState(geo.state) || (_extractStateNameFromTitle(oppNorm?.title) || '')
  // Unknown opp state ⇒ neutral.
  if (!oppState) return true
  return profStateList.includes(String(oppState).toUpperCase())
}

/**
 * Evaluate hard eligibility rules.
 * @param {Object} profileNorm - From normalizeProfile()
 * @param {Object} oppNorm     - From normalizeOpportunity()
 * @returns {{ eligible: true|false|"maybe", ineligibilityReasons: string[], missingFields: string[] }}
 */
export function evaluateEligibility(profileNorm, oppNorm) {
  const ineligibilityReasons = []
  const missingFields = []

  if (!profileNorm || !oppNorm) {
    return { eligible: 'maybe', ineligibilityReasons: [], missingFields: ['profile', 'opportunity'] }
  }

  if (oppNorm.isLoan) ineligibilityReasons.push('Opportunity is a loan, not a grant')

  const isIndividualOrCaregiverProfile = ['individual', 'caregiver'].includes(profileNorm.entityType)
  if (oppNorm.isProBono && !isIndividualOrCaregiverProfile) {
    ineligibilityReasons.push('Opportunity is pro bono services, not a grant or direct funding')
  }
  if (oppNorm.isInKind && !isIndividualOrCaregiverProfile) {
    ineligibilityReasons.push('Opportunity provides in-kind goods/services, not direct financial assistance')
  }
  if (oppNorm.isReferralOnly && !isIndividualOrCaregiverProfile) {
    ineligibilityReasons.push('Opportunity is a referral service only, not a direct grant application')
  }

  if (oppNorm.deadlineStatus === 'closed') ineligibilityReasons.push('Application deadline has passed')
  if (oppNorm.requiresVeteran && !profileNorm.isVeteran) ineligibilityReasons.push('Requires veteran status')
  if (oppNorm.requiresStudent && !profileNorm.isStudent) {
    // Recall guard: only HARD-REJECT when the profile affirmatively contradicts
    // student status (a non-student org/business/researcher with no education
    // signal). When the profile is student-adjacent (or simply unknown), treat
    // student status as a MISSING field → REVIEW, not REJECT, so legitimately
    // relevant student aid isn't silently dropped for a near-student.
    if (profileContradictsStudent(profileNorm)) {
      ineligibilityReasons.push('Requires student status')
    } else {
      missingFields.push('student_status')
    }
  }
  if (oppNorm.requiresWomen) {
    const isFemale = profileGenderIsFemale(profileNorm)
    if (isFemale === false) ineligibilityReasons.push('Requires women/female applicants')
    else if (isFemale === null) missingFields.push('gender')
  }

  // Explicit GENDER restriction (men-only / women-only). requiresWomen above
  // already covers the female-only path for back-compat; this also gates the
  // male-only case symmetrically. Mirrors requiresWomen: known-mismatch →
  // hard reject; unknown gender → missing field (REVIEW, never reject).
  if (oppNorm.requiresGender === 'male') {
    const isFemale = profileGenderIsFemale(profileNorm)
    if (isFemale === true) ineligibilityReasons.push('Requires male applicants')
    else if (isFemale === null) missingFields.push('gender')
  }

  // Explicit ETHNICITY restriction (canonical_rules G4 "explicitly exclusive").
  // UNCF (African-American-only), Hispanic Scholarship Fund (Hispanic-only),
  // enrolled-tribal-member scholarships, etc. HARD-REJECT only when the
  // profile's ethnicity is KNOWN and is NOT among the required buckets. When
  // the profile's ethnicity is UNKNOWN/blank, this is a MISSING field
  // (→ REVIEW), never a hard reject (missing = neutral per canonical rules).
  const requiredEthnicities = Array.isArray(oppNorm.requiresEthnicity) ? oppNorm.requiresEthnicity : []
  if (requiredEthnicities.length > 0) {
    const profBucket = profileNorm.ethnicityBucket ?? null
    if (profBucket) {
      if (!requiredEthnicities.includes(profBucket)) {
        ineligibilityReasons.push(
          `Restricted to ${requiredEthnicities.join('/')} applicants; profile ethnicity is ${profBucket}`,
        )
      }
    } else {
      missingFields.push('ethnicity')
    }
  }
  if (oppNorm.requiresNonprofit && !profileNorm.isNonprofit) ineligibilityReasons.push('Requires 501(c)(3) or nonprofit status')
  if (oppNorm.requiresBusiness && !profileNorm.isBusiness) ineligibilityReasons.push('Requires business or self-employment')

  if (oppNorm.isInstitutionalOnly || oppNorm.isResearchOnly) {
    const isOrdinaryIndividual = !profileNorm.isNonprofit && !profileNorm.isBusiness &&
      profileNorm.entityType !== 'researcher' && profileNorm.entityType !== 'organization'
    if (isOrdinaryIndividual) {
      // Already-awarded NSF/NIH/USASpending records get a specific reason so the
      // pipeline/log makes clear WHY a $300k research grant was declined for an
      // individual: it is not an open opportunity, it is funder-lead intel.
      ineligibilityReasons.push(
        oppNorm.isAlreadyAwarded
          ? 'Opportunity is an already-awarded institutional research grant (named awardee/PI); not open to individuals'
          : 'Opportunity is for institutions or research organizations only',
      )
    }
  }

  // Education-level mismatch: a K-12 / elementary / middle-school-only award is
  // for children, not an adult college student. Per canonical G4 this is an
  // effective exclusivity (an elementary-school award cannot be applied for by a
  // 20-year-old community-college student), but we keep it a MISSING field rather
  // than a hard reject when the profile MIGHT have a school-age child in the
  // household (a parent could legitimately pursue it). Either way it can no longer
  // ACCEPT for an adult higher-ed profile — eligible becomes 'maybe' (→ REVIEW)
  // and the score is capped downstream.
  if (oppNorm.educationLevel === 'k12') {
    const ageNum = Number(profileNorm.age)
    const isAdult = (Number.isFinite(ageNum) && ageNum >= 18) ||
      (profileNorm.ageGroup && /adult|senior/i.test(String(profileNorm.ageGroup))) ||
      profileNorm.entityType === 'business' || profileNorm.entityType === 'nonprofit'
    const isHigherEdStudent = profileNorm.isStudent && isAdult
    const couldBeForAChild = profileNorm.householdHasChildren === true || profileNorm.isCaregiver
    if ((isHigherEdStudent || isAdult) && !couldBeForAChild) {
      missingFields.push('education_level_mismatch_k12')
    }
  }

  // Out-of-state LOCAL award: a row whose TITLE names a specific county or school
  // district (e.g. "Polk County Schools", "Polk Education Foundation") that is in
  // a state which is NOT any of the profile's states. These are intensely local
  // (a single district) and not accessible to an out-of-state resident, yet they
  // keyword-collide on "scholarship"/"education" and scored 90%+/ACCEPT. We flag
  // the geographic mismatch (→ score cap + REVIEW) without a hard reject so a
  // genuinely national program that merely mentions a county is not lost.
  if (!geoLooksNationalOrInState(profileNorm, oppNorm)) {
    if (titleNamesLocalDistrict(oppNorm.title)) {
      missingFields.push('local_award_out_of_state')
    }
  }

  if (oppNorm.diseaseSpecific && !profileNorm.hasChronicIllness && !profileNorm.hasDisabilityNeed) {
    ineligibilityReasons.push('Opportunity targets a specific medical condition not indicated in profile')
  }
  if (oppNorm.requiresDisasterContext && !profileNorm.hasEmergencyNeed) {
    ineligibilityReasons.push('Opportunity requires disaster or emergency context not present in profile')
  }
  if (oppNorm.isCaregiverProgram && !profileNorm.isCaregiver && !profileNorm.hasFosterIndicator) {
    missingFields.push('caregiver_status')
  }
  if (profileNorm.isUnableToWork && oppNorm.needTypesSupported?.includes('education')) {
    const isWorkforceFocused = oppNorm.needTypesSupported?.every(n => ['education', 'business'].includes(n))
    if (isWorkforceFocused && !oppNorm.needTypesSupported?.includes('disability')) {
      ineligibilityReasons.push('Profile indicates unable to work; workforce training programs not applicable')
    }
  }

  if (profileNorm.enrolledPrograms?.length > 0 && oppNorm.title) {
    const titleLower = (oppNorm.title || '').toLowerCase()
    for (const prog of profileNorm.enrolledPrograms) {
      if (prog === 'medicaid' && titleLower.includes('medicaid') && (titleLower.includes('contact') || titleLower.includes('enroll'))) {
        ineligibilityReasons.push('Profile already enrolled in Medicaid')
      }
      if (prog === 'snap' && titleLower.includes('snap') && !titleLower.includes('education')) {
        ineligibilityReasons.push('Profile already receiving SNAP benefits')
      }
      if (prog === 'ssi' && titleLower.includes('ssi (supplemental')) {
        ineligibilityReasons.push('Profile already receiving SSI')
      }
      if (prog === 'ssdi' && titleLower.includes('ssdi (social security disability')) {
        ineligibilityReasons.push('Profile already receiving SSDI')
      }
    }
  }

  if (oppNorm.needTypesSupported?.includes('family_life') && oppNorm.title) {
    const titleLower = (oppNorm.title || '').toLowerCase()
    const isChildSpecific = titleLower.includes('head start') || titleLower.includes('child care') ||
      titleLower.includes('wic') || titleLower.includes('children')
    if (isChildSpecific && profileNorm.householdHasChildren === false &&
        (profileNorm.ageGroup || '').toLowerCase().includes('senior')) {
      ineligibilityReasons.push('Program requires children in household; profile is a childless senior household')
    }
  }

  if (oppNorm.title) {
    const titleLower = (oppNorm.title || '').toLowerCase()
    const isRefugeeProgram = titleLower.includes('refugee') || titleLower.includes('resettlement')
    if (isRefugeeProgram && !profileNorm.isRefugee) {
      ineligibilityReasons.push('Program is for refugees/resettlement; profile has no refugee indicator')
    }
  }

  if (oppNorm.isDmeOrEquipment && !profileNorm.hasDisabilityNeed && !profileNorm.hasChronicIllness) {
    missingFields.push('disability_or_medical_need_for_equipment')
  }

  // Affiliation-aware eligibility: faith-based opportunities should prefer
  // profiles with church/faith affiliations but NOT hard-reject others
  const profAffiliations = profileNorm.affiliations ?? []
  if (oppNorm.title) {
    const titleLower = (oppNorm.title || '').toLowerCase()
    const isFaithBased = /\b(faith[- ]based|church|ministry|congregation)\b/i.test(titleLower)
    if (isFaithBased && !profAffiliations.includes('faith_based') && !profAffiliations.includes('church')) {
      missingFields.push('faith_based_affiliation')
    }
    const isTribal = /\b(tribal|indigenous|native american)\b/i.test(titleLower)
    if (isTribal && !profAffiliations.includes('tribal') &&
        !(profileNorm.demographics ?? []).includes('native_american') &&
        !(profileNorm.demographics ?? []).includes('tribal_affiliation')) {
      missingFields.push('tribal_affiliation')
    }
  }

  const allowedTypes = oppNorm.entityTypesAllowed ?? []
  if (allowedTypes.length > 0 && !allowedTypes.includes('individual')) {
    const profileType = profileNorm.entityType
    if (profileType && !allowedTypes.includes(profileType)) {
      const qualifiesByTrait = (
        (allowedTypes.includes('veteran') && profileNorm.isVeteran) ||
        (allowedTypes.includes('student') && profileNorm.isStudent) ||
        (allowedTypes.includes('nonprofit') && profileNorm.isNonprofit) ||
        (allowedTypes.includes('business') && profileNorm.isBusiness) ||
        (allowedTypes.includes('caregiver') && profileNorm.isCaregiver)
      )
      if (!qualifiesByTrait && profileType !== 'organization') {
        ineligibilityReasons.push(`Opportunity is for ${allowedTypes.join('/')} but profile is ${profileType}`)
      }
    }
  }

  const geo = oppNorm.geography ?? {}
  if (!geo.isNational && geo.state) {
    // Multi-address aware: in-state if the opportunity's state matches ANY of the
    // profile's states. `states` (primary-first list) is preferred when present;
    // falls back to the singular `state` so single-address profiles are unchanged.
    const profStateList = (Array.isArray(profileNorm.states) && profileNorm.states.length)
      ? profileNorm.states.map((s) => normalizeState(s)).filter(Boolean)
      : (profileNorm.state ? [normalizeState(profileNorm.state)] : [])
    const oppGeoState = normalizeState(geo.state)
    if (profStateList.length > 0 && oppGeoState && !profStateList.includes(oppGeoState)) {
      ineligibilityReasons.push(`Geographic mismatch: opportunity is for ${geo.state}, profile is in ${profStateList.join('/')}`)
    } else if (profStateList.length === 0 && !profileNorm.zip) {
      missingFields.push('profile_location')
    }
  }

  if (!profileNorm.entityType) missingFields.push('entity_type')
  if (!oppNorm.hasApplicationUrl) missingFields.push('application_url')

  const hardIneligible = ineligibilityReasons.length > 0
  const hasMissingData = missingFields.length > 0
  let eligible
  if (hardIneligible) eligible = false
  else if (hasMissingData) eligible = 'maybe'
  else eligible = true

  return { eligible, ineligibilityReasons, missingFields }
}

// ---------------------------------------------------------------------------
// Need alignment
// ---------------------------------------------------------------------------

/**
 * Calculate how well the opportunity's need types match the profile's need categories.
 * @param {Object} profileNorm - From normalizeProfile()
 * @param {Object} oppNorm     - From normalizeOpportunity()
 * @returns {{ score: number, matchedNeeds: string[] }}
 */
export function calculateNeedAlignment(profileNorm, oppNorm) {
  const profileNeeds = profileNorm?.needCategories ?? []
  const oppNeeds = oppNorm?.needTypesSupported ?? []

  // Soft baseline: even when profile has no declared needs, having location/entity/flags
  // means we can provide a non-zero baseline so scoring isn't zeroed out.
  if (profileNeeds.length === 0) {
    const hasLoc = Boolean(profileNorm?.state || profileNorm?.zip)
    const hasEntity = Boolean(profileNorm?.entityType)
    const hasFlags = Boolean(
      profileNorm?.isVeteran || profileNorm?.isStudent || profileNorm?.isNonprofit ||
      profileNorm?.isBusiness || profileNorm?.isCaregiver || profileNorm?.hasDisabilityNeed
    )
    if (hasLoc || hasEntity || hasFlags) {
      const richness = (hasLoc ? 14 : 0) + (hasEntity ? 10 : 0) + (hasFlags ? 12 : 0)
      return { score: Math.min(40, Math.round(15 + richness * 0.5)), matchedNeeds: [] }
    }
    return { score: 0, matchedNeeds: [] }
  }

  // When opp declares no specific need types (common for legacy/directory catalog rows),
  // scale with profile strength so well-filled profiles can reach meaningful match tiers.
  if (oppNeeds.length === 0) {
    // Opportunity declares no specific needs. Do not let generic rows look
    // like strong matches just because the profile is well-filled — return
    // a modest neutral score that requires other signals to push it higher.
    const hasLoc = Boolean(profileNorm?.state || profileNorm?.zip)
    const hasEntity = Boolean(profileNorm?.entityType)
    const richness = Math.min(
      100,
      profileNeeds.length * 14 + (hasLoc ? 10 : 0) + (hasEntity ? 8 : 0),
    )
    const score = Math.min(45, Math.round(18 + richness * 0.22))
    return { score, matchedNeeds: [] }
  }

  const matchedNeeds = profileNeeds.filter((n) => oppNeeds.includes(n))
  const profileCoverage = matchedNeeds.length / profileNeeds.length
  const oppCoverage = matchedNeeds.length / Math.max(oppNeeds.length, 1)
  let score = Math.min(100, Math.round(((profileCoverage + oppCoverage) / 2) * 100))
  if (matchedNeeds.length >= 2) {
    score = Math.min(100, Math.round(score * 1.06 + matchedNeeds.length * 2))
  }
  return { score: Math.min(100, score), matchedNeeds }
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const PRO_BONO_OPPORTUNITY_TYPES = new Set([
  'pro_bono', 'in_kind', 'charity_care', 'training_paid',
  'legal_aid', 'clinic_service', 'equipment_donation',
])

const SERVICE_FUNDING_TYPES = new Set(['service', 'cost_coverage', 'referral'])

const AMBIGUOUS_SINGLE_WORDS = new Set([
  'food', 'care', 'home', 'house', 'school', 'community',
  'child', 'children', 'work', 'service', 'support', 'program',
  'help', 'need', 'general', 'special', 'local', 'national',
  'plan', 'fund', 'grant', 'money', 'bank', 'credit', 'loan',
  'start', 'open', 'build', 'make', 'create',
  'resource', 'free', 'apply', 'person', 'people',
])

const NEED_SYNONYMS = {
  housing: ['rent', 'rental', 'eviction', 'shelter', 'housing', 'tenant', 'apartment', 'mortgage', 'homeless'],
  rent: ['housing', 'rental', 'rent', 'eviction', 'tenant', 'apartment', 'shelter'],
  utilities: ['utility', 'utilities', 'energy', 'electric', 'heating', 'water', 'gas'],
  food: ['food', 'nutrition', 'hunger', 'snap', 'meal', 'pantry', 'grocery'],
  medical: ['health', 'medical', 'healthcare', 'hospital', 'prescription', 'dental', 'vision', 'medicaid', 'medicare', 'tenncare'],
  healthcare: ['health', 'medical', 'healthcare', 'hospital', 'prescription', 'medicaid', 'medicare', 'tenncare', 'clinic'],
  disability: ['disability', 'disabled', 'accessible', 'accommodation', 'mobility', 'caregiver'],
  transportation: ['transportation', 'transit', 'bus', 'vehicle', 'rideshare', 'car'],
  education: ['education', 'tuition', 'scholarship', 'school', 'college', 'university', 'academic'],
  childcare: ['childcare', 'daycare', 'preschool', 'child care', 'children'],
  financial_assistance: ['financial', 'assistance', 'emergency', 'cash', 'payment', 'aid'],
  clothing_goods: ['clothing', 'clothes', 'furniture', 'goods', 'household', 'material'],
  // Smart Matcher spec §2 — Professional Development & Continuing Education
  professional_development: [
    'professional', 'development', 'continuing', 'education', 'license', 'licensure',
    'certification', 'credential', 'workforce', 'wioa', 'training', 'remediation',
    'ethics', 'boundaries', 'cme', 'ceu', 'recertification', 'reentry', 're-entry',
    'scholarship', 'tuition', 'probe', 'citi', 'scope', 'pace', 'cpep', 'apprenticeship',
    'fellowship', 'residency',
  ],
  continuing_education: [
    'professional', 'development', 'continuing', 'education', 'cme', 'ceu', 'license',
    'licensure', 'certification', 'recertification', 'training', 'workshop', 'course',
  ],
  // Student aid / cost-of-attendance (parallels Professional Development).
  // Surfaces FAFSA / Pell / FSEOG / state aid / room-and-board scholarships /
  // school-cost-of-attendance rows when the student profile or query mentions
  // off-campus, on-campus, dorm, room and board, COA, college living, or
  // any of the federal / state student-aid program names.
  student_aid: [
    'student', 'scholarship', 'tuition', 'fafsa', 'pell', 'fseog',
    'work-study', 'work study', 'cost', 'attendance', 'room', 'board',
    'housing', 'off-campus', 'on-campus', 'dorm', 'residence',
    'college', 'university', 'undergrad', 'graduate', 'campus',
    'aid', 'grant', 'completion', 'emergency', 'institutional',
    'hope', 'promise', 'aspire', 'tsaa', 'reconnect', 'cal grant',
    'tap', 'map', 'bright futures', 'kees',
  ],
  student_living: [
    'student', 'housing', 'off-campus', 'on-campus', 'dorm', 'residence',
    'rent', 'apartment', 'living', 'campus', 'room', 'board', 'cost',
    'attendance', 'fafsa', 'pell', 'fseog', 'aid', 'scholarship', 'grant',
    'emergency', 'completion',
  ],
  cost_of_attendance: [
    'cost', 'attendance', 'coa', 'fafsa', 'pell', 'fseog', 'work-study',
    'tuition', 'fees', 'room', 'board', 'housing', 'transportation',
    'books', 'supplies', 'student', 'scholarship', 'aid',
  ],
}

const STATE_MAPPING = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA',
  michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
  washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC',
}

// Sorted longest-first so multi-word names match before shorter overlapping names.
const _STATE_NAME_ENTRIES = Object.entries(STATE_MAPPING).sort((a, b) => b[0].length - a[0].length)

// ---------------------------------------------------------------------------
// Named regex constants for cross-category mismatch detection
// ---------------------------------------------------------------------------

const RE_UNIVERSITY_PROGRAM = /\b(university\s*[—–-]|college\s*[—–-]|university\s+financial aid|college\s+financial aid|university\s+housing|college\s+housing|institutional scholarship|financial aid.*university|financial aid.*college|off.campus\s+(housing|resources?)|enrolled\s+students?|community college.{0,30}(aid|grant|scholarship))\b/i
const RE_FEMA_DISASTER = /\b(fema individual assistance|fema disaster (relief|assistance|grant)|disaster (relief|assistance) grant|ihp\b|individuals and households program)\b/i
const RE_FEMA_DISASTER_STRICT = /\b(fema individual assistance|fema disaster (relief|assistance)|disaster relief grant|ihp\b|individuals and households program)\b/i
const RE_VETERAN_SPECIFIC = /\b(ssvf|supportive services for veteran|boots to business|veteran entrepreneurship|veteran families)\b/i
const RE_BUSINESS_SBA = /\b(sba\b|small business (administration|development|innovation)|sbir|sttr|entrepreneur(ship)?\s+(training|center|program))\b/i
const RE_NONPROFIT_ONLY = /\b(for nonprofits|philanthropy for nonprofits|grants? for nonprofits)\b/i
const RE_INSTITUTIONAL_ONLY = /\b(research institution|institutional grant|universities only|colleges only)\b/i
const RE_VETERAN_ONLY = /\bveterans?\s+only\b|\bfor\s+veterans?\s+only\b/i
const RE_STUDENT_ONLY = /\bstudents?\s+only\b|\bfor\s+students?\s+only\b|\bfor\s+enrolled\s+students?\b|\benrolled\s+students?\s+(?:at|in|of)\b|\bfor\s+(?:tn\s+|state\s+)?students?\s+(?:with|pursuing|enrolled|attending)\b|\b(?:female|women(?:'s)?)\s+students?\b/i
const RE_STUDENT_AID_SIGNAL = /\b(scholarship|scholarships|tuition|fafsa|pell|fseog|work[- ]study|cost of attendance|cost_of_attendance|room and board|student aid|student_aid|hope scholarship|collegepays|undergraduate|community college)\b/i
const RE_WOMEN_ONLY = /\b(women\s+only|female\s+students?|women(?:'s)?\s+engineers?|for\s+women\b|women\s+in\s+(?:stem|engineering))\b/i
const RE_NONPROFIT_REQUIRED = /\b(for nonprofits only|nonprofits only|501\(c\)\(3\) required|exclusively\s+(?:for|to)\s+501\(c\)\(3\)|501\(c\)\(3\) organizations)\b/i
const RE_DISASTER_SIGNAL = /disaster|fema|emergency|flood|fire|tornado|hurricane|storm/i

// ---------------------------------------------------------------------------
// String / geo helpers
// ---------------------------------------------------------------------------

function normalizeString(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

function normalizeCounty(value) {
  return normalizeString(String(value || '')).replace(/\bcounty\b/g, '').replace(/\s+/g, ' ').trim()
}

function profileGenderIsFemale(profileNorm) {
  const g = String(profileNorm?.gender || '').toLowerCase().trim()
  if (!g) return null
  if (/\bfemale\b|\bwoman\b|\bwomen\b|\bgirl\b/.test(g)) return true
  if (/\bmale\b|\bman\b|\bmen\b|\bboy\b/.test(g)) return false
  return null
}

function profileWantsStudentAid(profileNorm, effectiveSignals) {
  const cats = profileNorm?.needCategories ?? []
  if (cats.some((n) => ['student_aid', 'cost_of_attendance', 'scholarship'].includes(String(n)))) return true
  const signalNeeds =
    effectiveSignals?.needs instanceof Set ? Array.from(effectiveSignals.needs) : []
  return signalNeeds.some((n) => ['student_aid', 'cost_of_attendance', 'scholarship'].includes(String(n)))
}

/**
 * STUDENT-ADJACENT detection (recall guard for student aid).
 *
 * A `requiresStudent` opportunity used to HARD-REJECT any profile whose
 * `isStudent` flag was not affirmatively true, which silently dropped
 * legitimately relevant aid (TN HOPE, Pell, TSAA, STEP UP, Reconnect, Aspire)
 * for profiles that are obviously near-students but never checked the literal
 * "is_student" box. We instead downgrade those to REVIEW (missing field), and
 * keep the hard REJECT ONLY when the profile affirmatively CONTRADICTS student
 * status (a business/nonprofit/researcher org with no education signal at all).
 *
 * "Student-adjacent" = ANY of:
 *   - already detected isStudent (caller may still want the signal),
 *   - typical student age (~16–24) or a youth/young-adult age group/demographic,
 *   - an education section was present at all (academics gpa/act/sat captured,
 *     or a first-generation / education demographic flag),
 *   - an explicit education field (school_name, grade_level, field_of_study,
 *     degree_program, highest_level, currently_enrolled) on the raw profile or
 *     its education section,
 *   - applicant type includes "student",
 *   - declared needs include education / student_aid / scholarship / tuition /
 *     cost_of_attendance.
 *
 * @param {Object} profileNorm normalized profile (from normalizeProfile)
 * @param {Object} [rawProfile] optional raw profile/sections for field probing
 */
function isStudentAdjacent(profileNorm, rawProfile = null) {
  if (!profileNorm) return false
  if (profileNorm.isStudent) return true

  // Age window (numeric age or age group / demographic bucket).
  const numericAge = Number(profileNorm.age)
  if (Number.isFinite(numericAge) && numericAge >= 16 && numericAge <= 24) return true
  const ageGroup = String(profileNorm.ageGroup ?? '').toLowerCase()
  if (/\b(youth|teen|young[\s_-]?adult|student|college|high[\s_-]?school|18[-\s]?24|16[-\s]?24)\b/.test(ageGroup)) {
    return true
  }
  const demographics = Array.isArray(profileNorm.demographics) ? profileNorm.demographics : []
  if (demographics.some((d) => ['youth', 'young_adult', 'first_generation'].includes(String(d)))) {
    return true
  }

  // Declared / inferred needs that imply education funding intent.
  const cats = Array.isArray(profileNorm.needCategories) ? profileNorm.needCategories : []
  if (cats.some((n) => ['education', 'student_aid', 'scholarship', 'tuition', 'cost_of_attendance', 'professional_development'].includes(String(n)))) {
    return true
  }

  // Academics block captured (education section was present + parsed).
  const academics = profileNorm.academics ?? null
  if (academics && (academics.gpa || academics.act || academics.sat)) return true

  // Applicant types include "student".
  const applicantTypes = Array.isArray(profileNorm.applicantTypes)
    ? profileNorm.applicantTypes
    : (profileNorm.applicantTypes && typeof profileNorm.applicantTypes[Symbol.iterator] === 'function'
        ? Array.from(profileNorm.applicantTypes)
        : [])
  if (applicantTypes.some((t) => String(t).toLowerCase().includes('student'))) return true

  // Probe the raw profile / education section for explicit education fields the
  // normalizer doesn't surface as a flag but which clearly indicate a student.
  const prof = rawProfile?.profile ?? rawProfile ?? null
  const sections = rawProfile?.sections ?? prof?.sections ?? null
  const eduSection =
    sections?.education ?? sections?.education_information ?? sections?.student ?? null
  if (eduSection) return true // an education section present AT ALL is student-adjacent
  if (prof && typeof prof === 'object') {
    const eduFields = [
      prof.school_name, prof.grade_level, prof.field_of_study,
      prof.degree_program, prof.highest_level, prof.currently_enrolled,
      prof.is_student, prof.enrolled_in_school,
    ]
    if (eduFields.some((v) => v !== null && v !== undefined && String(v).trim() !== '' && v !== false)) {
      return true
    }
  }

  return false
}

/**
 * True iff the profile AFFIRMATIVELY contradicts being a student — i.e. it is a
 * clearly non-student organization/business/researcher with NO student-adjacent
 * signal at all. Only such profiles keep the hard REJECT for student-only aid.
 */
function profileContradictsStudent(profileNorm, rawProfile = null) {
  if (!profileNorm) return false
  if (isStudentAdjacent(profileNorm, rawProfile)) return false
  const nonStudentEntity = ['business', 'nonprofit', 'organization', 'researcher', 'government']
  return nonStudentEntity.includes(String(profileNorm.entityType ?? ''))
}

function isStudentAidOpportunity(opportunity, oppNorm) {
  if (oppNorm?.requiresStudent) return true
  const oppText = `${opportunity?.title || ''} ${opportunity?.description || ''}`.toLowerCase()
  if (RE_STUDENT_AID_SIGNAL.test(oppText)) return true
  const oppType = String(opportunity?.opportunity_type || opportunity?.type || '').toLowerCase()
  if (['portal', 'referral', 'school_portal'].includes(oppType) && /\bscholarship\b/.test(oppText)) return true
  const cats = safeParseArrayField(opportunity?.categories, []).map((c) => String(c).toLowerCase())
  return cats.some((c) => ['student_aid', 'cost_of_attendance', 'scholarship', 'education'].includes(c))
}

function normalizeState(value) {
  if (!value) return ''
  const s = String(value).toLowerCase().trim()
  if (STATE_MAPPING[s]) return STATE_MAPPING[s].toUpperCase()
  const sanitized = s.replace(/[^a-z]/g, '')
  return sanitized.length === 2 ? sanitized.toUpperCase() : sanitized.toUpperCase()
}

/**
 * profileStates(signals) — ALL of a profile's states, deduped, primary-first.
 *
 * STRICTLY ADDITIVE + NEUTRAL: a single-address profile (or an older snapshot
 * that predates multi-address support) returns exactly one state — its primary —
 * so geo behavior is unchanged. A two-address profile (e.g. home OH + school TN)
 * returns both, letting an in-state match be claimed for EITHER state.
 *
 * Reads `signals.states` (the deduped primary-first list emitted by
 * buildProfileSignals) when present, and ALWAYS falls back to the primary
 * `signals.location.state` so nothing breaks for snapshots without `states`.
 * Returns normalized 2-letter codes; empty array when no state is known
 * (caller must treat empty as NEUTRAL, never a penalty).
 *
 * @param {object|null} signals - effectiveSignals (analysis shape) or null
 * @param {string|null} [fallbackState] - a flat profile state (last-resort)
 * @returns {string[]} normalized state codes, primary first, deduped
 */
function profileStates(signals, fallbackState = null) {
  const out = []
  const add = (v) => {
    const norm = normalizeState(v)
    if (norm && !out.includes(norm)) out.push(norm)
  }
  // Primary first (back-compat with snapshots that predate `states`).
  const primary = signals?.location?.state ?? null
  if (primary) add(primary)
  if (Array.isArray(signals?.states)) {
    for (const st of signals.states) add(st)
  }
  // Last-resort flat fallback (older callers passing a bare profile state).
  if (out.length === 0 && fallbackState) add(fallbackState)
  return out
}

function _extractStateNameFromTitle(title) {
  const lower = (title || '').toLowerCase()
  for (const [name, abbr] of _STATE_NAME_ENTRIES) {
    if (lower.includes(name)) return abbr
  }
  return null
}

function applicantTypeSetHas(applicantTypesSet, values = []) {
  if (!applicantTypesSet || applicantTypesSet.size === 0) return false
  return values.some((v) => applicantTypesSet.has(String(v).toLowerCase()))
}

function ensureArray(value) {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined) return []
  return [value]
}

function tokenizeFacetTerms(values = []) {
  return ensureArray(values)
    .map((v) => normalizeString(String(v || '')))
    .filter((v) => {
      if (!v) return false
      if (v.includes(' ')) return v.length >= 6
      if (v.length < 4) return false
      if (AMBIGUOUS_SINGLE_WORDS.has(v)) return false
      return true
    })
}

const _regexCache = new Map()

function textIncludesToken(text, token) {
  const needle = normalizeString(token)
  if (!needle) return false
  if (needle.includes(' ')) return text.includes(needle)
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!_regexCache.has(escaped)) {
    _regexCache.set(escaped, new RegExp(`\\b${escaped}\\b`, 'i'))
  }
  return _regexCache.get(escaped).test(text)
}

function countTokenMatches(text, tokens = []) {
  let count = 0
  for (const token of tokens) {
    if (textIncludesToken(text, token)) count++
  }
  return count
}

function humanizeEnum(value) {
  const normalized = normalizeString(value)
  if (!normalized) return 'unknown'
  return normalized.replace(/_/g, ' ')
}

// ---------------------------------------------------------------------------
// Eligibility helper
// ---------------------------------------------------------------------------

function eligibilityMatchesApplicantType(opportunity, profile) {
  const eligibility = safeParseArrayField(opportunity.eligibility_bullets, [])
  const applicantTypesSet =
    profile?.applicantTypes && typeof profile.applicantTypes[Symbol.iterator] === 'function'
      ? new Set(Array.from(profile.applicantTypes).map((v) => String(v).toLowerCase()))
      : null
  const profileType = resolveApplicantType(profile) || ''

  if ((!profileType || profileType.length === 0) && (!applicantTypesSet || applicantTypesSet.size === 0)) return false

  const typeKeywords = {
    // 'individual' and 'individual_need' are aliases — both share the same
    // applicant-type keywords so a profile with primary_type='individual'
    // is recognized when an opportunity describes its audience as
    // "residents", "households", or "persons" without using the literal
    // word "individual".
    individual: ['individual', 'person', 'resident', 'residents', 'household', 'households'],
    individual_need: ['individual', 'person', 'resident', 'residents', 'household', 'households'],
    family: ['family', 'household', 'parent', 'families'],
    organization: ['organization', 'org', 'agency', 'entity'],
    nonprofit: ['nonprofit', 'non-profit', '501(c)(3)', 'charity', 'charitable'],
    small_business: ['small business', 'enterprise', 'microenterprise', 'startup', 'entrepreneur', 'sba', 'smb'],
    student: ['student', 'scholar', 'undergraduate', 'graduate', 'college'],
    college_student: ['college student', 'undergraduate', 'university student'],
    high_school_student: ['high school', 'secondary student', 'k-12'],
    medical_assistance: ['medical', 'health', 'healthcare', 'patient'],
    government: ['government', 'municipal', 'state', 'local government', 'public sector'],
  }

  const profileTypesToCheck = applicantTypesSet?.size ? Array.from(applicantTypesSet) : [profileType]
  const keywords = profileTypesToCheck
    .flatMap((t) => typeKeywords[t] || [t])
    .filter(Boolean)
    .map((t) => String(t))

  const individualServesKeywords = [
    'individual assistance', 'personal grant', 'household assistance',
    'direct cash', 'direct payment', 'individual benefit',
  ]
  const isIndividualType = profileTypesToCheck.some((t) =>
    ['individual_need', 'individual', 'family', 'medical_assistance', 'student',
      'college_student', 'high_school_student'].includes(t),
  )
  if (isIndividualType) keywords.push(...individualServesKeywords)

  const eligibilityText = eligibility.join(' ').toLowerCase()
  const oppText = `${opportunity.title || ''} ${opportunity.description || ''}`.toLowerCase()

  // Also consult declared opportunity categories so a profile of
  // primary_type='small_business' is recognized when the opportunity carries
  // categories: ["small_business"] even if its prose says "small organizations"
  // rather than the literal phrase "small business".
  const oppCategories = safeParseArrayField(opportunity.categories, [])
    .map((c) => String(c).toLowerCase().replace(/[\s-]+/g, '_'))
  const profileTypesNormalized = profileTypesToCheck.map((t) =>
    String(t).toLowerCase().replace(/[\s-]+/g, '_'),
  )
  if (oppCategories.some((c) => profileTypesNormalized.includes(c))) return true

  return keywords.some(
    (keyword) => eligibilityText.includes(keyword.toLowerCase()) || oppText.includes(keyword.toLowerCase()),
  )
}

// ---------------------------------------------------------------------------
// Keyword overlap
// ---------------------------------------------------------------------------

function calculateKeywordOverlap(profile, opportunity) {
  const intentPhraseSet =
    profile?.intentPhrases && typeof profile.intentPhrases[Symbol.iterator] === 'function'
      ? Array.from(profile.intentPhrases) : []
  const keywordSet =
    profile?.keywordSet && typeof profile.keywordSet[Symbol.iterator] === 'function'
      ? Array.from(profile.keywordSet) : []
  const phraseSet =
    profile?.phrases && typeof profile.phrases[Symbol.iterator] === 'function'
      ? Array.from(profile.phrases) : []
  const interestSet =
    profile?.interests && typeof profile.interests[Symbol.iterator] === 'function'
      ? Array.from(profile.interests) : []
  const demographicSet =
    profile?.demographics && typeof profile.demographics[Symbol.iterator] === 'function'
      ? Array.from(profile.demographics) : []
  const militarySet =
    profile?.military && typeof profile.military[Symbol.iterator] === 'function'
      ? Array.from(profile.military) : []
  const assistanceSet =
    profile?.assistance && typeof profile.assistance[Symbol.iterator] === 'function'
      ? Array.from(profile.assistance) : []
  const genderSet =
    profile?.genders && typeof profile.genders[Symbol.iterator] === 'function'
      ? Array.from(profile.genders) : []
  const applicantTypes =
    profile?.applicantTypes && typeof profile.applicantTypes[Symbol.iterator] === 'function'
      ? Array.from(profile.applicantTypes) : []

  const profileKeywords = safeParseArrayField(profile.keywords, [])
  const focusAreas = safeParseArrayField(profile.focus_areas, [])
  const programAreas = safeParseArrayField(profile.program_areas, [])
  const profileNeeds = safeParseArrayField(profile.needs, [])

  const allTerms = [
    ...phraseSet, ...interestSet, ...demographicSet, ...militarySet,
    ...assistanceSet, ...genderSet, ...applicantTypes,
    ...keywordSet, ...profileKeywords, ...focusAreas, ...programAreas,
    ...profileNeeds,
  ]
    .map((k) => String(k).toLowerCase().trim())
    .filter((k) => k.length > 0)

  if (allTerms.length === 0) return 0

  const oppKeywords = safeParseArrayField(opportunity.keywords, [])
  const oppCategories = safeParseArrayField(opportunity.categories, [])
  const oppText = `${opportunity.title || ''} ${opportunity.description || ''}`.toLowerCase()

  const intentPhraseStrings = new Set(
    intentPhraseSet.map((p) => String(p).toLowerCase()).filter((p) => p.length >= 4),
  )
  const phraseSetStrings = new Set(
    [...phraseSet, ...interestSet]
      .map((p) => String(p).toLowerCase().trim())
      .filter((p) => p.length >= 6 && p.includes(' ')),
  )

  let matches = 0
  const matchedIntentPhrases = new Set()

  // Tier 1: intent phrase matches (5 pts each)
  for (const phrase of intentPhraseSet) {
    const phraseLower = String(phrase).toLowerCase()
    if (phraseLower.length < 4) continue
    if (oppText.includes(phraseLower) || oppKeywords.some((ok) => String(ok).toLowerCase().includes(phraseLower))) {
      matches += 5
      matchedIntentPhrases.add(phraseLower)
    }
  }
  if (intentPhraseStrings.size > 0 && matchedIntentPhrases.size === 0) {
    matches -= 2
  }

  // Tier 2: multi-word phrase matches (3 pts each)
  for (const phrase of [...phraseSet, ...interestSet]) {
    const phraseLower = String(phrase).toLowerCase().trim()
    if (phraseLower.length < 6 || !phraseLower.includes(' ')) continue
    if (intentPhraseStrings.has(phraseLower)) continue
    if (oppText.includes(phraseLower)) matches += 3
  }

  // Tier 3: single keyword matches
  const allPhraseStrings = [...intentPhraseStrings, ...phraseSetStrings]
  for (const keyword of allTerms) {
    const kw = keyword.toLowerCase()
    if (AMBIGUOUS_SINGLE_WORDS.has(kw)) continue
    if (kw.includes(' ')) continue
    if (allPhraseStrings.some((p) => p.includes(kw))) continue
    if (oppKeywords.some((ok) => String(ok).toLowerCase().includes(kw))) {
      matches += 1.5
      continue
    }
    if (oppCategories.some((oc) => String(oc).toLowerCase().includes(kw))) {
      matches += 1.5
      continue
    }
    if (oppText.includes(kw)) matches += 0.5
  }

  return Math.max(-10, Math.min(25, Math.floor(matches)))
}

// ---------------------------------------------------------------------------
// Category match
// ---------------------------------------------------------------------------

function calculateCategoryMatch(profile, opportunity) {
  const profileCategories = [
    ...safeParseArrayField(profile.program_areas, []),
    ...(profile?.interests && typeof profile.interests[Symbol.iterator] === 'function'
      ? Array.from(profile.interests) : []),
    ...safeParseArrayField(profile.needs, []),
  ]
  const oppCategories = safeParseArrayField(opportunity.categories, [])

  if (profileCategories.length === 0 || oppCategories.length === 0) return 0

  let matches = 0
  profileCategories.forEach((pc) => {
    const pcLower = String(pc).toLowerCase()
    oppCategories.forEach((oc) => {
      const ocLower = String(oc).toLowerCase()
      if (pcLower === ocLower) {
        matches += 5
      } else if (pcLower.length > 5 && ocLower.length > 5 && (pcLower.includes(ocLower) || ocLower.includes(pcLower))) {
        matches += 2
      }
    })
  })

  return Math.min(20, matches)
}

// ---------------------------------------------------------------------------
// Amount / deadline helpers
// ---------------------------------------------------------------------------

function amountInRange(profileAmount, opportunity) {
  if (!profileAmount) return true
  const amountStr = String(profileAmount).replace(/[$,]/g, '')
  const amountMatch = amountStr.match(/(\d+)/)
  if (!amountMatch) return true
  const requestedAmount = parseInt(amountMatch[1], 10)
  const minAmount = opportunity.amount_min || 0
  const maxAmount = opportunity.amount_max || Infinity
  if (!opportunity.amount_min && !opportunity.amount_max) return true
  return requestedAmount >= minAmount && requestedAmount <= maxAmount
}

function calculateDeadlineUrgency(opportunity) {
  if (!opportunity.deadline || opportunity.deadline_type === 'rolling' || opportunity.deadline_type === 'ongoing') {
    return 0
  }
  try {
    const deadline = new Date(opportunity.deadline)
    const now = new Date()
    const daysUntil = Math.floor((deadline - now) / (1000 * 60 * 60 * 24))
    if (daysUntil < 0) return -5
    if (daysUntil <= 30) return 5
    if (daysUntil <= 60) return 3
    if (daysUntil <= 90) return 1
    return 0
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// Facet adjustments
// ---------------------------------------------------------------------------

function calculateFacetAdjustments({ facets, opportunity, oppText }) {
  if (!facets || typeof facets !== 'object' || !opportunity || typeof opportunity !== 'object') {
    return { points: 0, reasons: [] }
  }

  const reasons = []
  let points = 0
  const oppCorpus = normalizeString(
    `${oppText || ''} ${(safeParseArrayField(opportunity?.keywords, []) || []).join(' ')} ${
      (safeParseArrayField(opportunity?.categories, []) || []).join(' ')
    } ${(safeParseArrayField(opportunity?.eligibility_bullets, []) || []).join(' ')}`,
  )

  const intentCategory = normalizeString(facets?.intent?.primary_need_category || '')
  const intentKeywords = tokenizeFacetTerms(facets?.intent?.keywords || [])
  const intentNegativeKeywords = tokenizeFacetTerms(facets?.intent?.negative_keywords || [])
  const applicantTypes = ensureArray(facets?.profile?.applicant_types).map((v) => normalizeString(v)).filter(Boolean)
  const primaryType = normalizeString(facets?.profile?.primary_profile_type || '')

  const categoryTokens = {
    business_startup: ['small business', 'startup', 'entrepreneur', 'sba', 'microenterprise', 'food truck'],
    education: ['student', 'scholarship', 'tuition', 'classroom', 'college', 'school', 'nclex', 'licensure'],
    disability_support: ['disability', 'special needs', 'assistive', 'accessible', 'autism', 'blind', 'deaf'],
    healthcare_support: ['healthcare', 'medical', 'patient', 'hospital', 'treatment', 'copay', 'rx', 'charity care', 'free clinic', 'sliding scale'],
    housing_stability: ['housing', 'rent', 'eviction', 'shelter', 'utility', 'homeless', 'tenant rights'],
    veteran_support: ['veteran', 'military', 'va', 'service member'],
    food_security: ['food assistance', 'nutrition', 'food bank', 'food pantry', 'meal'],
    transportation_access: ['transportation', 'vehicle', 'transit', 'bus pass', 'mobility'],
    legal_aid: ['legal aid', 'pro bono', 'legal clinic', 'eviction defense', 'attorney', 'court'],
    charity_care: ['charity care', 'patient assistance', 'free clinic', 'copay', 'sliding scale', 'financial assistance policy'],
    workforce_training: ['workforce', 'wioa', 'etpl', 'vocational', 'apprenticeship', 'job training', 'certification'],
    general_assistance: ['grant', 'assistance', 'support'],
  }
  const allCategoryKeys = Object.keys(categoryTokens)

  if (intentCategory && intentCategory !== 'unknown') {
    const tokens = categoryTokens[intentCategory] || []
    const sameCategoryHits = countTokenMatches(oppCorpus, tokens)
    if (sameCategoryHits > 0) {
      const boost = Math.min(9, 3 + sameCategoryHits)
      points += boost
      reasons.push(`Facet intent alignment: ${humanizeEnum(intentCategory)} (+${boost})`)
    } else {
      let strongestAlt = null
      let strongestAltHits = 0
      for (const key of allCategoryKeys) {
        if (key === intentCategory) continue
        const hits = countTokenMatches(oppCorpus, categoryTokens[key] || [])
        if (hits > strongestAltHits) {
          strongestAlt = key
          strongestAltHits = hits
        }
      }
      if (strongestAlt && strongestAltHits >= 2) {
        points -= 4
        reasons.push(
          `Facet intent mismatch (soft): profile=${humanizeEnum(intentCategory)}, opportunity≈${humanizeEnum(strongestAlt)} (-4)`,
        )
      }
    }
  }

  if (intentKeywords.length > 0) {
    const matches = intentKeywords.filter((kw) => textIncludesToken(oppCorpus, kw))
    if (matches.length > 0) {
      const boost = Math.min(12, matches.length * 2)
      points += boost
      reasons.push(`Facet keyword overlap (${matches.length}) (+${boost})`)
    } else if (intentKeywords.length >= 2) {
      points -= 3
      reasons.push('Facet keyword overlap missing (soft penalty -3)')
    }
  }

  if (intentNegativeKeywords.length > 0) {
    const blockedHits = intentNegativeKeywords.filter((kw) => textIncludesToken(oppCorpus, kw))
    if (blockedHits.length > 0) {
      const penalty = Math.min(18, blockedHits.length * 6)
      points -= penalty
      reasons.push(`Facet negative keyword conflict (${blockedHits.length}) (-${penalty})`)
    }
  }

  const hasStudentSignals =
    primaryType.includes('student') ||
    applicantTypes.some((t) => t.includes('student')) ||
    (facets?.education?.gpa !== null && facets?.education?.gpa !== undefined)
  if (hasStudentSignals && countTokenMatches(oppCorpus, ['student', 'scholarship', 'tuition', 'college']) > 0) {
    points += 5
    reasons.push('Facet profile alignment: student (+5)')
  } else if (hasStudentSignals && /not for students|non[-\s]?student/i.test(oppCorpus)) {
    points -= 5
    reasons.push('Facet profile mismatch (student exclusion signal) (-5)')
  }

  const hasBusinessSignals =
    primaryType.includes('business') ||
    applicantTypes.some((t) => t.includes('business')) ||
    facets?.occupation?.small_business_owner === true
  if (hasBusinessSignals && countTokenMatches(oppCorpus, ['small business', 'startup', 'entrepreneur', 'sba']) > 0) {
    points += 5
    reasons.push('Facet profile alignment: small business (+5)')
  }

  const hasVeteranSignals = facets?.military?.veteran === true || facets?.military?.disabled_veteran === true
  if (hasVeteranSignals && countTokenMatches(oppCorpus, ['veteran', 'military', 'va']) > 0) {
    points += 5
    reasons.push('Facet profile alignment: veteran (+5)')
  }

  const hasDisabilitySignals =
    (Array.isArray(facets?.health?.disability_types) && facets.health.disability_types.length > 0) ||
    facets?.health?.visual_impairment === true ||
    facets?.health?.hearing_impairment === true
  if (hasDisabilitySignals && countTokenMatches(oppCorpus, ['disability', 'special needs', 'accessible', 'assistive']) > 0) {
    points += 5
    reasons.push('Facet profile alignment: disability support (+5)')
  }

  const hasLowIncomeSignals =
    facets?.financial?.low_income === true ||
    facets?.assistance?.snap_recipient === true ||
    facets?.assistance?.tanf_recipient === true ||
    facets?.assistance?.section8_housing === true
  if (hasLowIncomeSignals && countTokenMatches(oppCorpus, ['low income', 'hardship', 'household', 'public assistance']) > 0) {
    points += 4
    reasons.push('Facet profile alignment: low-income assistance (+4)')
  }

  const bounded = Math.max(-35, Math.min(35, points))
  if (bounded !== points) reasons.push(`Facet adjustment capped (${points} -> ${bounded})`)

  if (String(process.env.MATCHING_ENGINE_FACET_DEBUG || '').toLowerCase() === 'true') {
    log.info('[matchEngine] facet adjustments', {
      title: opportunity?.title ?? null,
      points: bounded,
      reasons,
      intent_category: intentCategory || null,
    })
  }

  return { points: bounded, reasons }
}

// ---------------------------------------------------------------------------
// Profile depth — measures how much data the profile provides (0-100)
// ---------------------------------------------------------------------------

function measureProfileDepth(effectiveProfile, effectiveSignals, profileNorm) {
  let depth = 0
  const hasLocation = Boolean(
    effectiveSignals?.location?.state || effectiveSignals?.location?.zip ||
    effectiveProfile?.state || effectiveProfile?.zip_code,
  )
  const hasType = Boolean(resolveApplicantType(effectiveProfile))
  const hasNeeds = (safeParseArrayField(effectiveProfile?.needs, []).length > 0) ||
    (profileNorm?.needCategories?.length > 0)
  const hasKeywords = Boolean(effectiveSignals?.keywordSet?.size > 0)
  const hasDemographics = Boolean(effectiveSignals?.demographics?.size > 0) ||
    (profileNorm?.demographics?.length > 0)
  const hasAffiliations = (profileNorm?.affiliations?.length > 0)
  const hasFinancial = Boolean(effectiveSignals?.financial || effectiveProfile?.funding_amount_needed)
  const hasFlags = Boolean(
    profileNorm?.isVeteran || profileNorm?.isStudent || profileNorm?.isNonprofit ||
    profileNorm?.isBusiness || profileNorm?.isCaregiver || profileNorm?.hasDisabilityNeed,
  )

  if (hasLocation) depth += 18
  if (hasType) depth += 16
  if (hasNeeds) depth += 20
  if (hasKeywords) depth += 14
  if (hasDemographics) depth += 10
  if (hasAffiliations) depth += 8
  if (hasFinancial) depth += 7
  if (hasFlags) depth += 7
  return Math.min(100, depth)
}

// ---------------------------------------------------------------------------
// Component scorers — each returns 0-100 on its own subscale
// ---------------------------------------------------------------------------

/**
 * Merge declared needs from profile columns, normalized facets, and
 * buildProfileSignals() output. Most real profiles store needs only in
 * sections/tags/narrative — not on profiles.needs — so ignoring signals
 * under-scores well-filled profiles (Goal #3).
 */
function collectProfileNeeds(effectiveProfile, effectiveSignals, profileNorm) {
  const fromProfile = safeParseArrayField(effectiveProfile?.needs, [])
  const fromNorm = safeParseArrayField(profileNorm?.needCategories, [])
  const fromSignals =
    effectiveSignals?.needs instanceof Set
      ? Array.from(effectiveSignals.needs)
      : safeParseArrayField(effectiveSignals?.needs, [])
  const merged = [...fromProfile, ...fromNorm, ...fromSignals]
    .map((n) => String(n).toLowerCase().trim())
    .filter(Boolean)
  return [...new Set(merged)]
}

function countNeedSynonymHits(rawNeeds, oppText, allOppSignals) {
  let hits = 0
  for (const need of rawNeeds) {
    const synonyms = NEED_SYNONYMS[need] || [need]
    const matched =
      synonyms.some((syn) => oppText.includes(syn)) ||
      allOppSignals.some((signal) => synonyms.some((syn) => signal.includes(syn) || syn.includes(signal)))
    if (matched) hits++
  }
  return hits
}

/**
 * Geographic relevance (0-100 subscale).
 * Missing profile location → 35 (neutral baseline, not penalty).
 * State mismatch → 10 (reduced, never zero).
 */
function scoreGeoComponent(effectiveProfile, effectiveSignals, opportunity) {
  // Multi-location aware: prefer the resolved `locations[]` (each {zip,state,city,county})
  // so an out-of-state student (home + school) is matched in-state for BOTH addresses.
  // STRICTLY ADDITIVE: a single-address profile yields exactly one location, so the
  // chosen primary fields and the state comparison are identical to before.
  const profileLocation = effectiveSignals?.location || {}
  const allLocations = Array.isArray(effectiveSignals?.locations) && effectiveSignals.locations.length
    ? effectiveSignals.locations
    : [profileLocation]
  // Primary (back-compat) fields drive county/city tiers; never weakened by extra addresses.
  const profileZip = profileLocation?.zip ?? effectiveProfile?.postal_code ?? effectiveProfile?.zip_code ?? null
  const profileCounty = profileLocation?.county ?? null
  const profileCity = profileLocation?.city ?? effectiveProfile?.city ?? null
  const profileState = profileLocation?.state ?? effectiveProfile?.state ?? null

  // ALL of the profile's states (primary-first, deduped). Single-address → one entry.
  const profileStateList = profileStates(effectiveSignals, profileState)
  // ZIPs across every address — used so a secondary-address ZIP can still match locally.
  const profileZips = []
  for (const loc of allLocations) {
    const z = loc?.zip ?? null
    if (z && !profileZips.includes(String(z).trim())) profileZips.push(String(z).trim())
  }
  if (profileZip && !profileZips.includes(String(profileZip).trim())) {
    profileZips.unshift(String(profileZip).trim())
  }

  const oppState = opportunity?.state ?? opportunity?.stateRestriction ?? null
  const oppZip = opportunity?.geo_zip ?? null
  const oppCounty = opportunity?.geo_county ?? null
  const oppIsNational =
    Boolean(opportunity?.is_national) ||
    String(oppState || '').toLowerCase() === 'nationwide'

  // In-state if the opportunity's state matches ANY of the profile's states.
  // For a single-address profile this is identical to the old singular check.
  const oNorm = normalizeState(oppState)
  const stateMatchesAny = Boolean(oNorm) && profileStateList.includes(oNorm)
  const stateMismatchAll = Boolean(oNorm) && profileStateList.length > 0 && !stateMatchesAny

  // Closest ZIP across all addresses (exact wins; otherwise smallest haversine).
  // Single-address profiles short-circuit to exactly the primary-ZIP result.
  let bestZipExact = false
  let bestZipDist = null
  if (oppZip) {
    const oz = String(oppZip).trim()
    for (const pz of profileZips) {
      if (pz === oz) { bestZipExact = true; break }
      const d = _zipDistanceMiles(pz, oz)
      if (d !== null && (bestZipDist === null || d < bestZipDist)) bestZipDist = d
    }
  }
  const haveAnyZip = profileZips.length > 0

  let tier = 'none'
  let subscale = 35

  if (!profileZip && !profileCounty && !profileCity && !profileState && profileStateList.length === 0 && !haveAnyZip) {
    tier = 'unknown'
    subscale = 35
  } else if (oppZip && bestZipExact) {
    tier = 'zip'
    subscale = 100
  } else if (oppZip && haveAnyZip) {
    // Distance-aware proximity scoring for non-exact ZIP matches (closest address).
    //   ≤ 25mi → 95-85 (local), ≤ 50mi → 84-75 (expanded), > 50mi → falls through
    const dist = bestZipDist
    if (dist !== null && dist <= 25) {
      tier = 'nearby_local'
      subscale = Math.round(95 - (dist / 25) * 10)
    } else if (dist !== null && dist <= 50) {
      tier = 'nearby_expanded'
      subscale = Math.round(84 - ((dist - 25) / 25) * 9)
    } else if (profileCounty && oppCounty && normalizeCounty(oppCounty) === normalizeCounty(profileCounty)) {
      tier = 'county'
      subscale = 92
    } else if (
      profileCity && typeof profileCity === 'string' &&
      typeof opportunity?.description === 'string' &&
      normalizeString(opportunity.description).includes(normalizeString(profileCity))
    ) {
      tier = 'city'
      subscale = 85
    } else if (stateMatchesAny) {
      tier = 'state'
      subscale = 75
    } else if (oppIsNational) {
      tier = 'national'
      // National opportunities are fully geographically eligible for ANY profile
      // (canonical rule G4: matching expands city→county→state→national; national
      // must surface). 55 sat BELOW the state tier (75), unfairly capping the many
      // federal grants that are national-by-design so the 80% slider never reached
      // them. 70 keeps national below local tiers (preserving local preference)
      // while letting a strong national match clear a high bar.
      subscale = 70
    } else if (stateMismatchAll) {
      tier = 'mismatch'
      subscale = 10
    } else {
      tier = 'soft_mismatch'
      subscale = 30
    }
  } else if (profileCounty && oppCounty && normalizeCounty(oppCounty) === normalizeCounty(profileCounty)) {
    tier = 'county'
    subscale = 92
  } else if (
    profileCity && typeof profileCity === 'string' &&
    typeof opportunity?.description === 'string' &&
    normalizeString(opportunity.description).includes(normalizeString(profileCity))
  ) {
    tier = 'city'
    subscale = 85
  } else if (stateMatchesAny) {
    tier = 'state'
    subscale = 75
  } else if (oppIsNational) {
    tier = 'national'
    subscale = 55
  } else if (stateMismatchAll) {
    tier = 'mismatch'
    subscale = 10
  } else {
    tier = 'soft_mismatch'
    subscale = 30
  }

  // State-name-in-title mismatch: reduce but don't zero out.
  // Only fires when the title names a state that is NOT any of the profile's
  // states — so a secondary-state program is never penalized as a "title mismatch".
  if (profileStateList.length > 0 && !oppIsNational && tier !== 'mismatch') {
    const titleStateAbbr = _extractStateNameFromTitle(opportunity?.title || '')
    if (titleStateAbbr && !profileStateList.includes(titleStateAbbr.toUpperCase())) {
      subscale = Math.max(10, Math.round(subscale * 0.35))
      tier = 'title_state_mismatch'
    }
  }

  return { subscale, tier, profileState, oppIsNational }
}

// ── ZIP distance helper (cached) ──
const _zipDistCache = new Map()
function _zipDistanceMiles(zip1, zip2) {
  const key = `${zip1}:${zip2}`
  if (_zipDistCache.has(key)) return _zipDistCache.get(key)
  try {
    const a = zipcodes.lookup(String(zip1).trim())
    const b = zipcodes.lookup(String(zip2).trim())
    if (!a || !b) return null
    const lat1 = parseFloat(a.latitude)
    const lon1 = parseFloat(a.longitude)
    const lat2 = parseFloat(b.latitude)
    const lon2 = parseFloat(b.longitude)
    if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) return null
    const dist = haversineDistanceMiles(lat1, lon1, lat2, lon2)
    _zipDistCache.set(key, dist)
    return dist
  } catch {
    return null
  }
}

/**
 * Need alignment component (0-100 subscale).
 * Uses keyword overlap, intent phrases, NEED_SYNONYMS, and category matching.
 * Missing needs → baseline from profile depth. Never returns 0 for partial data.
 */
function scoreNeedComponent(effectiveProfile, effectiveSignals, effectiveFacets, opportunity, profileNorm) {
  const oppText = `${opportunity?.title || ''} ${opportunity?.description || ''} ${opportunity?.sponsor || ''}`.toLowerCase()
  const reasons = []
  let subscale = 0

  // 1. Need-synonym matching (0-45 of subscale)
  const rawNeeds = collectProfileNeeds(effectiveProfile, effectiveSignals, profileNorm)
  const oppKws = safeParseArrayField(opportunity?.keywords, [])
  const oppCats = safeParseArrayField(opportunity?.categories, [])
  const allOppSignals = [...oppKws, ...oppCats].map((t) => String(t).toLowerCase())
  let needHits = 0
  let needTotal = rawNeeds.length

  if (rawNeeds.length > 0) {
    for (const n of rawNeeds) {
      const nLower = String(n).toLowerCase()
      const synonyms = NEED_SYNONYMS[nLower] || [nLower]
      const matched =
        allOppSignals.some((s) => synonyms.some((syn) => s.includes(syn) || syn.includes(s))) ||
        synonyms.some((syn) => oppText.includes(syn))
      if (matched) needHits++
    }
    if (needHits > 0) {
      // Reward matching the profile's needs WITHOUT diluting by how MANY needs
      // the profile lists. Dividing by the full needTotal meant a complete
      // profile (e.g. Robert White's 13 needs) capped every grant low — a grant
      // matching 7/13 strong needs only earned 54% of the need slice, so the
      // 80% slider returned nothing. A funder realistically addresses a few of a
      // person's needs; matching ~4 strongly is full need-alignment credit.
      // (Canonical rule G4: profile attributes INCREASE score; recall over
      // precision. Differentiation between equally-need-matching grants comes
      // from the keyword/interest/category components, not from punishing rich
      // profiles.)
      const needDenom = Math.max(1, Math.min(needTotal, NEED_FULL_CREDIT_HITS))
      const needPct = Math.min(1, needHits / needDenom)
      subscale += Math.round(needPct * 45)
      reasons.push(`Need alignment: ${needHits}/${needTotal}`)
    }
  } else {
    // No explicit needs — give partial credit based on profile flags
    const hasLoc = Boolean(profileNorm?.state || profileNorm?.zip)
    const hasEntity = Boolean(profileNorm?.entityType)
    subscale += (hasLoc ? 8 : 0) + (hasEntity ? 8 : 0)
    if (subscale > 0) reasons.push('Inferred need baseline')
  }

  // 2. Keyword overlap (0-30 of subscale)
  const keywordRaw = calculateKeywordOverlap(effectiveSignals ?? effectiveProfile, opportunity)
  const keywordNorm = Math.round(((Math.max(0, keywordRaw) / 25) * 30))
  subscale += keywordNorm
  if (keywordRaw > 0) reasons.push(`Keyword: ${keywordRaw} raw`)

  // 3. Facet intent alignment (0-15 of subscale)
  const facetAdj = calculateFacetAdjustments({ facets: effectiveFacets, opportunity, oppText })
  const facetNorm = Math.round(Math.max(0, (facetAdj.points + 35) / 70 * 15))
  subscale += facetNorm
  if (facetAdj.points !== 0) reasons.push(`Facet: ${facetAdj.points}`)

  // 4. Intent match from opportunity.intentMatch (0-10 of subscale)
  if (Array.isArray(opportunity?.intentMatch) && opportunity.intentMatch.length > 0) {
    const profileKeywords = effectiveSignals?.keywordSet instanceof Set
      ? effectiveSignals.keywordSet
      : new Set(Array.isArray(effectiveSignals?.keywords) ? effectiveSignals.keywords.map(k => String(k).toLowerCase()) : [])
    const intentOverlap = opportunity.intentMatch.filter(intent =>
      profileKeywords.has(String(intent).toLowerCase()),
    )
    if (intentOverlap.length > 0) {
      subscale += Math.min(10, intentOverlap.length * 4)
      reasons.push(`Intent: ${intentOverlap.join(', ')}`)
    }
  }

  // 5. Pro bono / service need alignment (0-12 of subscale)
  // When profile has proBonoTerms (inferred from needs), boost need score
  // if the opportunity text matches those terms.
  const proBonoTerms = effectiveSignals?.proBonoTerms ?? new Set()
  if (proBonoTerms.size > 0) {
    let proBonoHits = 0
    for (const term of proBonoTerms) {
      if (oppText.includes(normalizeString(term))) proBonoHits++
    }
    if (proBonoHits > 0) {
      subscale += Math.min(12, proBonoHits * 4)
      reasons.push(`Pro bono need match: ${proBonoHits}`)
    }
  }

  return { subscale: Math.min(100, Math.max(0, subscale)), reasons, facetDetail: facetAdj, keywordRaw }
}

/**
 * Population/mission alignment applied as integer post-weight boosts.
 * These signals are +2 on the eligibility subscale (× W_ELIGIBILITY 0.25 =
 * +0.5 raw), which Math.round can erase — breaking the directional contract
 * in matcherSectionCoverage and hiding nonprofit set-aside signals in the UI.
 */
function computePopulationMissionPostBoost(profileNorm, oppText) {
  const organizationProfile = profileNorm?.organization || {}
  const hits = []
  let boost = 0

  for (const pop of Array.isArray(organizationProfile.populationServed)
    ? organizationProfile.populationServed
    : []) {
    const token = String(pop).toLowerCase().trim()
    if (token.length >= 3 && oppText.includes(token)) {
      boost += 2
      hits.push(`Population alignment (+2: ${pop})`)
    }
  }

  for (const focus of Array.isArray(organizationProfile.missionFocus)
    ? organizationProfile.missionFocus
    : []) {
    const token = String(focus).toLowerCase().trim()
    if (token.length >= 3 && oppText.includes(token)) {
      boost += 2
      hits.push(`Mission alignment (+2: ${focus})`)
    }
  }

  return { boost: Math.min(8, boost), hits }
}

/**
 * Eligibility match component (0-100 subscale).
 * Checks applicant type match, demographic alignment, requirements compatibility.
 * Missing type → 45 baseline (neutral). Penalties are proportional, never zero.
 */
function scoreEligibilityComponent(effectiveProfile, effectiveSignals, effectiveFacets, opportunity, profileNorm) {
  const oppText = `${opportunity?.title || ''} ${opportunity?.description || ''} ${opportunity?.sponsor || ''}`.toLowerCase()
  const reasons = []
  // Baseline 45 preserves the "missing → neutral" rule. The spec proposed
  // dropping this to 35, but combined with the new soft penalty it
  // collapses directional sensitivity (per-section coverage tests rely on
  // a +4 demoBonus being visible in the final score).
  let subscale = 45

  const applicantTypesSet =
    effectiveSignals?.applicantTypes && typeof effectiveSignals.applicantTypes[Symbol.iterator] === 'function'
      ? new Set(Array.from(effectiveSignals.applicantTypes).map((v) => String(v).toLowerCase()))
      : null
  const profileType = resolveApplicantType(effectiveProfile)
  const hasApplicantTypeSignals = Boolean(profileType) || Boolean(applicantTypesSet?.size)
  const profileTypeNorm = normalizeString(profileType || '')

  // Applicant type match (+35)
  if (hasApplicantTypeSignals && eligibilityMatchesApplicantType(opportunity, effectiveSignals ?? effectiveProfile)) {
    subscale += 35
    reasons.push('Applicant type match')
  } else if (!hasApplicantTypeSignals) {
    reasons.push('Type unknown (neutral)')
  } else {
    // The profile declares an applicant type but the opportunity does not
    // confirm it. Distinguish "opp explicitly targets a *different* type"
    // (real soft mismatch, -25) from "opp is silent on applicant type"
    // (no signal, neutral). A silent opp is effectively open to any
    // applicant — penalising it would suppress legitimate matches like a
    // small_business profile against a "general-purpose funding" opp.
    const oppMentionsApplicantType =
      /\b(individual|person|resident|household|family|low[- ]income|adult|senior|nonprofit|non[- ]profit|501\(c\)|charity|charitable|small business|enterprise|micro[- ]enterprise|startup|entrepreneur|sba|smb|student|undergraduate|graduate|college|university|veteran|service member|active duty|military|tribal|indigenous|government|municipal|public sector|institution|institutional|research)\b/i.test(oppText)
    if (oppMentionsApplicantType) {
      subscale -= 25
      reasons.push('Type mismatch (soft)')
    } else {
      reasons.push('Opp silent on applicant type (neutral)')
    }
  }

  // Cross-category penalties — proportional, capped
  const isStudentType = ['student', 'high_school_student', 'college_student'].includes(profileTypeNorm)
  const isBusinessType = ['small_business'].includes(profileTypeNorm)
  const isOrgType = ['organization', 'nonprofit'].includes(profileTypeNorm)
  const isIndividualFamilyType = ['individual', 'individual_need', 'family', 'medical_assistance'].includes(profileTypeNorm)

  if (!isStudentType && RE_UNIVERSITY_PROGRAM.test(oppText)) {
    subscale -= 25
    reasons.push('University program penalty')
  }

  const isDisasterProfile =
    (Array.isArray(effectiveProfile?.tags) && effectiveProfile.tags.some((t) => RE_DISASTER_SIGNAL.test(String(t)))) ||
    profileTypeNorm === 'disaster_survivor'
  const hasDisasterSignal =
    isDisasterProfile ||
    (Array.isArray(effectiveFacets?.tags) && effectiveFacets.tags.some((t) => RE_DISASTER_SIGNAL.test(String(t)))) ||
    (Array.isArray(effectiveSignals?.tags) && effectiveSignals.tags.some((t) => RE_DISASTER_SIGNAL.test(String(t)))) ||
    (effectiveProfile?.primary_type || '').toLowerCase() === 'disaster_survivor'

  if (!hasDisasterSignal && RE_FEMA_DISASTER.test(oppText)) {
    subscale -= 25
    reasons.push('FEMA/disaster penalty')
  } else if (!isDisasterProfile && hasDisasterSignal && RE_FEMA_DISASTER_STRICT.test(oppText)) {
    subscale -= 18
    reasons.push('FEMA/disaster penalty (partial)')
  }

  const hasVetFacet = effectiveFacets?.military?.veteran === true || effectiveFacets?.military?.disabled_veteran === true
  if (!hasVetFacet && RE_VETERAN_SPECIFIC.test(oppText)) {
    subscale -= 12
    reasons.push('Veteran program penalty')
  }

  if (!isBusinessType && !isOrgType && RE_BUSINESS_SBA.test(oppText)) {
    subscale -= 12
    reasons.push('Business/SBA penalty')
  }

  if (isIndividualFamilyType && RE_NONPROFIT_ONLY.test(oppText)) {
    subscale -= 10
    reasons.push('Nonprofit-only penalty')
  }

  // Demographic/affiliation alignment bonus (+0-15)
  const profDemographics = profileNorm?.demographics ?? []
  const profAffiliations = profileNorm?.affiliations ?? []
  const profGeoQualifiers = profileNorm?.geographicQualifiers ?? []
  let demoBonus = 0

  if (profDemographics.length > 0 || profAffiliations.length > 0 || profGeoQualifiers.length > 0) {
    const demoTokens = {
      african_american: ['african american', 'black', 'minority'],
      hispanic_latino: ['hispanic', 'latino', 'latina', 'latinx'],
      native_american: ['native american', 'indigenous', 'tribal'],
      first_generation: ['first generation', 'first gen'],
      lgbtq: ['lgbtq', 'queer', 'pride'],
      senior: ['senior', 'elderly', 'aging', 'older adult'],
      youth: ['youth', 'young'], young_adult: ['young adult'],
      immigrant: ['immigrant', 'refugee', 'new american'],
      tribal_affiliation: ['tribal', 'indigenous', 'native'],
    }
    for (const trait of profDemographics) {
      const tokens = demoTokens[trait] || [trait.replace(/_/g, ' ')]
      if (tokens.some((t) => oppText.includes(t))) demoBonus += 4
    }
    const affilTokens = {
      church: ['church', 'faith', 'congregation', 'ministry', 'religious'],
      faith_based: ['faith-based', 'faith based'],
      school: ['school', 'education', 'k-12', 'k12'],
      first_responder: ['fire department', 'ems', 'first responder', 'rescue'],
      tribal: ['tribal', 'indigenous', 'native'],
      veteran: ['veteran', 'military', 'va '],
    }
    for (const affil of profAffiliations) {
      const tokens = affilTokens[affil] || [affil.replace(/_/g, ' ')]
      if (tokens.some((t) => oppText.includes(t))) demoBonus += 4
    }
    const geoTokens = {
      rural: ['rural'], appalachian: ['appalachian', 'appalachia'],
      tribal: ['tribal'], urban_underserved: ['urban', 'underserved'],
      frontier: ['frontier', 'remote'],
    }
    for (const gq of profGeoQualifiers) {
      const tokens = geoTokens[gq] || [gq.replace(/_/g, ' ')]
      if (tokens.some((t) => oppText.includes(t))) demoBonus += 3
    }
    demoBonus = Math.min(15, demoBonus)
  }

  // Heritage / ethnicity / religion INCLUSION boost (+0..10, folded into the
  // +0..15 demoBonus cap).
  //
  // The owner directive: a profile attribute that an opportunity TARGETS must
  // RAISE the score (a Catholic profile scores higher on Catholic scholarships;
  // a Russian-heritage profile higher on Russian-heritage scholarships). The
  // discrete demographics[] tokens above only cover a fixed enum; this surfaces
  // the FREE-TEXT ethnicity/heritage string and the religion signal, which were
  // previously collected but never boosted. Kept additive, bounded, and folded
  // into the same demoBonus cap below so existing weights are not destabilized.
  {
    let identityBonus = 0
    // Free-text heritage / ethnicity (e.g. "russian", "irish", "korean").
    const ethnicityRaw = String(profileNorm?.ethnicity || '').toLowerCase().trim()
    if (ethnicityRaw && ethnicityRaw.length >= 4 && oppText.includes(ethnicityRaw)) {
      identityBonus += 5
      reasons.push(`Heritage/ethnicity match (${ethnicityRaw}) (+5)`)
    }
    // Religion / faith: when the profile carries a faith indicator AND the
    // opportunity text explicitly names a faith/denomination/scholarship, give a
    // small, bounded boost so faith-targeted funding ranks higher for faithful
    // profiles. This never excludes — it only lifts an explicit match.
    if (profileNorm?.hasFaithIndicator === true &&
        /\b(catholic|christian|jewish|muslim|islamic|hindu|buddhist|faith[- ]based|religious|denomination|ministry|congregation|parish|diocese)\b/.test(oppText)) {
      identityBonus += 5
      reasons.push('Faith/religion alignment (+5)')
    }
    if (identityBonus > 0) {
      demoBonus = Math.min(15, demoBonus + identityBonus)
    }
  }

  {
    // Re-apply the cap and surface the (possibly heritage-augmented) bonus.
    subscale += demoBonus
    if (demoBonus > 0) reasons.push(`Demo/affil +${demoBonus}`)
  }

  // Ownership / certification / business-profile alignment bonus (+0..18).
  //
  // These signals are what actually qualify a profile for specific set-aside
  // and ownership-designated grants. Keep this as a soft *boost* so sparse
  // profiles still match general-purpose opportunities without being gated
  // out.
  const ownership = profileNorm?.ownership || {}
  const businessProfile = profileNorm?.business || {}
  let ownershipBonus = 0
  const ownershipHits = []

  const ownershipTokens = [
    { flag: ownership.isVeteranOwned, tokens: ['veteran-owned', 'veteran owned', 'vosb', 'sdvosb', 'service-disabled veteran'], label: 'veteran-owned' },
    { flag: ownership.isWomanOwned, tokens: ['woman-owned', 'women-owned', 'women owned', 'wbe', 'wosb'], label: 'woman-owned' },
    { flag: ownership.isMinorityOwned, tokens: ['minority-owned', 'minority owned', 'mbe', 'disadvantaged business', '8(a)', ' 8a '], label: 'minority-owned' },
    { flag: ownership.is8aCertified, tokens: ['8(a)', ' 8a ', 'sba 8(a)'], label: '8(a)' },
    { flag: ownership.isHUBZoneCertified, tokens: ['hubzone', 'hub zone', 'historically underutilized'], label: 'HUBZone' },
    { flag: ownership.isCDFI, tokens: ['cdfi', 'community development financial'], label: 'CDFI' },
    { flag: ownership.isHBCU, tokens: ['hbcu', 'minority-serving institution', 'msi'], label: 'HBCU/MSI' },
    { flag: ownership.isTribalGovernment, tokens: ['tribal', 'indian tribe', 'federally recognized'], label: 'tribal' },
    { flag: ownership.isHousingAuthority, tokens: ['housing authority', 'public housing', 'pha'], label: 'housing authority' },
    { flag: ownership.isCommunityActionAgency, tokens: ['community action', 'csbg', 'caa '], label: 'CAA' },
    { flag: ownership.isCooperative, tokens: ['cooperative', 'co-op', 'co op'], label: 'cooperative' },
    { flag: ownership.isRuralServing, tokens: ['rural', 'rural-serving'], label: 'rural-serving' },
    { flag: ownership.isMinorityServing, tokens: ['minority-serving', 'minority serving'], label: 'minority-serving' },
  ]
  for (const { flag, tokens, label } of ownershipTokens) {
    if (!flag) continue
    if (tokens.some((t) => oppText.includes(t))) {
      ownershipBonus += 5
      ownershipHits.push(label)
    }
  }

  // Business maturity / industry soft matching
  if (businessProfile.isStartup && /(startup|early[- ]stage|seed|pre[- ]seed|emerging)/i.test(oppText)) {
    ownershipBonus += 3
    ownershipHits.push('startup')
  }
  if (businessProfile.isMicroEnterprise && /(microenterprise|micro-enterprise|micro business|microloan)/i.test(oppText)) {
    ownershipBonus += 3
    ownershipHits.push('micro-enterprise')
  }
  if (businessProfile.industry && typeof businessProfile.industry === 'string') {
    const ind = businessProfile.industry.toLowerCase()
    if (ind.length >= 3 && oppText.includes(ind)) {
      ownershipBonus += 3
      ownershipHits.push(`industry:${ind}`)
    }
  }
  if (businessProfile.naicsCode && typeof businessProfile.naicsCode === 'string') {
    if (oppText.includes(businessProfile.naicsCode)) {
      ownershipBonus += 4
      ownershipHits.push(`NAICS:${businessProfile.naicsCode}`)
    }
  }

  // Population served / mission focus alignment — scored post-weight (see
  // computePopulationMissionPostBoost) so +2 signals are never lost to rounding.

  ownershipBonus = Math.min(18, ownershipBonus)
  if (ownershipBonus > 0) {
    subscale += ownershipBonus
    reasons.push(`Ownership/mission +${ownershipBonus} (${ownershipHits.slice(0, 4).join(', ')})`)
  }

  // Organization type / capacity-fit alignment (+0..12).
  //
  // Closes the domain-audit gap where `organization_type`, `employee_count`,
  // `annual_revenue`, and `years_in_operation` were collected on the profile
  // but never surfaced in match scoring. These are *soft* bonuses — never
  // exclusions — so a sparse profile still matches general-purpose funding.
  let capacityBonus = 0
  const capacityHits = []

  const orgTypeRaw = String(profileNorm?.organizationType || '').toLowerCase().trim()
  if (orgTypeRaw && orgTypeRaw.length >= 3) {
    const tokens = orgTypeRaw.split(/[\s_/-]+/).filter((t) => t.length >= 3)
    if (tokens.some((t) => oppText.includes(t))) {
      capacityBonus += 4
      capacityHits.push(`org-type:${orgTypeRaw}`)
    } else if (orgTypeRaw.includes('nonprofit') && /\bnonprofit|\b501\(?c\)?3\b/i.test(oppText)) {
      capacityBonus += 4
      capacityHits.push('org-type:nonprofit')
    } else if (orgTypeRaw.includes('church') && /(church|faith|ministry|religious)/i.test(oppText)) {
      capacityBonus += 4
      capacityHits.push('org-type:faith')
    } else if (/business|llc|corp|sole/.test(orgTypeRaw) && /small business|smb|entrepreneur/i.test(oppText)) {
      capacityBonus += 3
      capacityHits.push('org-type:business')
    }
  }

  const empCount = Number.isFinite(profileNorm?.employeeCount) ? profileNorm.employeeCount : null
  if (empCount !== null) {
    const smallBusinessOpp = /small business|fewer than|under\s+\d+\s+employees|microenterprise|sole proprietor/i.test(
      oppText
    )
    if (smallBusinessOpp && empCount > 0 && empCount <= 500) {
      capacityBonus += 3
      capacityHits.push(`employees:${empCount}`)
    } else if (empCount === 0 && /(sole proprietor|solopreneur|individual)/i.test(oppText)) {
      capacityBonus += 2
      capacityHits.push('solopreneur')
    }
  }

  const annualRev = Number.isFinite(profileNorm?.annualRevenue) ? profileNorm.annualRevenue : null
  if (annualRev !== null) {
    if (annualRev < 500000 && /(microenterprise|micro[- ]business|startup|early[- ]stage|emerging|under\s*\$?\d+[km])/i.test(oppText)) {
      capacityBonus += 3
      capacityHits.push('revenue:small')
    } else if (annualRev >= 500000 && /(growth[- ]stage|scale[- ]up|established|expansion)/i.test(oppText)) {
      capacityBonus += 2
      capacityHits.push('revenue:growth')
    }
  }

  const yearsOp = Number.isFinite(profileNorm?.yearsInOperation) ? profileNorm.yearsInOperation : null
  if (yearsOp !== null) {
    if (yearsOp < 3 && /(startup|early[- ]stage|pre[- ]seed|seed|new business|emerging)/i.test(oppText)) {
      capacityBonus += 2
      capacityHits.push(`years:${yearsOp}`)
    } else if (yearsOp >= 3 && yearsOp < 10 && /(established|growth[- ]stage|expansion)/i.test(oppText)) {
      capacityBonus += 2
      capacityHits.push(`years:${yearsOp}`)
    } else if (yearsOp >= 10 && /(legacy|mature|long[- ]established|anniversary)/i.test(oppText)) {
      capacityBonus += 1
      capacityHits.push(`years:${yearsOp}`)
    }
  }

  // Country: when an explicit country is set on the profile and the
  // opportunity description mentions it, give a small relevance bump.
  // Geographic eligibility gating already lives in geography scoring;
  // this is purely the "did the profile's country signal contribute?"
  // surface for explainability.
  const profileCountry = String(profileNorm?.country || '').toLowerCase().trim()
  if (profileCountry && profileCountry.length >= 2 && oppText.includes(profileCountry)) {
    capacityBonus += 1
    capacityHits.push(`country:${profileCountry}`)
  }

  capacityBonus = Math.min(12, capacityBonus)
  if (capacityBonus > 0) {
    subscale += capacityBonus
    reasons.push(`Capacity/org-type +${capacityBonus} (${capacityHits.slice(0, 4).join(', ')})`)
  }

  // Requirements penalties (proportional)
  const opportunityType = String(opportunity?.opportunity_type || opportunity?.type || '').toLowerCase()
  if (['loan', 'loan_program', 'microloan'].includes(opportunityType) || /\bloan\b/.test(oppText)) {
    subscale -= 20
    reasons.push('Loan penalty')
  }
  if (/\bcredit repair\b|\bcredit counseling\b|\bdebt consolidation\b/.test(oppText)) {
    subscale -= 18
    reasons.push('Credit repair penalty')
  }

  const ein = effectiveProfile?.ein ?? effectiveProfile?.uei ?? null
  const isOrgLike = applicantTypeSetHas(applicantTypesSet, ['organization', 'nonprofit', 'small_business', 'government']) ||
    ['organization', 'nonprofit', 'small_business', 'government'].includes(profileTypeNorm)
  if (opportunity?.requires_501c3 && isOrgLike && !ein) {
    subscale -= 10
    reasons.push('501c3 missing')
  }
  if (opportunity?.requires_match) {
    subscale -= 8
    reasons.push('Matching funds required')
  }

  // Pro bono / in-kind scoring
  const isProBono = PRO_BONO_OPPORTUNITY_TYPES.has(opportunityType)
  const fundingType = normalizeString(opportunity?.funding_type || '')
  const isServiceType = SERVICE_FUNDING_TYPES.has(fundingType)
  if (isProBono || isServiceType) {
    if (
      (opportunity?.amount_min === null || opportunity?.amount_min === undefined) &&
      (opportunity?.amount_max === null || opportunity?.amount_max === undefined)
    ) {
      subscale += 5
    }
    const appUrl = normalizeString(opportunity?.application_url || '')
    const srcUrl = normalizeString(opportunity?.source_url || '')
    const hasDirectIntake = /apply|intake|enroll|request|sign.?up|register/i.test(appUrl) || /apply|intake|enroll/i.test(srcUrl)
    if (hasDirectIntake) subscale += 5
  }

  // Amount in range bonus
  if (amountInRange(effectiveProfile?.funding_amount_needed, opportunity)) {
    subscale += 8
    reasons.push('Amount eligible')
  }

  return {
    subscale: Math.min(100, Math.max(5, subscale)),
    reasons,
    applicantTypeMatch: hasApplicantTypeSignals && eligibilityMatchesApplicantType(opportunity, effectiveSignals ?? effectiveProfile),
    hasApplicantTypeSignals,
    profileTypeNorm,
    demoBonus,
  }
}

/**
 * Category relevance (0-100 subscale).
 * Empty categories → 30 baseline (neutral, preserves signal directionality).
 */
function scoreCategoryComponent(effectiveProfile, effectiveSignals, opportunity) {
  const reasons = []
  const categoryRaw = calculateCategoryMatch(effectiveSignals ?? effectiveProfile, opportunity)
  // Baseline 30 preserves directional sensitivity for per-section
  // coverage tests. Generic-row tightening comes from the empty-need-opp
  // ceiling drop in calculateNeedAlignment + strict threshold enforcement,
  // not from collapsing every category baseline.
  let subscale = 30

  if (categoryRaw > 0) {
    subscale = 20 + Math.round((categoryRaw / 20) * 65)
    reasons.push(`Category: ${categoryRaw} raw`)
  }

  // Deadline urgency bonus (+0-8)
  const deadlineScore = calculateDeadlineUrgency(opportunity)
  if (deadlineScore > 0) {
    subscale += Math.round(deadlineScore * 1.6)
    reasons.push(`Deadline urgency +${deadlineScore}`)
  } else if (deadlineScore < 0) {
    subscale -= 5
    reasons.push('Expired deadline')
  }

  return { subscale: Math.min(100, Math.max(5, subscale)), reasons, categoryRaw, deadlineScore }
}

// ---------------------------------------------------------------------------
// scoreOpportunity — weighted component scoring (v4)
// ---------------------------------------------------------------------------

/**
 * Score a single opportunity against a profile using a weighted component model.
 *
 * @param {Object} profile      - Raw profile OR profileContext { profile, sections, signals, facets }
 * @param {Object} opportunity  - Raw opportunity object
 * @returns {{ score: number, reasons: string[], match_explain: object }}
 */
export function scoreOpportunity(profile, opportunity, opts = {}) {
  const profileContext =
    profile && typeof profile === 'object' && profile.profile && (profile.sections || profile.signals)
      ? profile
      : null
  const effectiveProfile = profileContext?.profile ?? profile
  const effectiveSignals =
    profileContext?.signals ??
    (profileContext?.sections
      ? buildProfileSignals({ profile: effectiveProfile, sections: profileContext.sections })
      : null)
  const effectiveFacets = profileContext?.facets ?? null

  if (profileContext && !profileContext.profileNorm && profileContext.sections) {
    profileContext.profileNorm = normalizeProfile(effectiveProfile, profileContext.sections, effectiveSignals)
  }
  const profileNorm = profileContext?.profileNorm ?? null

  const reasons = []
  const oppText = `${opportunity?.title || ''} ${opportunity?.description || ''} ${opportunity?.sponsor || ''}`.toLowerCase()

  // ── Score each component (0-100 subscale) ──
  const geo = scoreGeoComponent(effectiveProfile, effectiveSignals, opportunity)
  const need = scoreNeedComponent(effectiveProfile, effectiveSignals, effectiveFacets, opportunity, profileNorm)
  const elig = scoreEligibilityComponent(effectiveProfile, effectiveSignals, effectiveFacets, opportunity, profileNorm)
  const cat = scoreCategoryComponent(effectiveProfile, effectiveSignals, opportunity)

  // ── Weighted combination ──
  // Keep `rawScore` as a float through the depth multiplier; rounding the
  // intermediate value washes out small ownership / mission / population
  // bonuses (e.g. a +2 ownership bonus times W_ELIGIBILITY=0.25 = +0.5
  // pre-round, which used to silently disappear before the depth multiplier
  // ran). The matcher per-section coverage tests rely on these directional
  // signals being visible in the final integer total.
  let rawScore =
    need.subscale * W_NEED +
    elig.subscale * W_ELIGIBILITY +
    geo.subscale * W_GEO +
    cat.subscale * W_CATEGORY

  // ── Profile depth bonus: richer profiles get up to 10% boost ──
  const depth = measureProfileDepth(effectiveProfile, effectiveSignals, profileNorm)
  const depthMultiplier = 1.0 + Math.min(0.10, depth / 1000)
  rawScore = Math.round(rawScore * depthMultiplier)

  // ── Housing-aware signal bonuses ──
  // These apply AFTER the weighted combination so they can push a strong match over thresholds
  // without distorting the base component model.
  const housingBonusReasons = []

  const profileIsStudent = Boolean(profileNorm?.isStudent)
  const wantsStudentAid = profileWantsStudentAid(profileNorm, effectiveSignals)
  const oppNormForAid = profileNorm ? normalizeOpportunity(opportunity) : null
  if (!profileIsStudent && !wantsStudentAid && isStudentAidOpportunity(opportunity, oppNormForAid)) {
    rawScore = Math.min(rawScore, 40)
    housingBonusReasons.push('Non-student profile × student-aid opportunity (capped at 40)')
  }

  // Workforce / pro bono service alignment — applied after weighting so a WIOA
  // training row beats a generic corporate grant when profile proBonoTerms match.
  if (PRO_BONO_OPPORTUNITY_TYPES.has(String(opportunity?.opportunity_type || '').toLowerCase())) {
    const proBonoTerms = effectiveSignals?.proBonoTerms
    if (proBonoTerms instanceof Set && proBonoTerms.size > 0) {
      const hits = [...proBonoTerms].filter((term) => oppText.includes(normalizeString(term))).length
      if (hits > 0) {
        const boost = Math.min(8, hits * 3)
        rawScore = Math.min(100, rawScore + boost)
        housingBonusReasons.push(`Workforce/service need match (+${boost})`)
      }
    }
  }

  // Dynamically infer housing classification for legacy opportunities without explicit columns
  const housingClass = inferHousingClassification(opportunity)
  const effectiveOpp = (housingClass.fundingCategory && !opportunity.funding_category)
    ? { ...opportunity, funding_category: housingClass.fundingCategory,
        usable_for_housing: housingClass.usableForHousing ? 1 : 0,
        refund_potential: housingClass.refundPotential ? 1 : 0 }
    : opportunity

  // GPA merit boost: if profile has GPA ≥ 3.0 and opportunity is merit/scholarship, boost
  const profileGpa = profileNorm?.academics?.gpa ?? null
  if (profileGpa !== null && profileGpa >= 3.0) {
    const schKeywords = ['scholarship', 'merit', 'academic achievement', 'honor', 'gpa', 'grade']
    if (schKeywords.some((k) => oppText.includes(k))) {
      const gpaBoost = profileGpa >= 3.75 ? 12 : profileGpa >= 3.5 ? 8 : profileGpa >= 3.0 ? 5 : 0
      rawScore = Math.min(100, rawScore + gpaBoost)
      if (gpaBoost > 0) housingBonusReasons.push(`GPA ${profileGpa} merit boost (+${gpaBoost})`)
    }
    // Boost HOPE scholarship specifically
    if (/\bhope\b|\btenessee\s+hope\b/i.test(oppText)) {
      rawScore = Math.min(100, rawScore + 15)
      housingBonusReasons.push('Tennessee HOPE scholarship GPA match (+15)')
    }
  }

  // Major / STEM / interest boost: when the profile declares an intended major
  // or a strong interest set (STEM, forensic science, criminal justice, etc.)
  // and the opportunity is a scholarship/education resource, boost the score.
  // This addresses a project-rule failure where STEM-track students saw broad
  // scholarship search platforms (Bold.org, Scholarships.com, Fastweb) at low
  // scores even though they're the primary path to STEM scholarships.
  const profileEducation = profileNorm?.education || {}
  const profileIntendedMajor = String(
    profileEducation.intendedMajor || effectiveSignals?.education?.intendedMajor || '',
  ).toLowerCase()
  const profileIsStem = Boolean(profileEducation.stemStudent || effectiveSignals?.education?.stemStudent)
  const profileInterestsList = effectiveSignals?.interests instanceof Set
    ? Array.from(effectiveSignals.interests)
    : Array.isArray(effectiveSignals?.interests) ? effectiveSignals.interests : []
  const profileKeywordsSet = effectiveSignals?.keywordSet instanceof Set
    ? effectiveSignals.keywordSet
    : new Set(Array.isArray(effectiveSignals?.keywords) ? effectiveSignals.keywords.map((k) => String(k).toLowerCase()) : [])

  const SCHOLARSHIP_OPP_KEYWORDS = [
    'scholarship', 'scholarships', 'fellowship', 'grant for student', 'grants for student',
    'tuition', 'student aid', 'student grant', 'scholarship search', 'no-essay',
    'no essay', 'merit scholarship', 'study grant',
  ]
  const STEM_OPP_KEYWORDS = [
    'stem', 'science technology engineering math', 'engineer', 'engineering',
    'computer science', 'forensic', 'forensics', 'biology', 'biomedical', 'chemistry',
    'physics', 'mathematics', 'data science', 'cybersecurity', 'health science',
    'nursing scholar', 'pre-med', 'pre med', 'biotechnology', 'environmental science',
    'criminal justice scholarship',
  ]
  const isScholarshipOpp = SCHOLARSHIP_OPP_KEYWORDS.some((k) => oppText.includes(k))
  const isStemOpp = STEM_OPP_KEYWORDS.some((k) => oppText.includes(k))

  // Track non-major-derived interest hits separately so a major+interest stack does not double-count.
  if (isScholarshipOpp && (profileIsStudent || wantsStudentAid)) {
    let majorInterestBoost = 0
    const majorMatched = profileIntendedMajor && (
      oppText.includes(profileIntendedMajor) ||
      profileIntendedMajor.split(/[\s,/]+/).filter((p) => p.length >= 4).some((p) => oppText.includes(p))
    )
    if (majorMatched) {
      majorInterestBoost += 12
      housingBonusReasons.push(`Major match (${profileIntendedMajor}) +12`)
    }
    if (profileIsStem && isStemOpp) {
      majorInterestBoost += 10
      housingBonusReasons.push('STEM profile × STEM scholarship +10')
    } else if (profileIsStem && !majorMatched) {
      // Broad scholarship platforms surface STEM scholarships even without explicit STEM
      // tags. Give a smaller boost so they rise above unrelated emergency-aid programs.
      majorInterestBoost += 6
      housingBonusReasons.push('STEM profile × scholarship platform +6')
    }
    let interestHits = 0
    for (const interest of profileInterestsList) {
      const norm = String(interest || '').toLowerCase().trim()
      if (norm.length < 4) continue
      if (oppText.includes(norm)) {
        interestHits++
        if (interestHits <= 2) housingBonusReasons.push(`Interest match (${norm}) +4`)
      }
    }
    if (interestHits > 0) {
      majorInterestBoost += Math.min(8, interestHits * 4)
    }
    // Generic scholarship search platforms (referral_type) are the primary path
    // to discover field-specific scholarships. Give a small structural boost so
    // they don't lose to unrelated rows for student profiles that reach this branch.
    const fundingType = String(opportunity?.funding_type || '').toLowerCase()
    const oppType = String(opportunity?.opportunity_type || opportunity?.type || '').toLowerCase()
    const isPlatform = fundingType === 'referral_service' || ['portal', 'referral'].includes(oppType)
    if (isPlatform && (profileNorm?.isStudent || profileKeywordsSet.has('scholarship'))) {
      majorInterestBoost += 5
      housingBonusReasons.push('Scholarship platform (broad coverage) +5')
    }
    if (majorInterestBoost > 0) {
      rawScore = Math.min(100, rawScore + Math.min(20, majorInterestBoost))
    }
  }

  // Faith boost: profile has faith indicator + opportunity is faith-based
  const profileHasFaith = profileNorm?.hasFaithIndicator ??
    (profileNorm?.affiliations ?? []).includes('faith_based') ?? false
  if (profileHasFaith) {
    const faithOppKeywords = ['faith', 'church', 'religious', 'christian', 'catholic', 'denomination',
      'congregation', 'ministry', 'theological', 'seminary', 'bible', 'baptist', 'methodist',
      'lutheran', 'presbyterian', 'evangelical', 'diocese']
    if (faithOppKeywords.some((k) => oppText.includes(k))) {
      rawScore = Math.min(100, rawScore + 10)
      housingBonusReasons.push('Faith affiliation match (+10)')
    }
    // Opportunity has funding_category = faith_based
    if (effectiveOpp?.funding_category === 'faith_based') {
      rawScore = Math.min(100, rawScore + 8)
      housingBonusReasons.push('Faith-based funding category (+8)')
    }
  }

  // Talent/music boost: profile has music signals + opportunity is talent-based
  const profileTalent = profileNorm?.talentSignals ?? null
  if (profileTalent?.music) {
    const musicOppKeywords = ['music', 'band', 'orchestra', 'choir', 'instrument', 'musical',
      'performing arts', 'arts scholarship', 'talent', 'performance', 'conservatory']
    if (musicOppKeywords.some((k) => oppText.includes(k))) {
      rawScore = Math.min(100, rawScore + 12)
      housingBonusReasons.push('Music/talent signal match (+12)')
    }
    if (effectiveOpp?.funding_category === 'talent_based') {
      rawScore = Math.min(100, rawScore + 8)
      housingBonusReasons.push('Talent-based funding category (+8)')
    }
  }
  if (profileTalent?.leadership) {
    if (/\bleadership\b|\bservice\b|\bcommunity\b/i.test(oppText)) {
      rawScore = Math.min(100, rawScore + 5)
      housingBonusReasons.push('Leadership signal match (+5)')
    }
  }

  // Tennessee location boost: profile is in TN (any of its addresses) + opportunity is TN-specific.
  // Multi-address aware so a home-OH / school-TN student still gets the TN boost for TN aid.
  const profileState = profileNorm?.state ?? effectiveProfile?.state ?? null
  const profileStateListForBoost = profileStates(effectiveSignals, profileState)
  if (profileStateListForBoost.includes('TN')) {
    const tnKeywords = ['tennessee', 'tn ', 'hope scholarship', 'tennessee student assistance',
      'tsac', 'nashville', 'knoxville', 'memphis', 'chattanooga', 'jackson', 'clarksville']
    if (tnKeywords.some((k) => oppText.includes(k))) {
      rawScore = Math.min(100, rawScore + 8)
      housingBonusReasons.push('Tennessee geographic signal match (+8)')
    }
  }

  // Refund-eligible / stipend boost for student profiles needing housing
  if (profileNorm?.isStudent && (profileNorm?.hasHousingNeed || profileNorm?.needCategories?.includes('housing'))) {
    if (
      effectiveOpp?.usable_for_housing ||
      effectiveOpp?.refund_potential ||
      ['refund_eligible', 'stipend', 'housing_direct'].includes(effectiveOpp?.funding_category)
    ) {
      rawScore = Math.min(100, rawScore + 10)
      housingBonusReasons.push('Housing-usable funding matched student housing need (+10)')
    }
  }

  const { boost: populationMissionBoost, hits: populationMissionHits } =
    computePopulationMissionPostBoost(profileNorm, oppText)
  if (populationMissionBoost > 0) {
    rawScore = Math.min(100, rawScore + populationMissionBoost)
    housingBonusReasons.push(...populationMissionHits)
  }

  // Strong local fit: profile need(s) align with this program AND geography
  // is at least state-level (or closer). Surfaces TN SNAP / TennCare / AAAD
  // at realistic slider thresholds for profiles like Dr. John White.
  const profileNeedsForBoost = collectProfileNeeds(effectiveProfile, effectiveSignals, profileNorm)
  if (profileNeedsForBoost.length > 0 && geo.subscale >= 75) {
    const oppKwsForBoost = safeParseArrayField(opportunity?.keywords, [])
    const oppCatsForBoost = safeParseArrayField(opportunity?.categories, [])
    const oppSignalsForBoost = [...oppKwsForBoost, ...oppCatsForBoost].map((t) => String(t).toLowerCase())
    const needHitsForBoost = countNeedSynonymHits(profileNeedsForBoost, oppText, oppSignalsForBoost)
    if (needHitsForBoost > 0) {
      const needGeoBoost = Math.min(24, 12 + needHitsForBoost * 5)
      rawScore = Math.min(100, rawScore + needGeoBoost)
      housingBonusReasons.push(`Direct need + geographic fit (+${needGeoBoost})`)
    }
  }

  // ── SOFT preference nudge (user-behavior learning — architecture #12) ──
  // Applied AFTER the weighted score, BEFORE the floor/0-100 clamp. The nudge is
  // a SMALL bounded additive number (±BEHAVIOR_NUDGE_MAX) derived from the user's
  // own save/apply/dismiss history. When no preference vector is supplied (or it
  // is empty / the feature is disabled) the nudge is exactly 0 → identical score.
  // This is SOFT preference learning, never a hard filter: it can tip a
  // borderline match but cannot eliminate one.
  const preferenceSignals = opts?.preferenceSignals ?? null
  let behaviorNudgeReason = null
  if (preferenceSignals) {
    const { nudge, reason } = computePreferenceNudge(preferenceSignals, effectiveOpp)
    if (nudge !== 0) {
      rawScore = rawScore + nudge
      behaviorNudgeReason = reason
      housingBonusReasons.push(reason)
    }
  }

  // ── Floor guarantee: validated opportunities always score ≥ SCORE_FLOOR ──
  const finalScore = Math.max(SCORE_FLOOR, Math.min(100, rawScore))

  // Build human-readable reasons
  if (geo.tier === 'zip') reasons.push('Geography: ZIP match')
  else if (geo.tier === 'county') reasons.push('Geography: County match')
  else if (geo.tier === 'city') reasons.push('Geography: City match (text)')
  else if (geo.tier === 'state') reasons.push('Geography: State match')
  else if (geo.tier === 'national') reasons.push('National eligibility')
  else if (geo.tier === 'unknown') reasons.push('Location unknown — cannot verify geographic eligibility')
  else if (geo.tier === 'mismatch' || geo.tier === 'title_state_mismatch') reasons.push('Geography mismatch (soft penalty)')

  if (elig.applicantTypeMatch) reasons.push('Applicant type match')
  else if (!elig.hasApplicantTypeSignals) reasons.push('Applicant type unknown (no penalty)')

  if (need.keywordRaw > 0) reasons.push(`Keyword match (${need.keywordRaw} pts)`)
  if (cat.categoryRaw > 0) reasons.push(`Category match (${cat.categoryRaw} pts)`)

  need.facetDetail.reasons.forEach((r) => reasons.push(r))
  if (elig.demoBonus > 0) reasons.push(`Demographic/affiliation alignment (${elig.demoBonus} pts)`)

  for (const r of need.reasons) {
    if (r.startsWith('Need alignment') || r.startsWith('Intent:')) reasons.push(r)
  }

  if (amountInRange(effectiveProfile?.funding_amount_needed, opportunity)) reasons.push('Amount eligibility')
  if (cat.deadlineScore > 0) reasons.push(`Deadline urgency (${cat.deadlineScore} pts)`)

  for (const r of elig.reasons) {
    if (r.includes('penalty') || r.includes('Loan') || r.includes('missing') || r.includes('funds')) reasons.push(r)
  }

  // Housing-aware signal reasons
  for (const r of housingBonusReasons) reasons.push(r)

  // Collect matched signals for match_explain.
  // Use the canonical normalized opportunity/profile need alignment so Anya and
  // result cards can explain exactly which profile needs matched.
  const canonicalOppNormForExplain = profileNorm ? normalizeOpportunity(effectiveOpp) : null
  const canonicalNeedForExplain =
    profileNorm && canonicalOppNormForExplain
      ? calculateNeedAlignment(profileNorm, canonicalOppNormForExplain)
      : { matchedNeeds: [] }

  const matchedSignals = []
  const matchedNeeds = Array.isArray(canonicalNeedForExplain.matchedNeeds)
    ? canonicalNeedForExplain.matchedNeeds
    : []
  if (geo.tier && geo.tier !== 'mismatch' && geo.tier !== 'unknown' && geo.tier !== 'soft_mismatch' && geo.tier !== 'title_state_mismatch')
    matchedSignals.push(`geo:${geo.tier}`)
  if (elig.applicantTypeMatch) matchedSignals.push('applicant_type')
  if (need.keywordRaw > 0) matchedSignals.push('keywords')
  if (cat.categoryRaw > 0) matchedSignals.push('category')
  if (matchedNeeds.length > 0) matchedSignals.push('needs')

  const opportunityType = String(opportunity?.opportunity_type || opportunity?.type || '').toLowerCase()
  const fundingType = normalizeString(opportunity?.funding_type || '')
  if (PRO_BONO_OPPORTUNITY_TYPES.has(opportunityType)) matchedSignals.push(`opportunity_type:${opportunityType}`)
  if (SERVICE_FUNDING_TYPES.has(fundingType)) matchedSignals.push(`funding_type:${fundingType}`)

  // ── Explicit profile signal contributions (mission-audit requirement) ──
  // Every field the audit called out (country, employee_count, annual_revenue,
  // years_in_operation, veteran_owned, woman_owned, minority_owned,
  // organization_type, population_served, mission_focus) flows into the
  // existing component scores via profileNorm/effectiveFacets. Surfacing them
  // here lets Anya explain *which* profile facts produced the match in plain
  // language without having to re-run normalization.
  const profileSignalsUsed = profileNorm ? listPresentProfileSignals(profileNorm) : []
  const profileReasonLines = []
  if (profileNorm) {
    if (profileNorm.country) profileReasonLines.push(`Country: ${profileNorm.country}`)
    if (profileNorm.organizationType)
      profileReasonLines.push(`Organization type: ${profileNorm.organizationType}`)
    if (profileNorm.populationServed && String(profileNorm.populationServed).length > 0)
      profileReasonLines.push(`Population served: ${profileNorm.populationServed}`)
    if (profileNorm.missionFocus && String(profileNorm.missionFocus).length > 0)
      profileReasonLines.push(`Mission focus: ${profileNorm.missionFocus}`)
    if (profileNorm.isVeteranOwned) profileReasonLines.push('Veteran-owned status considered')
    if (profileNorm.isWomanOwned) profileReasonLines.push('Woman-owned status considered')
    if (profileNorm.isMinorityOwned) profileReasonLines.push('Minority-owned status considered')
    if (Number.isFinite(profileNorm.employeeCount))
      profileReasonLines.push(`Employee count: ${profileNorm.employeeCount}`)
    if (Number.isFinite(profileNorm.annualRevenue))
      profileReasonLines.push(`Annual revenue tier considered`)
    if (Number.isFinite(profileNorm.yearsInOperation))
      profileReasonLines.push(`Years in operation: ${profileNorm.yearsInOperation}`)
  }
  for (const line of profileReasonLines) reasons.push(line)

  const match_explain = {
    matchedNeeds: matchedNeeds.length > 0 ? matchedNeeds : undefined,
    matchedSignals,
    profileSignalsUsed,
    profileReasonLines,
    housingSignals: housingBonusReasons.length > 0 ? housingBonusReasons : undefined,
    behaviorNudge: behaviorNudgeReason || undefined,
    usableForHousing: Boolean(effectiveOpp?.usable_for_housing || effectiveOpp?.refund_potential ||
      ['refund_eligible', 'stipend', 'housing_direct'].includes(effectiveOpp?.funding_category)),
    fundingCategory: effectiveOpp?.funding_category ?? null,
    scoreBreakdown: {
      need_component: need.subscale,
      eligibility_component: elig.subscale,
      geo_component: geo.subscale,
      category_component: cat.subscale,
      profile_depth: depth,
      geo: geo.subscale,
      applicant_type: elig.applicantTypeMatch ? 25 : 0,
      keyword: need.keywordRaw,
      category: cat.categoryRaw,
      facet: need.facetDetail.points,
      demographic_affiliation: elig.demoBonus,
      amount: amountInRange(effectiveProfile?.funding_amount_needed, opportunity) ? 10 : 0,
      deadline: cat.deadlineScore,
      housing_signal_bonus: housingBonusReasons.reduce((sum, reason) => {
        const match = String(reason).match(/\+(\d+)/)
        return sum + (match ? Number(match[1]) : 0)
      }, 0),
      total: finalScore,
    },
    reasons: reasons.length > 0 ? reasons : ['No specific matches found'],
  }

  // ── CONFIDENCE (orthogonal to MATCH score) ──
  // Computed from source trust / actionability / eligibility-text completeness /
  // freshness — NONE of which feed `finalScore`. A high-fit row from an unknown
  // source with a placeholder URL keeps its high MATCH but earns a low
  // CONFIDENCE; an official, actionable row earns high confidence. Confidence is
  // additive metadata only and never alters `score`.
  const oppNormForConfidence = canonicalOppNormForExplain ?? normalizeOpportunity(effectiveOpp)
  const { confidence, confidence_reasons, confidence_band, confidence_components } =
    calculateConfidence(effectiveOpp, oppNormForConfidence)
  match_explain.confidence = confidence
  match_explain.confidence_band = confidence_band
  match_explain.confidence_components = confidence_components

  return {
    score: finalScore,
    confidence,
    confidence_reasons,
    confidence_band,
    reasons: reasons.length > 0 ? reasons : ['No specific matches found'],
    match_explain,
  }
}

// ---------------------------------------------------------------------------
// matchOpportunities — batch scoring with progressive score relaxation
// ---------------------------------------------------------------------------

/**
 * Score and rank a list of opportunities against a profile.
 *
 * @param {Object} profile        - Profile or profileContext
 * @param {Array}  opportunities  - Array of opportunity objects
 * @param {Object} [opts]
 * @param {number} [opts.minScore=0] - Minimum score threshold
 * @param {Object} [opts.preferenceSignals] - SOFT user-behavior preference
 *   vector (architecture #12). Loaded ONCE per profile (via
 *   loadPreferenceSignals / behaviorLearning.getProfilePreferenceSignals) and
 *   applied to every opportunity in this batch with NO per-call DB read. When
 *   absent or empty → ZERO change to every score.
 * @returns {Array} Opportunities sorted by score desc, each augmented with score/reasons/match_explain.
 *                  result._relaxed is set when the threshold was relaxed.
 */
export function matchOpportunities(profile, opportunities, opts = {}) {
  if (!Array.isArray(opportunities) || opportunities.length === 0) return []

  // Resolve the SOFT preference vector ONCE for the whole batch (no per-call DB
  // read). When none is supplied the per-opportunity nudge is a no-op.
  const preferenceSignals = opts.preferenceSignals ?? null
  const scoreOpts = preferenceSignals ? { preferenceSignals } : undefined

  const scored = opportunities.map((opp) => {
    const { score, confidence, confidence_reasons, confidence_band, reasons, match_explain } =
      scoreOpportunity(profile, opp, scoreOpts)
    return { ...opp, score, confidence, confidence_reasons, confidence_band, reasons, match_explain }
  })

  scored.sort((a, b) => b.score - a.score)

  const requestedMin = typeof opts.minScore === 'number' ? opts.minScore : 0
  const strictMinScore = opts.strictMinScore === true
  const relaxSteps = [DEFAULT_MIN_SCORE, ...RELAX_THRESHOLDS]

  const passesMin = (results, threshold) => results.filter((r) => r.score >= threshold)

  let results = passesMin(scored, requestedMin)
  let relaxed = null

  if (!strictMinScore && results.length === 0 && requestedMin > 0) {
    for (const threshold of relaxSteps) {
      if (threshold >= requestedMin) continue
      results = passesMin(scored, threshold)
      if (results.length > 0) {
        relaxed = { originalMinScore: requestedMin, relaxedTo: threshold }
        break
      }
    }
    if (results.length === 0) results = scored.slice(0, FALLBACK_TOP_N)
  }

  if (relaxed) results._relaxed = relaxed

  return results
}

/**
 * Convenience loader for the SOFT user-behavior preference vector (architecture
 * #12). The read-path (e.g. backend/routes/matching.js) should call this ONCE
 * per profile and pass the result into matchOpportunities(..., { preferenceSignals }):
 *
 *   const preferenceSignals = await loadPreferenceSignals(db, profileId)
 *   const results = matchOpportunities(profile, opps, { ...opts, preferenceSignals })
 *
 * Best-effort + gated: returns an empty (no-op) vector when the feature is
 * disabled, when there's no behavior data, or on any error — so adding this
 * single line can never change scores until the user actually has history.
 */
export async function loadPreferenceSignals(db, profileId) {
  if (!isBehaviorLearningEnabled()) return null
  try {
    return await getProfilePreferenceSignals(db, profileId)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// makeDecision — score-based decision
// ---------------------------------------------------------------------------

/**
 * Determine ACCEPT / REVIEW / REJECT for a scored opportunity.
 *
 * Hard REJECT triggers:
 *   - loan program
 *   - matching funds required
 *   - veteran-only without veteran flag
 *   - student-only without student profile type
 *   - nonprofit-only for individual profiles
 *   - research/institutional-only without org
 *
 * @param {number} score       - Computed score (0–100)
 * @param {Object} profile     - Raw profile object
 * @param {Object} opportunity - Raw opportunity object
 * @returns {{ decision: string, explanation: string, reasons: string[] }}
 */
export function makeDecision(score, profile, opportunity, normalizedProfile = null, signals = null) {
  const reasons = []
  const opp = opportunity || {}
  const prof = profile || {}

  const oppText = `${opp.title || ''} ${opp.description || ''}`.toLowerCase()
  const opportunityType = String(opp.opportunity_type || opp.type || '').toLowerCase()

  // Prefer normalized profile flags (section-derived) over raw field checks.
  // This ensures veteran status from military_service section, student status
  // from education section, etc. are correctly detected.
  const np = normalizedProfile
  const profileType = np?.entityType ?? String(
    prof.profile_type || prof.primary_type || prof.applicant_type || '',
  ).toLowerCase()

  const isStudentProfile = np?.isStudent ?? ['student', 'high_school_student', 'college_student'].includes(profileType)
  const isVeteran = np?.isVeteran ?? Boolean(prof.is_veteran || prof.veteran || prof.military_veteran)
  const isNonprofit = np?.isNonprofit ?? Boolean(prof.is_nonprofit || prof.ein || prof.uei || ['nonprofit', 'organization'].includes(profileType))
  const isBusiness = np?.isBusiness ?? (['small_business', 'business'].includes(profileType) || Boolean(prof.is_business))
  const isIndividual = ['individual', 'individual_need', 'family', 'medical_assistance'].includes(profileType)

  const isIndividualOrCaregiver = isIndividual || profileType === 'caregiver' || np?.isCaregiver
  const isResearcher = profileType === 'researcher'
  const profNeeds = np?.needCategories ?? safeParseArrayField(prof.needs, []).map((n) => String(n).toLowerCase())

  // Hard REJECT conditions — explicit boolean flags take priority over regex
  if (['loan', 'loan_program', 'microloan'].includes(opportunityType) || opp.is_loan || /\bloan\b/.test(oppText)) {
    reasons.push('Loan program — not a grant')
    return { decision: 'REJECT', explanation: 'Opportunity is a loan program, not a grant.', reasons }
  }

  if (opp.requires_match) {
    reasons.push('Requires matching funds')
    return { decision: 'REJECT', explanation: 'Opportunity requires matching funds which profile cannot provide.', reasons }
  }

  if ((opp.requires_veteran || RE_VETERAN_ONLY.test(oppText)) && !isVeteran) {
    reasons.push('Veteran-only program; profile is not a veteran')
    return { decision: 'REJECT', explanation: 'Opportunity requires veteran status.', reasons }
  }

  if ((opp.requires_student || RE_STUDENT_ONLY.test(oppText)) && !isStudentProfile) {
    // Recall guard (mirror evaluateEligibility): hard-REJECT only when the
    // profile affirmatively contradicts student status; otherwise downgrade to
    // REVIEW so a near-student isn't silently denied legitimately relevant aid.
    if (profileContradictsStudent(np, prof)) {
      reasons.push('Student-only program; profile is not a student')
      return { decision: 'REJECT', explanation: 'Opportunity requires student status.', reasons }
    }
    reasons.push('Student-only program; profile student status unconfirmed — review (missing: student_status)')
    return {
      decision: 'REVIEW',
      explanation: 'Opportunity requires student status; profile appears student-adjacent but student status is unconfirmed. Confirm enrollment.',
      reasons,
    }
  }

  if ((opp.requires_women || RE_WOMEN_ONLY.test(oppText)) && profileGenderIsFemale(np) === false) {
    reasons.push('Women-only program; profile is not female')
    return { decision: 'REJECT', explanation: 'Opportunity is for women/female applicants only.', reasons }
  }

  if ((opp.requires_nonprofit || RE_NONPROFIT_REQUIRED.test(oppText)) && !isNonprofit) {
    reasons.push('Nonprofit-only program; profile is not a nonprofit')
    return { decision: 'REJECT', explanation: 'Opportunity is for nonprofits only.', reasons }
  }

  const RE_BUSINESS_EXCLUSIVE = /\b(exclusively\s+for\s+(?:small\s+)?business|(?:small\s+)?business\s+owners?\s+only|for\s+(?:small\s+)?business\s+owners?\s+and\s+entrepreneurs)\b/i
  if ((opp.requires_business || RE_BUSINESS_EXCLUSIVE.test(oppText)) && !isBusiness) {
    reasons.push('Business-only program; profile is not a business')
    return { decision: 'REJECT', explanation: 'Opportunity requires business ownership.', reasons }
  }

  if ((opp.is_institutional_only || opp.is_research_only || RE_INSTITUTIONAL_ONLY.test(oppText)) && !isNonprofit && !isBusiness && !isResearcher) {
    reasons.push('Research/institutional-only program; profile lacks org/research credentials')
    return { decision: 'REJECT', explanation: 'Opportunity is for research institutions only; profile has no organization credentials.', reasons }
  }

  if (opp.disease_specific && !profNeeds.includes('disability') && !profNeeds.includes('health_medical')) {
    reasons.push('Disease-specific program; profile has no matching condition')
    return { decision: 'REJECT', explanation: 'Opportunity is disease-specific; profile has no matching condition.', reasons }
  }

  if (opp.requires_disaster_context && !profNeeds.includes('emergency') && !prof.disaster_affected) {
    reasons.push('Disaster-only program; profile is not disaster-affected or in emergency need')
    return { decision: 'REJECT', explanation: 'Opportunity requires disaster context.', reasons }
  }

  // Pro bono / in-kind / referral-only: REJECT for nonprofits/businesses (not direct funding)
  const isProBono = /\bpro\s*bono\b/i.test(oppText)
  const isInKind = /\bin[- ]kind\b/i.test(oppText)
  const isReferralOnly = /\breferral\s+only\b/i.test(oppText) || /\bagency\s+referral\s+required\b/i.test(oppText)
  if (isProBono || isInKind || isReferralOnly) {
    const label = isProBono ? 'pro bono' : isInKind ? 'in-kind' : 'referral-only'
    if (isIndividualOrCaregiver) {
      reasons.push(`${label} opportunity — still relevant assistance for individuals/caregivers`)
      return { decision: 'REVIEW', explanation: `${label} opportunity may be useful assistance for ${profileType} profile.`, reasons }
    }
    const profileLabel = isNonprofit ? 'nonprofits' : 'businesses'
    reasons.push(`${label} opportunity — not direct funding for ${profileLabel}`)
    return { decision: 'REJECT', explanation: `${label} opportunity is not direct financial assistance for ${profileLabel}.`, reasons }
  }

  // Geographic state mismatch — per project rules, geography must EXPAND OUTWARD
  // (city → county → state → national) and must NOT hard-eliminate opportunities
  // UNLESS the opportunity is explicitly state-exclusive.
  //
  // We hard-REJECT only when the opportunity text contains a resident/residency
  // signal (e.g. "residents only", "for California residents", "exclusively for
  // Texas residents"), or when the caller has pre-tagged state_residents_only.
  // A bare `state: 'XX'` + `is_national: 0` is NOT sufficient to hard-REJECT
  // because many non-national opportunities still accept cross-state applicants
  // (per backend/tests/makeDecision.geography.test.js regression coverage).
  // Prefer the normalized, section-aware profile state (np.state) over the raw
  // top-level field so a profile whose state lives in a section is correctly
  // resolved (e.g. "Tennessee" → "TN") before the comparison. MISSING state is
  // NEUTRAL: when the profile state is unresolved we never hard-REJECT on
  // state-exclusivity — at worst we downgrade to REVIEW.
  // Multi-address aware: consider EVERY state across the profile's addresses.
  // A program in ANY of the profile's states is in-state (no reject/review).
  // The state-exclusive REJECT fires ONLY when the program's state is known AND
  // is NOT in ANY of the profile's states (and never when the profile has none).
  // Single-address profiles collapse to exactly one state → identical behavior.
  const profStateList = profileStates(signals, np?.state ?? prof.state)
  const profState = profStateList[0] ? profStateList[0] : String((np?.state ?? prof.state) || '').trim()
  const oppStateRaw = String(opp.state || '').trim()
  const oppIsNational = Boolean(opp.is_national) || oppStateRaw.toLowerCase() === 'nationwide'
  const oNormState = normalizeState(oppStateRaw)
  const matchesAnyProfileState = Boolean(oNormState) && profStateList.includes(oNormState)
  if (oppStateRaw && !oppIsNational && oNormState && !matchesAnyProfileState) {
    if (profStateList.length === 0) {
      // No profile state at all. Per canonical_rules "missing = neutral": do NOT
      // REJECT even when the opportunity is state-exclusive; surface for review so
      // the user can confirm residency themselves.
      const RE_STATE_EXCLUSIVE_MISSING = /\b(residents?\s+only|must\s+be\s+a?\s*resident|must\s+reside\s+in|limited\s+to\s+residents|for\s+\w+(?:\s+\w+)?\s+residents?|\w+\s+residents?\s+(?:only|facing|who|experiencing|must)|exclusively\s+for\s+\w+(?:\s+\w+)?\s+residents?)\b/i
      if (RE_STATE_EXCLUSIVE_MISSING.test(oppText) || opp.state_residents_only === true) {
        reasons.push(`Geographic note — opportunity is for ${oppStateRaw} residents; profile state unknown (confirm eligibility)`)
        return {
          decision: 'REVIEW',
          explanation: `Opportunity appears limited to ${oppStateRaw} residents but the profile's state is unknown. Confirm residency on the program page.`,
          reasons,
        }
      }
      // No exclusivity signal + unknown profile state: fall through to scoring.
    } else {
      // Opportunity's state is in NONE of the profile's states.
      // Residency-scope signals: any phrase tying "residents" to a qualifier is
      // treated as an explicit state-scope declaration.
      //   • "residents only" / "must be a resident" / "must reside in"
      //   • "limited to residents"
      //   • "for <X> residents" (e.g. "for Texas residents")
      //   • "<X> residents (only|facing|who|experiencing|...)"
      //   • "exclusively for <X> residents"
      const RE_STATE_EXCLUSIVE = /\b(residents?\s+only|must\s+be\s+a?\s*resident|must\s+reside\s+in|limited\s+to\s+residents|for\s+\w+(?:\s+\w+)?\s+residents?|\w+\s+residents?\s+(?:only|facing|who|experiencing|must)|exclusively\s+for\s+\w+(?:\s+\w+)?\s+residents?)\b/i
      const isExplicitlyExclusive =
        RE_STATE_EXCLUSIVE.test(oppText) || opp.state_residents_only === true
      const profStateLabel = profStateList.join('/')
      if (isExplicitlyExclusive) {
        const reasonText = `Geographic mismatch: opportunity is for ${oppStateRaw}, profile is in ${profStateLabel}`
        reasons.push(reasonText)
        return { decision: 'REJECT', explanation: `${reasonText}.`, reasons }
      }
      reasons.push(`Geographic note — opportunity is in ${oppStateRaw}, profile is in ${profStateLabel} (may still be accessible)`)
      return { decision: 'REVIEW', explanation: `Opportunity is based in ${oppStateRaw} but may be accessible from ${profStateLabel}. Confirm eligibility on the program page.`, reasons }
    }
  }

  if (score >= ACCEPT_SCORE) {
    reasons.push(`Score ${score} ≥ ${ACCEPT_SCORE} — strong match`)
    return { decision: 'ACCEPT', explanation: `Score ${score}/100 indicates a strong match.`, reasons }
  }

  if (score >= REVIEW_SCORE) {
    reasons.push(`Score ${score} ≥ ${REVIEW_SCORE} — possible match`)
    return { decision: 'REVIEW', explanation: `Score ${score}/100 warrants review; moderate match signals.`, reasons }
  }

  reasons.push(`Score ${score} < ${REVIEW_SCORE} — weak match; keep for review instead of discarding`)
  return {
    decision: 'REVIEW',
    explanation: `Score ${score}/100 is weak, but the opportunity remains reviewable because low score alone is not hard ineligibility.`,
    reasons,
  }
}

// ---------------------------------------------------------------------------
// computeMatchDecision — combined (backward-compat with matchDecisionEngine.js)
// ---------------------------------------------------------------------------

/**
 * Compute combined score + eligibility decision for a profile/opportunity pair.
 * Backward-compatible replacement for matchDecisionEngine.computeMatchDecision().
 *
 * @param {Object} rawProfile     - Raw profile or pre-normalized
 * @param {Object} rawOpportunity - Raw opportunity or pre-normalized
 * @param {Object} [opts]
 * @param {Object} [opts.profileSections] - Profile sections for richer normalization
 * @returns {Object} Full structured result
 */
export function computeMatchDecision(rawProfile, rawOpportunity, opts = {}) {
  if (!rawProfile || !rawOpportunity) {
    return {
      score: 0,
      reasons: ['Insufficient data'],
      match_explain: { matchedNeeds: [], matchedSignals: [], scoreBreakdown: {}, reasons: ['Insufficient data'] },
      decision: 'REVIEW',
      explanation: 'Insufficient data to evaluate match.',
      eligible: 'maybe',
      ineligibilityReasons: ['Could not evaluate — missing profile or opportunity'],
      needAlignment: 0,
      confidence: 0,
      matcherVersion: MATCHER_VERSION,
      evaluatedAt: new Date().toISOString(),
    }
  }

  // Build signals when sections are available so normalizeProfile gets the full
  // set of inferred needs from buildProfileSignals (healthcare, employment, etc.)
  let signals = opts.signals ?? null
  if (!signals && opts.profileSections) {
    const effectiveProfile = rawProfile?.profile ?? rawProfile
    signals = buildProfileSignals({ profile: effectiveProfile, sections: opts.profileSections })
  }

  // Census-derived geo ENRICHMENT (deterministic county/FIPS attached during
  // discovery as rawOpportunity.verification.geo). Strictly ADDITIVE: fill the
  // opportunity's geo_county ONLY when it is missing — never override a value
  // the source already provided, and never introduce a hard reject. This lets
  // the geo component reach the county tier it otherwise could not.
  const attachedGeo = rawOpportunity?.verification?.geo ?? null
  if (attachedGeo && (attachedGeo.county || attachedGeo.fips) && !rawOpportunity.geo_county) {
    rawOpportunity = { ...rawOpportunity, geo_county: attachedGeo.county ?? rawOpportunity.geo_county }
  }

  // Normalize for eligibility checks — pass signals so inferred needs are merged
  const profileNorm = rawProfile?.entityType !== undefined
    ? rawProfile
    : normalizeProfile(rawProfile, opts.profileSections, signals)
  const oppNorm = rawOpportunity?.entityTypesAllowed !== undefined
    ? rawOpportunity
    : normalizeOpportunity(rawOpportunity)

  const eligibilityEval = evaluateEligibility(profileNorm, oppNorm)

  // Hard eligibility gate.
  // Geography is intentionally excluded here because makeDecision() has the
  // project-specific rule: state mismatch is hard only when the opportunity is
  // explicitly resident/state-exclusive. All other hard ineligibility reasons
  // should reject before scoring so profile-inappropriate matches do not appear.
  const hardEligibilityReasons = (eligibilityEval.ineligibilityReasons ?? [])
    .filter((reason) => !/^Geographic mismatch:/i.test(String(reason)))

  if (hardEligibilityReasons.length > 0) {
    const evaluatedAt = new Date().toISOString()
    return {
      score: 0,
      reasons: hardEligibilityReasons,
      match_explain: {
        matchedNeeds: [],
        matchedSignals: [],
        scoreBreakdown: { total: 0 },
        reasons: hardEligibilityReasons,
      },
      decision: 'REJECT',
      explanation: `Rejected by hard eligibility rules: ${hardEligibilityReasons.join('; ')}`,
      eligible: false,
      ineligibilityReasons: hardEligibilityReasons,
      matchedNeeds: [],
      matchedProfileTraits: [],
      matched_profile_facts: [],
      missingEligibilityFields: eligibilityEval.missingFields ?? [],
      needAlignment: 0,
      confidence: 95,
      matcherVersion: MATCHER_VERSION,
      evaluatedAt,
    }
  }

  // Pass sections/signals to scoreOpportunity so it can build keyword + facet
  // signals (geo, keywords, etc.). Without this, already-normalized profiles
  // short-circuit the scoring context and every opportunity gets the same score.
  const effectiveProfileForScoring = rawProfile?.profile ?? rawProfile
  const sectionsForScoring = opts.profileSections ?? rawProfile?.sections ?? null
  const signalsForScoring = signals ?? rawProfile?.signals ?? null
  const profileForScoring = (sectionsForScoring || signalsForScoring)
    ? { profile: effectiveProfileForScoring, sections: sectionsForScoring, signals: signalsForScoring }
    : rawProfile
  // Forward the optional soft behavior-preference signals (no-op when absent),
  // so the user-activity nudge applies on the canonical decision path too.
  const { score, reasons, match_explain } = scoreOpportunity(profileForScoring, rawOpportunity, {
    preferenceSignals: opts.preferenceSignals,
  })

  // Need alignment from normalised objects (uses calculateNeedAlignment for consistency)
  const { score: needAlignment, matchedNeeds } = calculateNeedAlignment(profileNorm, oppNorm)

  let finalScore = score
  const scoreCaps = []
  const matchedSignalsForCap = Array.isArray(match_explain?.matchedSignals)
    ? match_explain.matchedSignals
    : []

  const hasMaterialProfileEvidence =
    matchedNeeds.length > 0 ||
    matchedSignalsForCap.some((sig) => {
      const s = String(sig)
      return (
        s === 'applicant_type' ||
        s === 'keywords' ||
        s === 'category' ||
        s === 'needs' ||
        s.startsWith('opportunity_type:') ||
        s.startsWith('funding_type:')
      )
    }) ||
    Number(match_explain?.scoreBreakdown?.facet ?? 0) > 0 ||
    Number(match_explain?.scoreBreakdown?.demographic_affiliation ?? 0) > 0

  if (!hasMaterialProfileEvidence && !oppNorm?.isDirectory && finalScore > 45) {
    finalScore = 45
    scoreCaps.push(
      'Capped at 45: only generic/geographic evidence; no direct need, applicant-type, keyword, category, demographic, or profile-facet match.',
    )
  }

  if (eligibilityEval.eligible === 'maybe' && finalScore > 80) {
    finalScore = 80
    scoreCaps.push('Capped at 80: eligibility is incomplete and needs user review.')
  }

  // Education-level and out-of-state-local mismatches must never ACCEPT for an
  // adult college / out-of-state profile. A K-12-only award for an adult college
  // student, or a single-district / out-of-state-county award, is at best a
  // REVIEW: cap firmly below ACCEPT_SCORE so the keyword collision on
  // "scholarship"/"education" can no longer drive a 90%+/ACCEPT (e.g. the
  // "Elementary & Middle School Scholarships - Polk State College" 97% ACCEPT).
  const elderMissing = eligibilityEval.missingFields ?? []
  const MISMATCH_CAP = Math.max(0, ACCEPT_SCORE - 10)
  if (elderMissing.includes('education_level_mismatch_k12') && finalScore > MISMATCH_CAP) {
    finalScore = MISMATCH_CAP
    scoreCaps.push(`Capped at ${MISMATCH_CAP}: K-12 / elementary award not aligned with an adult higher-ed profile (review).`)
  }
  if (elderMissing.includes('local_award_out_of_state') && finalScore > MISMATCH_CAP) {
    finalScore = MISMATCH_CAP
    scoreCaps.push(`Capped at ${MISMATCH_CAP}: local single-district / out-of-state-county award (review geography).`)
  }

  if (
    !profileNorm.isStudent &&
    !profileWantsStudentAid(profileNorm, signals) &&
    isStudentAidOpportunity(rawOpportunity, oppNorm) &&
    finalScore > 45
  ) {
    finalScore = 45
    scoreCaps.push('Capped at 45: student-aid opportunity not aligned with non-student profile.')
  }

  finalScore = Math.round(Math.max(0, Math.min(100, finalScore)))

  if (match_explain?.scoreBreakdown) {
    match_explain.scoreBreakdown.total_before_caps = score
    match_explain.scoreBreakdown.total = finalScore
    if (scoreCaps.length > 0) match_explain.scoreBreakdown.score_caps = scoreCaps
  }
  if (scoreCaps.length > 0) {
    match_explain.scoreCaps = scoreCaps
    reasons.push(...scoreCaps)
  }

  // Decision via makeDecision — pass normalizedProfile so section-derived flags are used
  let { decision, explanation, reasons: decisionReasons } = makeDecision(finalScore, rawProfile, rawOpportunity, profileNorm, signalsForScoring ?? signals)

  // Post-decision guards
  const hasUrl = Boolean(rawOpportunity?.application_url || rawOpportunity?.url)

  if (decision === 'ACCEPT' && !hasUrl) {
    decision = 'REVIEW'
    explanation = 'Downgraded from ACCEPT — missing application URL.'
    decisionReasons = [...decisionReasons, 'Missing application URL']
  }
  // With soft inference, needCategories is never truly empty (normalizeProfile guarantees at
  // least one inferred need). Only downgrade when needAlignment is 0 AND the profile has no
  // entity type, location, or flags — i.e., a genuinely blank profile.
  const profileIsGenuinelyBlank = (profileNorm?.needCategories?.length ?? 0) === 0 &&
    !profileNorm?.entityType && !profileNorm?.state && !profileNorm?.zip
  if (decision === 'ACCEPT' && needAlignment === 0 && profileIsGenuinelyBlank) {
    decision = 'REVIEW'
    explanation = 'Downgraded from ACCEPT — no profile data to align with.'
    decisionReasons = [...decisionReasons, 'Zero need alignment with blank profile']
  }

  // Eligibility
  let eligible = 'maybe'
  const ineligibilityReasons = []
  if (decision === 'REJECT' && decisionReasons.length > 0) {
    eligible = false
    ineligibilityReasons.push(...decisionReasons)
  } else if (decision === 'ACCEPT') {
    eligible = true
  }

  // Confidence
  let confidence = 50
  if (eligible === true) confidence += 30
  if (eligible === false) confidence -= 20
  if (matchedNeeds.length > 0) confidence += Math.min(15, matchedNeeds.length * 5)
  confidence = Math.max(0, Math.min(100, confidence))

  // ── Free, keyless verification influence (ProPublica + Census) ──
  // Pure + synchronous: reads a `verification` signal ATTACHED EARLIER during
  // async discovery/normalization enrichment (no network in this hot loop).
  // Conservative + honest: a verified tax-exempt sponsor nudges confidence up;
  // an org-targeted row the IRS registry actively said is NOT a listed
  // tax-exempt entity is gently down-weighted — NEVER hard-rejected, and the
  // adjustment is ZERO whenever the API did not answer (verified == null).
  const verificationSignal = rawOpportunity?.verification ?? null
  if (verificationSignal) {
    const orgTargeted = verificationTargetsOrganizations(oppNorm)
    const adj = verificationMatchAdjustment(verificationSignal, { orgTargeted })
    if (adj.scoreDelta !== 0 && decision !== 'REJECT') {
      finalScore = Math.round(Math.max(0, Math.min(100, finalScore + adj.scoreDelta)))
      if (match_explain?.scoreBreakdown) match_explain.scoreBreakdown.total = finalScore
    }
    if (adj.confidenceDelta !== 0) {
      confidence = Math.max(0, Math.min(100, confidence + adj.confidenceDelta))
    }
    if (adj.reasons.length > 0) reasons.push(...adj.reasons)
  }

  const matchedProfileTraits = match_explain?.matchedSignals ?? []
  // Surface the profile fields that, if provided, would strengthen this match.
  // Previously hardcoded to [] on the ACCEPT/REVIEW path, which silently dropped
  // the "what's missing from your profile" guidance for non-rejected matches
  // (it was only ever populated on the REJECT branch). (Mission System 3.)
  const missingEligibilityFields = eligibilityEval.missingFields ?? []

  // matched_profile_facts: a plain-language list of what specifically about
  // the profile caused this opportunity to surface. Used by Anya, the result
  // card, and the parity test as the canonical "why this matched" payload.
  // Mission rule: "every displayed match should be able to answer 'what facts
  // from my profile caused this to appear?'".
  const matchedProfileFacts = []
  if (Array.isArray(matchedNeeds)) {
    for (const need of matchedNeeds) {
      if (need) matchedProfileFacts.push(`Need: ${need}`)
    }
  }
  if (Array.isArray(matchedProfileTraits)) {
    for (const sig of matchedProfileTraits) {
      if (sig) matchedProfileFacts.push(`Profile signal: ${sig}`)
    }
  }
  if (profileNorm?.state) matchedProfileFacts.push(`Profile state: ${profileNorm.state}`)
  if (profileNorm?.zip) matchedProfileFacts.push(`Profile ZIP: ${profileNorm.zip}`)
  if (profileNorm?.entityType) matchedProfileFacts.push(`Applicant type: ${profileNorm.entityType}`)

  return {
    score: finalScore,
    reasons,
    match_explain,
    decision,
    explanation,
    eligible,
    ineligibilityReasons,
    matchedNeeds,
    matchedProfileTraits,
    matched_profile_facts: matchedProfileFacts,
    missingEligibilityFields,
    needAlignment,
    confidence,
    // Surface the verification signal (if any was attached during discovery)
    // so it is OBSERVABLE downstream (Sam diagnostics / Anya tools), per the
    // agent-observability rule.
    verification: verificationSignal ?? null,
    matcherVersion: MATCHER_VERSION,
    evaluatedAt: new Date().toISOString(),
  }
}

export default {
  MATCHER_VERSION,
  scoreOpportunity,
  matchOpportunities,
  makeDecision,
  computeMatchDecision,
  calculateConfidence,
  confidenceBand,
}
