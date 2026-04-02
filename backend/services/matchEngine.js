/**
 * matchEngine.js — Canonical Matching Engine (v3.0.0)
 *
 * Single source of truth for matching profiles to funding opportunities.
 * Combines deterministic score computation (from matchingEngine.js) with
 * eligibility-based decision logic (from matchDecisionEngine.js).
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

import { safeParseArrayField, resolveApplicantType, buildProfileSignals } from './profileHelpers.js'
import { normalizeProfile } from './profileNormalizer.js'
import { normalizeOpportunity } from './opportunityNormalizer.js'

export { normalizeProfile, computeProfileFingerprint } from './profileNormalizer.js'
export { normalizeOpportunity, computeOpportunityFingerprint } from './opportunityNormalizer.js'

export const MATCHER_VERSION = '3.0.0'

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
  if (profileNeeds.length === 0) return { score: 0, matchedNeeds: [] }
  if (oppNeeds.length === 0) return { score: 25, matchedNeeds: [] }
  const matchedNeeds = profileNeeds.filter((n) => oppNeeds.includes(n))
  const profileCoverage = matchedNeeds.length / profileNeeds.length
  const oppCoverage = matchedNeeds.length / Math.max(oppNeeds.length, 1)
  const score = Math.min(100, Math.round(((profileCoverage + oppCoverage) / 2) * 100))
  return { score, matchedNeeds }
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
const RE_STUDENT_ONLY = /\bstudents?\s+only\b|\bfor\s+students?\s+only\b/i
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
// scoreOpportunity — deterministic scoring
// ---------------------------------------------------------------------------

/**
 * Score a single opportunity against a profile.
 *
 * @param {Object} profile      - Raw profile OR profileContext { profile, sections, signals, facets }
 * @param {Object} opportunity  - Raw opportunity object
 * @returns {{ score: number, reasons: string[], match_explain: object }}
 */
export function scoreOpportunity(profile, opportunity) {
  // Resolve profileContext vs plain profile
  const profileContext =
    profile && typeof profile === 'object' && profile.profile && profile.sections ? profile : null
  const effectiveProfile = profileContext?.profile ?? profile
  const effectiveSignals =
    profileContext?.signals ??
    (profileContext?.sections
      ? buildProfileSignals({ profile: effectiveProfile, sections: profileContext.sections })
      : null)
  const effectiveFacets = profileContext?.facets ?? null

  const reasons = []
  let score = 0
  const oppText = `${opportunity?.title || ''} ${opportunity?.description || ''} ${opportunity?.sponsor || ''}`.toLowerCase()

  // ── Geographic match (expand outward: ZIP → county → city → state → national) ──
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

  let geoTier = null
  let geoPoints = 0

  if (!profileZip && !profileCounty && !profileCity && !profileState) {
    geoTier = 'unknown'
    geoPoints = -5
  } else if (profileZip && oppZip && String(profileZip).trim() === String(oppZip).trim()) {
    geoTier = 'zip'
    geoPoints = 25
  } else if (profileCounty && oppCounty && normalizeCounty(oppCounty) === normalizeCounty(profileCounty)) {
    geoTier = 'county'
    geoPoints = 22
  } else if (
    profileCity &&
    typeof profileCity === 'string' &&
    typeof opportunity?.description === 'string' &&
    normalizeString(opportunity.description).includes(normalizeString(profileCity))
  ) {
    geoTier = 'city'
    geoPoints = 20
  } else if (profileState && oppState && normalizeState(oppState) === normalizeState(profileState)) {
    geoTier = 'state'
    geoPoints = 18
  } else if (oppIsNational) {
    geoTier = 'national'
    geoPoints = 8
  } else if (profileState && oppState && normalizeState(oppState) !== normalizeState(profileState)) {
    geoTier = 'mismatch'
    geoPoints = -20
  } else {
    geoTier = 'mismatch'
    geoPoints = -2
  }

  score += geoPoints
  if (geoTier === 'zip') reasons.push('Geography: ZIP match')
  else if (geoTier === 'county') reasons.push('Geography: County match')
  else if (geoTier === 'city') reasons.push('Geography: City match (text)')
  else if (geoTier === 'state') reasons.push('Geography: State match')
  else if (geoTier === 'national') reasons.push('National eligibility')
  else if (geoTier === 'unknown') reasons.push('Location unknown — cannot verify geographic eligibility')
  else if (geoTier === 'mismatch') reasons.push('Geography mismatch (soft penalty)')

  // ── Applicant type match (25 pts) ──
  const applicantTypesSet =
    effectiveSignals?.applicantTypes && typeof effectiveSignals.applicantTypes[Symbol.iterator] === 'function'
      ? new Set(Array.from(effectiveSignals.applicantTypes).map((v) => String(v).toLowerCase()))
      : null
  const profileType = resolveApplicantType(effectiveProfile)
  const hasApplicantTypeSignals = Boolean(profileType) || Boolean(applicantTypesSet?.size)

  if (hasApplicantTypeSignals && eligibilityMatchesApplicantType(opportunity, effectiveSignals ?? effectiveProfile)) {
    score += 25
    reasons.push('Applicant type match')
  } else if (!hasApplicantTypeSignals) {
    reasons.push('Applicant type unknown (no penalty)')
  }

  // ── Keyword overlap (up to 25 pts) ──
  const keywordScore = calculateKeywordOverlap(effectiveSignals ?? effectiveProfile, opportunity)
  score += keywordScore
  if (keywordScore > 0) reasons.push(`Keyword match (${keywordScore} pts)`)

  // ── Category match (up to 20 pts) ──
  const categoryScore = calculateCategoryMatch(effectiveSignals ?? effectiveProfile, opportunity)
  score += categoryScore
  if (categoryScore > 0) reasons.push(`Category match (${categoryScore} pts)`)

  // ── Facet alignment ──
  const facetAdjustments = calculateFacetAdjustments({ facets: effectiveFacets, opportunity, oppText })
  score += facetAdjustments.points
  reasons.push(...facetAdjustments.reasons)

  // ── Cross-category mismatch penalties ──
  const profileTypeNorm = normalizeString(profileType || '')
  const isStudentType = ['student', 'high_school_student', 'college_student'].includes(profileTypeNorm)
  const isBusinessType = ['small_business'].includes(profileTypeNorm)
  const isOrgType = ['organization', 'nonprofit'].includes(profileTypeNorm)
  const isIndividualFamilyType = ['individual', 'individual_need', 'family', 'medical_assistance'].includes(profileTypeNorm)

  if (!isStudentType && RE_UNIVERSITY_PROGRAM.test(oppText)) {
    score -= 40
    reasons.push('Cross-category penalty: university/college program for non-student profile (-40)')
  }

  // Check disaster profile from both profile tags (effectiveProfile) and signals/facets.
  // -40 applies when profile-level tags clearly exclude disaster context;
  // -30 applies when signal/facet tags are also absent (belt-and-suspenders).
  const isDisasterProfile =
    (Array.isArray(effectiveProfile?.tags) && effectiveProfile.tags.some((t) => RE_DISASTER_SIGNAL.test(String(t)))) ||
    profileTypeNorm === 'disaster_survivor'
  const hasDisasterSignal =
    isDisasterProfile ||
    (Array.isArray(effectiveFacets?.tags) && effectiveFacets.tags.some((t) => RE_DISASTER_SIGNAL.test(String(t)))) ||
    (Array.isArray(effectiveSignals?.tags) && effectiveSignals.tags.some((t) => RE_DISASTER_SIGNAL.test(String(t)))) ||
    (effectiveProfile?.primary_type || '').toLowerCase() === 'disaster_survivor'

  if (!hasDisasterSignal && RE_FEMA_DISASTER.test(oppText)) {
    // Stronger penalty when neither profile nor any signal layer indicates disaster context
    score -= 40
    reasons.push('Cross-category penalty: FEMA/disaster program for non-disaster profile (-40)')
  } else if (!isDisasterProfile && hasDisasterSignal && RE_FEMA_DISASTER_STRICT.test(oppText)) {
    // Softer penalty when signals are ambiguous (partial disaster indicators only)
    score -= 30
    reasons.push('Cross-category penalty: FEMA/disaster program for non-disaster profile (-30)')
  }

  const hasVetFacet = effectiveFacets?.military?.veteran === true || effectiveFacets?.military?.disabled_veteran === true
  if (!hasVetFacet && RE_VETERAN_SPECIFIC.test(oppText)) {
    score -= 15
    reasons.push('Cross-category penalty: veteran-focused program for non-veteran profile (-15)')
  }

  if (!isBusinessType && !isOrgType && RE_BUSINESS_SBA.test(oppText)) {
    score -= 15
    reasons.push('Cross-category penalty: business/SBA program for non-business profile (-15)')
  }

  if (isIndividualFamilyType && RE_NONPROFIT_ONLY.test(oppText)) {
    score -= 10
    reasons.push('Cross-category penalty: nonprofit-specific program for individual/family profile (-10)')
  }

  // State-name-in-title mismatch penalty
  if (profileState && !oppIsNational) {
    const titleStateAbbr = _extractStateNameFromTitle(opportunity.title || '')
    if (titleStateAbbr) {
      const profileStateNorm = normalizeState(profileState).toUpperCase()
      if (profileStateNorm !== titleStateAbbr.toUpperCase()) {
        score -= 25
        reasons.push(`Cross-category penalty: opportunity title names ${titleStateAbbr}, profile is in ${profileStateNorm} (-25)`)
      }
    }
  }

  // ── Need-to-opportunity alignment (up to 20 pts) ──
  const rawNeeds = safeParseArrayField(effectiveProfile?.needs, [])
  const oppKws = safeParseArrayField(opportunity.keywords, [])
  const oppCats = safeParseArrayField(opportunity.categories, [])
  const allOppSignals = [...oppKws, ...oppCats].map((t) => String(t).toLowerCase())
  if (rawNeeds.length > 0) {
    let needHits = 0
    for (const n of rawNeeds) {
      const nLower = String(n).toLowerCase()
      const synonyms = NEED_SYNONYMS[nLower] || [nLower]
      const matched =
        allOppSignals.some((s) => synonyms.some((syn) => s.includes(syn) || syn.includes(s))) ||
        synonyms.some((syn) => oppText.includes(syn))
      if (matched) needHits++
    }
    if (needHits > 0) {
      const needPts = Math.min(20, Math.round((needHits / rawNeeds.length) * 20))
      score += needPts
      reasons.push(`Need alignment (${needPts} pts for ${needHits}/${rawNeeds.length} needs)`)
    }
  }

  // ── Amount eligibility (10 pts) ──
  if (amountInRange(effectiveProfile?.funding_amount_needed, opportunity)) {
    score += 10
    reasons.push('Amount eligibility')
  }

  // ── Deadline urgency bonus (up to 5 pts) ──
  const deadlineScore = calculateDeadlineUrgency(opportunity)
  score += deadlineScore
  if (deadlineScore > 0) reasons.push(`Deadline urgency (${deadlineScore} pts)`)

  // ── Requirements penalties ──
  const ein = effectiveProfile?.ein ?? effectiveProfile?.uei ?? null
  const applicantTypeNormalized = String(profileType || '').toLowerCase()
  const isOrgLike =
    applicantTypeSetHas(applicantTypesSet, ['organization', 'nonprofit', 'small_business', 'government']) ||
    ['organization', 'nonprofit', 'small_business', 'government'].includes(applicantTypeNormalized)

  if (opportunity.requires_501c3 && isOrgLike && !ein) {
    score -= 15
    reasons.push('Requires 501(c)(3) status (EIN/UEI missing)')
  } else if (opportunity.requires_501c3 && !isOrgLike) {
    reasons.push('501(c)(3) requirement not applicable to profile type')
  }

  if (opportunity.requires_match) {
    score -= 10
    reasons.push(`Requires matching funds (${opportunity.match_percentage || '?'}%)`)
  }

  // Loan / credit-repair penalties
  const opportunityType = String(opportunity?.opportunity_type || opportunity?.type || '').toLowerCase()
  if (['loan', 'loan_program', 'microloan'].includes(opportunityType) || /\bloan\b/.test(oppText)) {
    score -= 30
    reasons.push('Loan program penalty (grants prioritized)')
  }
  if (/\bcredit repair\b|\bcredit counseling\b|\bdebt consolidation\b/.test(oppText)) {
    score -= 25
    reasons.push('Credit repair/counseling penalty')
  }

  // ── Pro bono / in-kind scoring ──
  const isProBono = PRO_BONO_OPPORTUNITY_TYPES.has(opportunityType)
  const fundingType = normalizeString(opportunity?.funding_type || '')
  const isServiceType = SERVICE_FUNDING_TYPES.has(fundingType)
  const matchedNeeds = []
  const matchedSignals = []

  if (isProBono || isServiceType) {
    if (opportunity.amount_min == null && opportunity.amount_max == null) {
      score += 5
      reasons.push('Pro bono/in-kind: service value (no cash amount required)')
    }

    const appUrl = normalizeString(opportunity?.application_url || '')
    const srcUrl = normalizeString(opportunity?.source_url || '')
    const hasDirectIntake = /apply|intake|enroll|request|sign.?up|register/i.test(appUrl) || /apply|intake|enroll/i.test(srcUrl)
    const isDirectory = /directory|finder|find-|search|lookup|look-up/i.test(appUrl) || /directory|finder/i.test(srcUrl)

    if (hasDirectIntake) {
      score += 5
      reasons.push('Service specificity: direct intake/application URL (+5)')
    } else if (!isDirectory) {
      score += 2
      reasons.push('Service specificity: program-specific URL (+2)')
    } else {
      score -= 3
      reasons.push('Service specificity: directory page only (-3)')
    }

    const proBonoTermsOnProfile = effectiveSignals?.proBonoTerms ?? new Set()
    if (proBonoTermsOnProfile.size > 0) {
      let proBonoHits = 0
      for (const term of proBonoTermsOnProfile) {
        if (oppText.includes(normalizeString(term))) {
          proBonoHits++
          matchedNeeds.push(term)
        }
      }
      if (proBonoHits > 0) {
        const boost = Math.min(15, proBonoHits * 5)
        score += boost
        reasons.push(`Pro bono need alignment (${proBonoHits} needs matched, +${boost})`)
      }
    }

    const proBonoMismatchTokens = {
      pro_bono: ['legal', 'attorney', 'court', 'eviction', 'tenant'],
      charity_care: ['medical', 'patient', 'copay', 'clinic', 'hospital', 'health'],
      clinic_service: ['clinic', 'health center', 'primary care'],
      training_paid: ['training', 'wioa', 'workforce', 'vocational', 'certification'],
      equipment_donation: ['equipment', 'computer', 'assistive', 'technology'],
    }
    const mismatchTokens = proBonoMismatchTokens[opportunityType] || []
    if (mismatchTokens.length > 0 && proBonoTermsOnProfile.size === 0) {
      const oppHasSpecificFocus = mismatchTokens.some((t) => oppText.includes(t))
      const profileHasMatchingSignals = mismatchTokens.some((t) => {
        const kws = effectiveSignals?.keywordSet ?? new Set()
        return kws.has(t)
      })
      if (oppHasSpecificFocus && !profileHasMatchingSignals) {
        score -= 8
        reasons.push('Pro bono mismatch: service focus does not match profile signals (-8)')
      }
    }
  }

  // Collect matched signals for match_explain
  if (geoTier && geoTier !== 'mismatch' && geoTier !== 'unknown') matchedSignals.push(`geo:${geoTier}`)
  if (hasApplicantTypeSignals && eligibilityMatchesApplicantType(opportunity, effectiveSignals ?? effectiveProfile))
    matchedSignals.push('applicant_type')
  if (keywordScore > 0) matchedSignals.push('keywords')
  if (categoryScore > 0) matchedSignals.push('category')
  if (isProBono) matchedSignals.push(`opportunity_type:${opportunityType}`)
  if (isServiceType) matchedSignals.push(`funding_type:${fundingType}`)

  const finalScore = Math.max(0, Math.min(100, score))

  const match_explain = {
    matchedNeeds: matchedNeeds.length > 0 ? matchedNeeds : undefined,
    matchedSignals,
    scoreBreakdown: {
      geo: geoPoints,
      applicant_type: hasApplicantTypeSignals && eligibilityMatchesApplicantType(opportunity, effectiveSignals ?? effectiveProfile) ? 25 : 0,
      keyword: keywordScore,
      category: categoryScore,
      facet: facetAdjustments.points,
      amount: amountInRange(effectiveProfile?.funding_amount_needed, opportunity) ? 10 : 0,
      deadline: deadlineScore,
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
  const RELAX_THRESHOLDS = [50, 30, 15, 0]

  const passesMin = (results, threshold) => results.filter((r) => r.score >= threshold)

  let results = passesMin(scored, requestedMin)
  let relaxed = null

  if (results.length === 0 && requestedMin > 0) {
    for (const threshold of RELAX_THRESHOLDS) {
      if (threshold >= requestedMin) continue
      results = passesMin(scored, threshold)
      if (results.length > 0) {
        relaxed = { originalMinScore: requestedMin, relaxedTo: threshold }
        break
      }
    }
    if (results.length === 0) results = scored
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
export function makeDecision(score, profile, opportunity) {
  const reasons = []
  const opp = opportunity || {}
  const prof = profile || {}

  const oppText = `${opp.title || ''} ${opp.description || ''}`.toLowerCase()
  const opportunityType = String(opp.opportunity_type || opp.type || '').toLowerCase()
  const profileType = String(
    prof.profile_type || prof.primary_type || prof.applicant_type || '',
  ).toLowerCase()

  const isStudentProfile = ['student', 'high_school_student', 'college_student'].includes(profileType)
  const isVeteran = Boolean(prof.is_veteran || prof.veteran || prof.military_veteran)
  const isNonprofit = Boolean(prof.is_nonprofit || prof.ein || prof.uei || ['nonprofit', 'organization'].includes(profileType))
  const isBusiness = ['small_business', 'business'].includes(profileType) || Boolean(prof.is_business)
  const isIndividual = ['individual', 'individual_need', 'family', 'medical_assistance'].includes(profileType)

  const isIndividualOrCaregiver = isIndividual || profileType === 'caregiver'
  const isResearcher = profileType === 'researcher'
  const profNeeds = safeParseArrayField(prof.needs, []).map((n) => String(n).toLowerCase())

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

  // Score-based decision
  if (score >= 60) {
    reasons.push(`Score ${score} ≥ 60 — strong match`)
    return { decision: 'ACCEPT', explanation: `Score ${score}/100 indicates a strong match.`, reasons }
  }

  if (score >= 30) {
    reasons.push(`Score ${score} ≥ 30 — possible match`)
    return { decision: 'REVIEW', explanation: `Score ${score}/100 warrants review; moderate match signals.`, reasons }
  }

  reasons.push(`Score ${score} < 30 — insufficient match`)
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

  // Normalize for eligibility checks
  const profileNorm = rawProfile?.entityType !== undefined
    ? rawProfile
    : normalizeProfile(rawProfile, opts.profileSections)
  const oppNorm = rawOpportunity?.entityTypesAllowed !== undefined
    ? rawOpportunity
    : normalizeOpportunity(rawOpportunity)

  // Scoring via scoreOpportunity — pass sections so geo/signals can be resolved
  const profileForScoring = opts.profileSections
    ? { profile: rawProfile, sections: opts.profileSections }
    : rawProfile
  const { score, reasons, match_explain } = scoreOpportunity(profileForScoring, rawOpportunity)

  // Decision via makeDecision
  let { decision, explanation, reasons: decisionReasons } = makeDecision(score, rawProfile, rawOpportunity)

  // Need alignment from normalised objects
  let needAlignment = 0
  let matchedNeeds = []
  if (profileNorm && oppNorm) {
    const profileNeeds = profileNorm?.needCategories ?? []
    const oppNeeds = oppNorm?.needTypesSupported ?? []
    if (profileNeeds.length === 0) {
      needAlignment = 0
    } else if (oppNeeds.length === 0) {
      needAlignment = 25
    } else {
      const matched = profileNeeds.filter((n) => oppNeeds.includes(n))
      matchedNeeds = matched
      const profileCoverage = matched.length / profileNeeds.length
      const oppCoverage = matched.length / Math.max(oppNeeds.length, 1)
      needAlignment = Math.min(100, Math.round(((profileCoverage + oppCoverage) / 2) * 100))
    }
  }

  // Post-decision guards
  const hasUrl = Boolean(rawOpportunity?.application_url || rawOpportunity?.url)
  const profileHasNeeds = (profileNorm?.needCategories?.length ?? 0) > 0

  if (decision === 'ACCEPT' && !hasUrl) {
    decision = 'REVIEW'
    explanation = 'Downgraded from ACCEPT — missing application URL.'
    decisionReasons = [...decisionReasons, 'Missing application URL']
  }
  if (decision === 'ACCEPT' && needAlignment === 0 && !profileHasNeeds) {
    decision = 'REVIEW'
    explanation = 'Downgraded from ACCEPT — no profile needs to align with.'
    decisionReasons = [...decisionReasons, 'Zero need alignment with empty profile needs']
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
