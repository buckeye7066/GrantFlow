/**
 * Match Decision Engine — Single Source of Truth
 *
 * Exports the canonical pipeline used across all insertion paths:
 *   normalizeProfile()       — canonical profile with alias resolution
 *   normalizeOpportunity()   — structured eligibility extraction
 *   evaluateEligibility()    — hard eligibility checks
 *   calculateNeedAlignment() — need-to-funding-type mapping
 *   calculateSourceTrust()   — source quality scoring
 *   computeMatchDecision()   — returns full structured decision object
 *
 * computeMatchDecision() returns:
 * {
 *   eligible: true|false|"maybe",
 *   ineligibilityReasons: string[],
 *   needAlignment: 0..100,
 *   score: 0..100,
 *   confidence: 0..100,
 *   decision: "ACCEPT" | "REVIEW" | "REJECT",
 *   matchedNeeds: string[],
 *   matchedProfileTraits: string[],
 *   missingEligibilityFields: string[],
 *   explanation: string,
 *   matcherVersion: string,
 *   evaluatedAt: ISO timestamp
 * }
 */

export { normalizeProfile, computeProfileFingerprint } from './profileNormalizer.js'
export { normalizeOpportunity, computeOpportunityFingerprint } from './opportunityNormalizer.js'

import { normalizeProfile, computeProfileFingerprint } from './profileNormalizer.js'
import { normalizeOpportunity, computeOpportunityFingerprint } from './opportunityNormalizer.js'

export const MATCHER_VERSION = '2.0.0'

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

/**
 * Calculate source trust score (0-100).
 * Higher = more trustworthy / official.
 */
export function calculateSourceTrust(opportunity) {
  if (!opportunity) return 20

  const url = opportunity.application_url ||
    opportunity.apply_url ||
    opportunity.source_url ||
    opportunity.evidence_url ||
    opportunity.url || ''

  const urlLower = String(url).toLowerCase()

  // No URL at all = low trust
  if (!url || urlLower.trim() === '') return 10

  // Official .gov sources
  if (OFFICIAL_SOURCE_DOMAINS.has(extractDomain(urlLower))) return 95
  if (urlLower.includes('.gov')) return 90
  if (urlLower.includes('.edu')) return 75

  // Trusted intermediaries
  for (const domain of TRUSTED_INTERMEDIARY_DOMAINS) {
    if (urlLower.includes(domain)) return 70
  }

  // Nonprofit (.org) sources
  if (urlLower.includes('.org')) return 60

  // record_origin trust adjustments
  const origin = opportunity.record_origin ?? ''
  if (origin === 'grants_gov' || origin === 'verified_real') return 90
  if (origin === 'curated_verified') return 80
  if (origin === 'curated_benefits' || origin === 'curated_program') return 65
  if (origin === 'live_crawl') return 40

  return 35
}

function extractDomain(url) {
  try {
    const m = url.match(/(?:https?:\/\/)?(?:www\.)?([^/?\s]+)/)
    return m ? m[1] : ''
  } catch { return '' }
}

// ---------------------------------------------------------------------------
// Evaluate eligibility
// ---------------------------------------------------------------------------

/**
 * Evaluate hard eligibility rules.
 *
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

  // -- Loans are never eligible --
  if (oppNorm.isLoan) {
    ineligibilityReasons.push('Opportunity is a loan, not a grant')
  }

  // -- Pro bono / in-kind / referral-only: never direct funding for individual profile pipelines --
  // These are services or referrals, not grants. Hard-reject for all profile types.
  if (oppNorm.isProBono) {
    ineligibilityReasons.push('Opportunity is pro bono services, not a grant or direct funding')
  }
  if (oppNorm.isInKind) {
    ineligibilityReasons.push('Opportunity provides in-kind goods/services, not direct financial assistance')
  }
  if (oppNorm.isReferralOnly) {
    ineligibilityReasons.push('Opportunity is a referral service only, not a direct grant application')
  }

  // -- Closed deadline --
  if (oppNorm.deadlineStatus === 'closed') {
    ineligibilityReasons.push('Application deadline has passed')
  }

  // -- Veteran requirement --
  if (oppNorm.requiresVeteran && !profileNorm.isVeteran) {
    ineligibilityReasons.push('Requires veteran status')
  }

  // -- Student requirement --
  if (oppNorm.requiresStudent && !profileNorm.isStudent) {
    ineligibilityReasons.push('Requires student status')
  }

  // -- Nonprofit requirement --
  if (oppNorm.requiresNonprofit && !profileNorm.isNonprofit) {
    ineligibilityReasons.push('Requires 501(c)(3) or nonprofit status')
  }

  // -- Business requirement --
  if (oppNorm.requiresBusiness && !profileNorm.isBusiness) {
    ineligibilityReasons.push('Requires business or self-employment')
  }

  // -- Institutional / research-only: reject ordinary individuals --
  if (oppNorm.isInstitutionalOnly || oppNorm.isResearchOnly) {
    const isOrdinaryIndividual =
      !profileNorm.isNonprofit &&
      !profileNorm.isBusiness &&
      profileNorm.entityType !== 'researcher' &&
      profileNorm.entityType !== 'organization'
    if (isOrdinaryIndividual) {
      ineligibilityReasons.push('Opportunity is for institutions or research organizations only')
    }
  }

  // -- Disease-specific: reject profiles without corresponding condition --
  if (oppNorm.diseaseSpecific && !profileNorm.hasChronicIllness && !profileNorm.hasDisabilityNeed) {
    ineligibilityReasons.push('Opportunity targets a specific medical condition not indicated in profile')
  }

  // -- Disaster / FEMA context required --
  if (oppNorm.requiresDisasterContext && !profileNorm.hasEmergencyNeed) {
    ineligibilityReasons.push('Opportunity requires disaster or emergency context not present in profile')
  }

  // -- Caregiver program: require caregiver indicators when strictly caregiver-focused --
  if (oppNorm.isCaregiverProgram && !profileNorm.isCaregiver && !profileNorm.hasFosterIndicator) {
    // Soft signal — downgrade but don't hard-reject unless entity types explicitly exclude
    missingFields.push('caregiver_status')
  }

  // -- Workforce/employment training when profile is unable to work --
  if (profileNorm.isUnableToWork && oppNorm.needTypesSupported?.includes('education')) {
    const isWorkforceFocused = oppNorm.needTypesSupported?.every(n => ['education', 'business'].includes(n))
    if (isWorkforceFocused && !oppNorm.needTypesSupported?.includes('disability')) {
      ineligibilityReasons.push('Profile indicates unable to work; workforce training programs not applicable')
    }
  }

  // -- Already-enrolled program check --
  if (profileNorm.enrolledPrograms?.length > 0 && oppNorm.title) {
    const titleLower = (oppNorm.title || '').toLowerCase()
    for (const prog of profileNorm.enrolledPrograms) {
      if (prog === 'medicaid' && (titleLower.includes('medicaid') && (titleLower.includes('contact') || titleLower.includes('enroll')))) {
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

  // -- Children-required programs for childless households --
  if (oppNorm.needTypesSupported?.includes('family_life') && oppNorm.title) {
    const titleLower = (oppNorm.title || '').toLowerCase()
    const isChildSpecific = titleLower.includes('head start') || titleLower.includes('child care') ||
      titleLower.includes('wic') || titleLower.includes('children')
    if (isChildSpecific && profileNorm.householdHasChildren === false && 
        (profileNorm.ageGroup || '').toLowerCase().includes('senior')) {
      ineligibilityReasons.push('Program requires children in household; profile is a childless senior household')
    }
  }

  // -- Refugee/resettlement programs for non-refugees --
  if (oppNorm.title) {
    const titleLower = (oppNorm.title || '').toLowerCase()
    const isRefugeeProgram = titleLower.includes('refugee') || titleLower.includes('resettlement')
    if (isRefugeeProgram && !profileNorm.isRefugee) {
      ineligibilityReasons.push('Program is for refugees/resettlement; profile has no refugee indicator')
    }
  }

  // -- DME / equipment mismatch: profile lacks disability/medical need --
  if (oppNorm.isDmeOrEquipment && !profileNorm.hasDisabilityNeed && !profileNorm.hasChronicIllness) {
    // Not a hard reject (someone could have need not yet noted), but flag missing data
    missingFields.push('disability_or_medical_need_for_equipment')
  }

  // -- Entity type mismatch --
  // When allowed types don't include 'individual', check if profile's specific trait
  // flags qualify it (e.g., a veteran whose entityType is 'individual' still qualifies
  // for veteran-only opportunities when isVeteran=true).
  const allowedTypes = oppNorm.entityTypesAllowed ?? []
  if (allowedTypes.length > 0 && !allowedTypes.includes('individual')) {
    const profileType = profileNorm.entityType
    if (profileType && !allowedTypes.includes(profileType)) {
      // Don't reject if the profile's specific trait flags cover what's required
      const qualifiesByTrait = (
        (allowedTypes.includes('veteran') && profileNorm.isVeteran) ||
        (allowedTypes.includes('student') && profileNorm.isStudent) ||
        (allowedTypes.includes('nonprofit') && profileNorm.isNonprofit) ||
        (allowedTypes.includes('business') && profileNorm.isBusiness) ||
        (allowedTypes.includes('caregiver') && profileNorm.isCaregiver)
      )
      if (!qualifiesByTrait && profileType !== 'organization') {
        ineligibilityReasons.push(
          `Opportunity is for ${allowedTypes.join('/')} but profile is ${profileType}`
        )
      }
    }
  }

  // -- Geographic mismatch --
  const geo = oppNorm.geography ?? {}
  if (!geo.isNational && geo.state) {
    if (profileNorm.state && profileNorm.state !== geo.state) {
      ineligibilityReasons.push(
        `Geographic mismatch: opportunity is for ${geo.state}, profile is in ${profileNorm.state}`
      )
    } else if (!profileNorm.state && !profileNorm.zip) {
      missingFields.push('profile_location')
    }
  }

  // -- Missing eligibility data --
  if (!profileNorm.entityType) missingFields.push('entity_type')
  if (!oppNorm.hasApplicationUrl) missingFields.push('application_url')

  const hardIneligible = ineligibilityReasons.length > 0
  const hasMissingData = missingFields.length > 0

  let eligible
  if (hardIneligible) {
    eligible = false
  } else if (hasMissingData) {
    eligible = 'maybe'
  } else {
    eligible = true
  }

  return { eligible, ineligibilityReasons, missingFields }
}

// ---------------------------------------------------------------------------
// Calculate need alignment
// ---------------------------------------------------------------------------

/**
 * Calculate how well the opportunity's supported need types match
 * the profile's need categories.
 *
 * @param {Object} profileNorm - From normalizeProfile()
 * @param {Object} oppNorm     - From normalizeOpportunity()
 * @returns {{ score: 0..100, matchedNeeds: string[] }}
 */
export function calculateNeedAlignment(profileNorm, oppNorm) {
  const profileNeeds = profileNorm?.needCategories ?? []
  const oppNeeds = oppNorm?.needTypesSupported ?? []

  if (profileNeeds.length === 0) {
    return { score: 0, matchedNeeds: [] }
  }

  // When the opportunity has no explicit need types declared, give a baseline score
  // as a benefit of the doubt — many legitimate general-assistance programs don't
  // enumerate need types, but are still relevant for any profile with needs.
  // Score of 25 is chosen to produce a composite score around 40-50 for trusted sources,
  // which is enough to surface as REVIEW without falsely inflating low-quality matches.
  if (oppNeeds.length === 0) {
    return { score: 25, matchedNeeds: [] }
  }

  const matchedNeeds = profileNeeds.filter((n) => oppNeeds.includes(n))

  // Exact matches get full credit; partial overlap scales down
  const score = Math.round((matchedNeeds.length / Math.max(profileNeeds.length, 1)) * 100)

  return { score: Math.min(100, score), matchedNeeds }
}

// ---------------------------------------------------------------------------
// Compute full match decision
// ---------------------------------------------------------------------------

/**
 * Compute the full match decision for a profile + opportunity pair.
 *
 * Accepts raw profile/opportunity objects and normalizes them internally,
 * OR pre-normalized objects (detected by presence of .entityType / .entityTypesAllowed).
 *
 * @param {Object} rawProfile    - Raw profile (or pre-normalized)
 * @param {Object} rawOpportunity - Raw opportunity (or pre-normalized)
 * @param {Object} [opts]
 * @param {Object} [opts.profileSections] - Profile sections for richer normalization
 * @returns {Object} Full structured decision
 */
export function computeMatchDecision(rawProfile, rawOpportunity, opts = {}) {
  // Normalize inputs (detect if already normalized)
  const profileNorm = rawProfile?.entityType !== undefined
    ? rawProfile
    : normalizeProfile(rawProfile, opts.profileSections)

  const oppNorm = rawOpportunity?.entityTypesAllowed !== undefined
    ? rawOpportunity
    : normalizeOpportunity(rawOpportunity)

  if (!profileNorm || !oppNorm) {
    return {
      eligible: 'maybe',
      ineligibilityReasons: ['Could not normalize profile or opportunity'],
      needAlignment: 0,
      score: 0,
      confidence: 0,
      decision: 'REVIEW',
      matchedNeeds: [],
      matchedProfileTraits: [],
      missingEligibilityFields: ['profile', 'opportunity'],
      explanation: 'Insufficient data to evaluate match.',
      matcherVersion: MATCHER_VERSION,
      evaluatedAt: new Date().toISOString(),
    }
  }

  // Step 1: Evaluate eligibility
  const { eligible, ineligibilityReasons, missingFields } = evaluateEligibility(profileNorm, oppNorm)

  // Step 2: Calculate need alignment
  const { score: needAlignmentScore, matchedNeeds } = calculateNeedAlignment(profileNorm, oppNorm)

  // Step 3: Source trust
  const sourceTrust = calculateSourceTrust(rawOpportunity)

  // Step 4: Matched profile traits
  const matchedProfileTraits = []
  if (profileNorm.isVeteran && oppNorm.entityTypesAllowed?.includes('veteran')) {
    matchedProfileTraits.push('veteran')
  }
  if (profileNorm.isStudent && oppNorm.entityTypesAllowed?.includes('student')) {
    matchedProfileTraits.push('student')
  }
  if (profileNorm.isNonprofit && oppNorm.entityTypesAllowed?.includes('nonprofit')) {
    matchedProfileTraits.push('nonprofit')
  }
  if (profileNorm.isBusiness && oppNorm.entityTypesAllowed?.includes('business')) {
    matchedProfileTraits.push('business')
  }
  // Individual/family match: applies when profile is individual/caregiver and the
  // opportunity either explicitly targets individuals/families or has unknown applicability
  // (many consumer-facing programs don't enumerate entity types but are intended for individuals).
  const isIndividualOrFamily = ['individual', 'caregiver'].includes(profileNorm.entityType)
  if (
    isIndividualOrFamily &&
    (oppNorm.entityTypesAllowed?.includes('individual') ||
      oppNorm.entityTypesAllowed?.includes('caregiver') ||
      oppNorm.applicabilityUnknown)
  ) {
    matchedProfileTraits.push('individual_match')
  }
  // Geographic match trait
  const geo = oppNorm.geography ?? {}
  if (geo.isNational && profileNorm.state) matchedProfileTraits.push('national_eligible')
  else if (geo.state && profileNorm.state === geo.state) matchedProfileTraits.push('state_match')

  // Step 5: Composite score
  // Weights: need alignment 45%, source trust 25%, entity type match 20%, geo bonus 10%
  // Individual/family match earns a smaller bonus (15 pts) since it's a less specific match
  // than veteran/student/nonprofit/business targeting.
  let entityTypeBonus = 0
  if (matchedProfileTraits.some(t => ['veteran', 'student', 'nonprofit', 'business'].includes(t))) {
    entityTypeBonus = 20
  } else if (matchedProfileTraits.includes('individual_match')) {
    entityTypeBonus = 15
  }
  const geoBonus = matchedProfileTraits.some(t => ['national_eligible', 'state_match'].includes(t)) ? 10 : 0
  const rawScore = (needAlignmentScore * 0.45) + (sourceTrust * 0.25) + entityTypeBonus + geoBonus
  const score = Math.min(100, Math.round(rawScore))

  // Step 6: Confidence
  let confidence = 50
  if (eligible === true) confidence += 30
  if (eligible === false) confidence -= 20
  if (matchedNeeds.length > 0) confidence += Math.min(15, matchedNeeds.length * 5)
  if (missingFields.length > 0) confidence -= missingFields.length * 5
  if (sourceTrust >= 80) confidence += 5
  confidence = Math.max(0, Math.min(100, confidence))

  // Step 7: Decision
  // ACCEPT requires: eligible=true, score≥40, needAlignment>0 OR baseline (25), hasApplicationUrl, confidence≥50
  // For individual/family profiles, applicabilityUnknown is treated as a soft match (not forced REVIEW)
  // since many consumer-facing assistance programs don't specify an entity type restriction.
  let decision
  if (eligible === false) {
    decision = 'REJECT'
  } else if (
    eligible === 'maybe' ||
    missingFields.length > 2 ||
    (oppNorm.applicabilityUnknown && !isIndividualOrFamily)
  ) {
    decision = 'REVIEW'
  } else if (score < 40 || needAlignmentScore === 0) {
    decision = 'REVIEW'
  } else if (!oppNorm.hasApplicationUrl) {
    // No actionable application path → downgrade to REVIEW
    decision = 'REVIEW'
  } else if (confidence < 50) {
    // Insufficient confidence → REVIEW
    decision = 'REVIEW'
  } else {
    decision = 'ACCEPT'
  }

  // Step 8: Human-readable explanation
  const explanationParts = []
  if (matchedNeeds.length > 0) {
    explanationParts.push(`Matches needs: ${matchedNeeds.join(', ')}.`)
  }
  if (matchedProfileTraits.length > 0) {
    explanationParts.push(`Profile traits matched: ${matchedProfileTraits.join(', ')}.`)
  }
  if (ineligibilityReasons.length > 0) {
    explanationParts.push(`Ineligibility: ${ineligibilityReasons.join('; ')}.`)
  }
  if (missingFields.length > 0) {
    explanationParts.push(`Missing data: ${missingFields.join(', ')}.`)
  }
  if (oppNorm.applicabilityUnknown && !isIndividualOrFamily) {
    explanationParts.push('Opportunity applicability is unclear; conservative REVIEW applied.')
  } else if (oppNorm.applicabilityUnknown && isIndividualOrFamily) {
    explanationParts.push('Opportunity applicability unspecified; assumed eligible for individual/family.')
  }
  if (!oppNorm.hasApplicationUrl && decision !== 'REJECT') {
    explanationParts.push('No application URL found; cannot confirm actionability.')
  }
  if (explanationParts.length === 0) {
    explanationParts.push(decision === 'ACCEPT'
      ? 'Opportunity appears relevant to this profile.'
      : 'Insufficient need alignment detected.')
  }
  const explanation = explanationParts.join(' ')

  return {
    eligible,
    ineligibilityReasons,
    needAlignment: needAlignmentScore,
    score,
    confidence,
    decision,
    matchedNeeds,
    matchedProfileTraits,
    missingEligibilityFields: missingFields,
    explanation,
    matcherVersion: MATCHER_VERSION,
    evaluatedAt: new Date().toISOString(),
  }
}
