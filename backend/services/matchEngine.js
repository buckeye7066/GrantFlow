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
import {
  SCORE_FLOOR,
  W_NEED, W_ELIGIBILITY, W_GEO, W_CATEGORY,
  DEFAULT_MIN_SCORE, RELAX_THRESHOLDS, FALLBACK_TOP_N,
  ACCEPT_SCORE, REVIEW_SCORE,
  DECISION_ACCEPT_MIN, DECISION_CONFIDENCE_MIN,
} from '../config/matchThresholds.js'

export { normalizeProfile, computeProfileFingerprint } from './profileNormalizer.js'
export { normalizeOpportunity, computeOpportunityFingerprint } from './opportunityNormalizer.js'

export const MATCHER_VERSION = '4.0.0'

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
// Eligibility evaluation
// ---------------------------------------------------------------------------

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
  if (oppNorm.requiresStudent && !profileNorm.isStudent) ineligibilityReasons.push('Requires student status')
  if (oppNorm.requiresNonprofit && !profileNorm.isNonprofit) ineligibilityReasons.push('Requires 501(c)(3) or nonprofit status')
  if (oppNorm.requiresBusiness && !profileNorm.isBusiness) ineligibilityReasons.push('Requires business or self-employment')

  if (oppNorm.isInstitutionalOnly || oppNorm.isResearchOnly) {
    const isOrdinaryIndividual = !profileNorm.isNonprofit && !profileNorm.isBusiness &&
      profileNorm.entityType !== 'researcher' && profileNorm.entityType !== 'organization'
    if (isOrdinaryIndividual) {
      ineligibilityReasons.push('Opportunity is for institutions or research organizations only')
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
    if (profileNorm.state && profileNorm.state !== geo.state) {
      ineligibilityReasons.push(`Geographic mismatch: opportunity is for ${geo.state}, profile is in ${profileNorm.state}`)
    } else if (!profileNorm.state && !profileNorm.zip) {
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
    const hasLoc = Boolean(profileNorm?.state || profileNorm?.zip)
    const hasEntity = Boolean(profileNorm?.entityType)
    const richness = Math.min(100, profileNeeds.length * 18 + (hasLoc ? 14 : 0) + (hasEntity ? 10 : 0))
    const score = Math.min(92, Math.round(34 + richness * 0.55))
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
  medical: ['health', 'medical', 'healthcare', 'hospital', 'prescription', 'dental', 'vision'],
  disability: ['disability', 'disabled', 'accessible', 'accommodation', 'mobility'],
  transportation: ['transportation', 'transit', 'bus', 'vehicle', 'rideshare', 'car'],
  education: ['education', 'tuition', 'scholarship', 'school', 'college', 'university', 'academic'],
  childcare: ['childcare', 'daycare', 'preschool', 'child care', 'children'],
  financial_assistance: ['financial', 'assistance', 'emergency', 'cash', 'payment', 'aid'],
  clothing_goods: ['clothing', 'clothes', 'furniture', 'goods', 'household', 'material'],
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
const RE_STUDENT_ONLY = /\bstudents?\s+only\b|\bfor\s+students?\s+only\b|\bfor\s+enrolled\s+students?\b|\benrolled\s+students?\s+(?:at|in|of)\b/i
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

function normalizeState(value) {
  if (!value) return ''
  const s = String(value).toLowerCase().trim()
  if (STATE_MAPPING[s]) return STATE_MAPPING[s].toUpperCase()
  const sanitized = s.replace(/[^a-z]/g, '')
  return sanitized.length === 2 ? sanitized.toUpperCase() : sanitized.toUpperCase()
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

const _regexCache = new Map()

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
    individual_need: ['individual', 'person', 'resident', 'household'],
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
    console.log('[matchEngine] facet adjustments', {
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
 * Geographic relevance (0-100 subscale).
 * Missing profile location → 35 (neutral baseline, not penalty).
 * State mismatch → 10 (reduced, never zero).
 */
function scoreGeoComponent(effectiveProfile, effectiveSignals, opportunity) {
  const profileLocation = effectiveSignals?.location || {}
  const profileZip = profileLocation?.zip ?? effectiveProfile?.postal_code ?? effectiveProfile?.zip_code ?? null
  const profileCounty = profileLocation?.county ?? null
  const profileCity = profileLocation?.city ?? effectiveProfile?.city ?? null
  const profileState = profileLocation?.state ?? effectiveProfile?.state ?? null

  const oppState = opportunity?.state ?? null
  const oppZip = opportunity?.geo_zip ?? null
  const oppCounty = opportunity?.geo_county ?? null
  const oppIsNational =
    Boolean(opportunity?.is_national) ||
    String(oppState || '').toLowerCase() === 'nationwide'

  let tier = 'none'
  let subscale = 35

  if (!profileZip && !profileCounty && !profileCity && !profileState) {
    tier = 'unknown'
    subscale = 35
  } else if (profileZip && oppZip && String(profileZip).trim() === String(oppZip).trim()) {
    tier = 'zip'
    subscale = 100
  } else if (profileZip && oppZip) {
    // Distance-aware proximity scoring for non-exact ZIP matches.
    // Uses haversine to compute actual distance and assigns proportional score:
    //   ≤ 25mi → 95-85 (local), ≤ 50mi → 84-75 (expanded), > 50mi → falls through
    const dist = _zipDistanceMiles(profileZip, oppZip)
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
    } else if (profileState && oppState && normalizeState(oppState) === normalizeState(profileState)) {
      tier = 'state'
      subscale = 75
    } else if (oppIsNational) {
      tier = 'national'
      subscale = 55
    } else if (profileState && oppState && normalizeState(oppState) !== normalizeState(profileState)) {
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
  } else if (profileState && oppState && normalizeState(oppState) === normalizeState(profileState)) {
    tier = 'state'
    subscale = 75
  } else if (oppIsNational) {
    tier = 'national'
    subscale = 55
  } else if (profileState && oppState && normalizeState(oppState) !== normalizeState(profileState)) {
    tier = 'mismatch'
    subscale = 10
  } else {
    tier = 'soft_mismatch'
    subscale = 30
  }

  // State-name-in-title mismatch: reduce but don't zero out
  if (profileState && !oppIsNational && tier !== 'mismatch') {
    const titleStateAbbr = _extractStateNameFromTitle(opportunity?.title || '')
    if (titleStateAbbr) {
      const profileStateNorm = normalizeState(profileState).toUpperCase()
      if (profileStateNorm !== titleStateAbbr.toUpperCase()) {
        subscale = Math.max(10, Math.round(subscale * 0.35))
        tier = 'title_state_mismatch'
      }
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
  const rawNeeds = safeParseArrayField(effectiveProfile?.needs, [])
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
      const needPct = needHits / needTotal
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
 * Eligibility match component (0-100 subscale).
 * Checks applicant type match, demographic alignment, requirements compatibility.
 * Missing type → 45 baseline (neutral). Penalties are proportional, never zero.
 */
function scoreEligibilityComponent(effectiveProfile, effectiveSignals, effectiveFacets, opportunity, profileNorm) {
  const oppText = `${opportunity?.title || ''} ${opportunity?.description || ''} ${opportunity?.sponsor || ''}`.toLowerCase()
  const reasons = []
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
    subscale -= 10
    reasons.push('Type mismatch (soft)')
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
    subscale += demoBonus
    if (demoBonus > 0) reasons.push(`Demo/affil +${demoBonus}`)
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
    if (opportunity?.amount_min == null && opportunity?.amount_max == null) {
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
 * Empty categories → 30 baseline (neutral).
 */
function scoreCategoryComponent(effectiveProfile, effectiveSignals, opportunity) {
  const reasons = []
  const categoryRaw = calculateCategoryMatch(effectiveSignals ?? effectiveProfile, opportunity)
  let subscale = 30

  if (categoryRaw > 0) {
    subscale = 30 + Math.round((categoryRaw / 20) * 60)
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

  return { subscale: Math.min(100, Math.max(10, subscale)), reasons, categoryRaw, deadlineScore }
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
export function scoreOpportunity(profile, opportunity) {
  const profileContext =
    profile && typeof profile === 'object' && profile.profile && profile.sections ? profile : null
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
  let rawScore = Math.round(
    need.subscale * W_NEED +
    elig.subscale * W_ELIGIBILITY +
    geo.subscale * W_GEO +
    cat.subscale * W_CATEGORY,
  )

  // ── Profile depth bonus: richer profiles get up to 10% boost ──
  const depth = measureProfileDepth(effectiveProfile, effectiveSignals, profileNorm)
  const depthMultiplier = 1.0 + Math.min(0.10, depth / 1000)
  rawScore = Math.round(rawScore * depthMultiplier)

  // ── Housing-aware signal bonuses ──
  // These apply AFTER the weighted combination so they can push a strong match over thresholds
  // without distorting the base component model.
  const housingBonusReasons = []

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

  // Tennessee location boost: profile is in TN + opportunity is TN-specific
  const profileState = profileNorm?.state ?? effectiveProfile?.state ?? null
  if (profileState && normalizeState(profileState) === 'TN') {
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

  // Collect matched signals for match_explain
  const matchedSignals = []
  const matchedNeeds = []
  if (geo.tier && geo.tier !== 'mismatch' && geo.tier !== 'unknown' && geo.tier !== 'soft_mismatch' && geo.tier !== 'title_state_mismatch')
    matchedSignals.push(`geo:${geo.tier}`)
  if (elig.applicantTypeMatch) matchedSignals.push('applicant_type')
  if (need.keywordRaw > 0) matchedSignals.push('keywords')
  if (cat.categoryRaw > 0) matchedSignals.push('category')

  const opportunityType = String(opportunity?.opportunity_type || opportunity?.type || '').toLowerCase()
  const fundingType = normalizeString(opportunity?.funding_type || '')
  if (PRO_BONO_OPPORTUNITY_TYPES.has(opportunityType)) matchedSignals.push(`opportunity_type:${opportunityType}`)
  if (SERVICE_FUNDING_TYPES.has(fundingType)) matchedSignals.push(`funding_type:${fundingType}`)

  const match_explain = {
    matchedNeeds: matchedNeeds.length > 0 ? matchedNeeds : undefined,
    matchedSignals,
    housingSignals: housingBonusReasons.length > 0 ? housingBonusReasons : undefined,
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
      housing_signal_bonus: housingBonusReasons.length > 0 ? rawScore - (rawScore - housingBonusReasons.reduce(() => 0, 0)) : 0,
      total: finalScore,
    },
    reasons: reasons.length > 0 ? reasons : ['No specific matches found'],
  }

  return {
    score: finalScore,
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
 * @returns {Array} Opportunities sorted by score desc, each augmented with score/reasons/match_explain.
 *                  result._relaxed is set when the threshold was relaxed.
 */
export function matchOpportunities(profile, opportunities, opts = {}) {
  if (!Array.isArray(opportunities) || opportunities.length === 0) return []

  const scored = opportunities.map((opp) => {
    const { score, reasons, match_explain } = scoreOpportunity(profile, opp)
    return { ...opp, score, reasons, match_explain }
  })

  scored.sort((a, b) => b.score - a.score)

  const requestedMin = typeof opts.minScore === 'number' ? opts.minScore : 0
  const relaxSteps = [DEFAULT_MIN_SCORE, ...RELAX_THRESHOLDS]

  const passesMin = (results, threshold) => results.filter((r) => r.score >= threshold)

  let results = passesMin(scored, requestedMin)
  let relaxed = null

  if (results.length === 0 && requestedMin > 0) {
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
export function makeDecision(score, profile, opportunity, normalizedProfile = null) {
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
    reasons.push('Student-only program; profile is not a student')
    return { decision: 'REJECT', explanation: 'Opportunity requires student status.', reasons }
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

  // Geographic hard mismatch — state-specific opportunity for a profile in a different state
  const profState = String(prof.state || '').trim()
  const oppStateRaw = String(opp.state || '').trim()
  const oppIsNational = Boolean(opp.is_national) || oppStateRaw.toLowerCase() === 'nationwide'
  if (profState && oppStateRaw && !oppIsNational) {
    const pNorm = normalizeState(profState)
    const oNorm = normalizeState(oppStateRaw)
    if (pNorm && oNorm && pNorm !== oNorm) {
      reasons.push(`Geographic mismatch — opportunity is in ${oppStateRaw}, profile is in ${profState}`)
      return { decision: 'REJECT', explanation: `Geographic mismatch: opportunity is restricted to ${oppStateRaw}.`, reasons }
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

  reasons.push(`Score ${score} < ${REVIEW_SCORE} — insufficient match`)
  return { decision: 'REJECT', explanation: `Score ${score}/100 indicates insufficient match.`, reasons }
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

  // Normalize for eligibility checks — pass signals so inferred needs are merged
  const profileNorm = rawProfile?.entityType !== undefined
    ? rawProfile
    : normalizeProfile(rawProfile, opts.profileSections, signals)
  const oppNorm = rawOpportunity?.entityTypesAllowed !== undefined
    ? rawOpportunity
    : normalizeOpportunity(rawOpportunity)

  // Pass sections to scoreOpportunity so it can build signals (geo, keywords, etc.)
  const profileForScoring = opts.profileSections
    ? { profile: rawProfile, sections: opts.profileSections }
    : rawProfile
  const { score, reasons, match_explain } = scoreOpportunity(profileForScoring, rawOpportunity)

  // Decision via makeDecision — pass normalizedProfile so section-derived flags are used
  let { decision, explanation, reasons: decisionReasons } = makeDecision(score, rawProfile, rawOpportunity, profileNorm)

  // Need alignment from normalised objects (uses calculateNeedAlignment for consistency)
  const { score: needAlignment, matchedNeeds } = calculateNeedAlignment(profileNorm, oppNorm)

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

  const matchedProfileTraits = match_explain?.matchedSignals ?? []
  const missingEligibilityFields = []

  return {
    score,
    reasons,
    match_explain,
    decision,
    explanation,
    eligible,
    ineligibilityReasons,
    matchedNeeds,
    matchedProfileTraits,
    missingEligibilityFields,
    needAlignment,
    confidence,
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
}
