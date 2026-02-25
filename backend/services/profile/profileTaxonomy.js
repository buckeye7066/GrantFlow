import { createRequire } from 'node:module'
import zipcodes from 'zipcodes'
import { resolveCountyForZip } from '../geo/zipCountyResolver.js'

const require = createRequire(import.meta.url)
const schema = require('./applicationSchema.json')

const CANONICAL_SECTION_KEYS = Array.isArray(schema?.canonical_section_keys)
  ? schema.canonical_section_keys
  : []
const FALLBACK_SECTION_KEYS = Array.isArray(schema?.fallback_section_keys)
  ? schema.fallback_section_keys
  : ['comprehensive_application']
const ALL_SCHEMA_SECTION_KEYS = new Set([...CANONICAL_SECTION_KEYS, ...FALLBACK_SECTION_KEYS])
const FIELD_DEFINITIONS = Array.isArray(schema?.fields) ? schema.fields : []

const STATE_NAME_TO_CODE = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
  'district of columbia': 'DC',
}

const TOKEN_SPLIT = /[^a-z0-9]+/gi
const REQUIRED_FACETS = [
  'profile.primary_profile_type',
  'geo.state_or_zip',
  'intent.primary_need_category',
]
const INTENT_MUST_NOT_CONFIDENCE_THRESHOLD = 0.7

/*
 * Section inventory (Phase 0 mapping from current seed/write paths)
 * -----------------------------------------------------------------
 * basic_information: full_name, email, phone, website, address, city, state, zip, date_of_birth, age, gender, profile_category, notes
 * organization_details: organization_type, mission, ein, uei, cage_code, annual_budget, staff_count, city, state, zip
 * financial_information: household_income, household_size, financial_need_level, low_income, unemployed, displaced_worker, notes
 * government_assistance: medicaid_enrolled, medicaid_waiver_program, ecf_choices_role, medicare_recipient, ssi_recipient, ssdi_recipient, snap_recipient, tanf_recipient, section8_housing, other_programs, tenncare_id
 * health_medical: conditions, disability_type, support_needs, support_needs_level, consent_for_studies, mental_health_condition, chronic_illness, substance_recovery, neurodivergent, visual_impairment, hearing_impairment, notes
 * demographics: african_american, hispanic_latino, asian_american, native_american, tribal_affiliation, lgbtq, immigrant_status, notes
 * family_life: single_parent, foster_youth, caregiver, homeless, domestic_violence_survivor, trafficking_survivor, formerly_incarcerated, notes
 * military_service: veteran, active_duty_military, national_guard, disabled_veteran, military_spouse, military_dependent, gold_star_family, notes
 * occupation: healthcare_worker, healthcare_worker_type, educator, nonprofit_employee, small_business_owner, public_servant, job_title, industry
 * location_focus: rural_resident, appalachian_region, urban_underserved, geographic_focus, notes
 * narrative: mission, primary_goal, target_population, geographic_focus, funding_amount_needed, timeline, past_experience, unique_qualities, collaboration_partners, sustainability_plan, barriers_faced, special_circumstances
 * university_applications: applications[]
 * education: highest_level, current_institution, target_colleges, intended_major, gpa, act_score, sat_score, notes
 * fallback comprehensive_application: applicant_type, state, zip, city, financial_need_level, program flags, narrative, keywords/focus_areas, tenncare_id
 */

function normalizeString(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase()
}

function toArray(value) {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined) return []
  return [value]
}

function isPlainObject(value) {
  return Boolean(value) && Object.prototype.toString.call(value) === '[object Object]'
}

function isEmptyValue(value) {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  if (isPlainObject(value)) return Object.keys(value).length === 0
  return false
}

function normalizeState(value) {
  const raw = normalizeString(value)
  if (!raw) return null
  const maybeCode = raw.toUpperCase().replace(/[^A-Z]/g, '')
  if (maybeCode.length === 2) return maybeCode
  const byName = STATE_NAME_TO_CODE[raw.toLowerCase()]
  return byName ?? null
}

function normalizeZip(value) {
  const raw = normalizeString(value)
  if (!raw) return null
  const match = raw.match(/(\d{5})/)
  return match ? match[1] : null
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value > 0
  if (typeof value !== 'string') return null
  const s = value.trim().toLowerCase()
  if (['true', 'yes', 'y', '1'].includes(s)) return true
  if (['false', 'no', 'n', '0', ''].includes(s)) return false
  return null
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizeConfidence(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  if (number <= 0) return 0
  if (number >= 1) return 1
  return number
}

function uniqueStrings(values = []) {
  const out = []
  const seen = new Set()
  for (const value of values) {
    const normalized = normalizeString(typeof value === 'string' ? value : String(value ?? ''))
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}

function tokenizeText(values = []) {
  const phrases = []
  for (const value of values) {
    if (!value) continue
    const s =
      typeof value === 'string'
        ? value
        : value && typeof value === 'object' && typeof value.name === 'string'
        ? value.name
        : String(value)
    if (!s) continue
    const parts = s
      .split(/[\n,;|]+/)
      .map((x) => x.trim())
      .filter(Boolean)
    for (const part of parts) phrases.push(part)
  }
  const tokens = []
  for (const phrase of phrases) {
    const normalized = phrase.toLowerCase()
    if (normalized.length >= 3) tokens.push(normalized)
    normalized
      .split(TOKEN_SPLIT)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .forEach((token) => tokens.push(token))
  }
  return uniqueStrings(tokens)
}

function getValuesAtPath(value, path) {
  if (!path || !value) return []
  const segments = String(path).split('.').filter(Boolean)
  if (segments.length === 0) return []

  function walk(current, idx) {
    if (current === null || current === undefined) return []
    if (idx >= segments.length) return [current]

    const segment = segments[idx]
    const isArraySegment = segment.endsWith('[]')
    const key = isArraySegment ? segment.slice(0, -2) : segment
    const next = key ? current?.[key] : current

    if (next === null || next === undefined) return []
    if (isArraySegment) {
      if (!Array.isArray(next)) return []
      const out = []
      for (const entry of next) out.push(...walk(entry, idx + 1))
      return out
    }
    return walk(next, idx + 1)
  }

  return walk(value, 0)
}

function setDeep(target, path, value) {
  if (!path) return
  const segments = String(path).split('.').filter(Boolean)
  if (segments.length === 0) return
  let cursor = target
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]
    if (!isPlainObject(cursor[segment])) cursor[segment] = {}
    cursor = cursor[segment]
  }
  const last = segments[segments.length - 1]
  const existing = cursor[last]
  if (Array.isArray(existing) && Array.isArray(value)) {
    cursor[last] = uniqueStrings([...existing, ...value])
    return
  }
  if (Array.isArray(existing) && value !== null && value !== undefined) {
    cursor[last] = uniqueStrings([...existing, String(value)])
    return
  }
  if (Array.isArray(value)) {
    cursor[last] = uniqueStrings(value)
    return
  }
  cursor[last] = value
}

function getDeep(target, path) {
  const segments = String(path || '').split('.').filter(Boolean)
  let cursor = target
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined
    cursor = cursor[segment]
  }
  return cursor
}

function parseSectionPath(path, defaultSectionKey) {
  const raw = normalizeString(path)
  if (!raw) return null
  const pieces = raw.split('.')
  const first = pieces[0]
  if (ALL_SCHEMA_SECTION_KEYS.has(first)) {
    return { sectionKey: first, path: pieces.slice(1).join('.') }
  }
  return { sectionKey: defaultSectionKey, path: raw }
}

function normalizeFieldValue(field, rawValues) {
  const values = rawValues.filter((entry) => !isEmptyValue(entry))
  if (values.length === 0) return null
  const type = String(field?.type || '').toLowerCase()

  if (type === 'boolean') {
    for (const value of values) {
      const normalized = normalizeBoolean(value)
      if (normalized !== null) return normalized
    }
    return null
  }
  if (type === 'number') {
    for (const value of values) {
      const normalized = normalizeNumber(value)
      if (normalized !== null) return normalized
    }
    return null
  }
  if (type === 'zip5') {
    for (const value of values) {
      const normalized = normalizeZip(value)
      if (normalized) return normalized
    }
    return null
  }
  if (type === 'state_code') {
    for (const value of values) {
      const normalized = normalizeState(value)
      if (normalized) return normalized
    }
    return null
  }
  if (type === 'string_array') {
    const flattened = []
    for (const value of values) {
      if (Array.isArray(value)) {
        flattened.push(...value)
        continue
      }
      if (value && typeof value === 'object' && typeof value.name === 'string') {
        flattened.push(value.name)
        continue
      }
      if (typeof value === 'string') {
        const parts = value
          .split(/[\n,;|]+/)
          .map((x) => x.trim())
          .filter(Boolean)
        if (parts.length > 0) flattened.push(...parts)
        else flattened.push(value)
        continue
      }
      flattened.push(String(value))
    }
    return uniqueStrings(flattened)
  }
  if (type === 'enum') {
    const first = values.find((value) => !isEmptyValue(value))
    if (first === undefined) return null
    const normalized = normalizeLower(first).replace(/\s+/g, '_')
    return normalized || null
  }
  if (type === 'string') {
    const first = values.find((value) => !isEmptyValue(value))
    if (first === undefined) return null
    if (typeof first === 'string') return normalizeString(first) || null
    if (first && typeof first === 'object' && typeof first.name === 'string') return normalizeString(first.name) || null
    return normalizeString(String(first)) || null
  }

  const first = values.find((value) => !isEmptyValue(value))
  return first === undefined ? null : first
}

function normalizeContext(profileContext) {
  const base =
    profileContext &&
    typeof profileContext === 'object' &&
    profileContext.profile &&
    typeof profileContext.profile === 'object'
      ? profileContext
      : { profile: profileContext ?? {} }
  const profile = base.profile ?? {}
  const sections =
    (isPlainObject(base.sections) ? base.sections : null) ??
    (isPlainObject(profile.sections) ? profile.sections : null) ??
    {}

  return {
    profile,
    sections,
    signals: base.signals ?? profile.signals ?? null,
    organization: base.organization ?? null,
    location: base.location ?? null,
    facets: isPlainObject(base.facets) ? base.facets : null,
    coverage: isPlainObject(base.coverage) ? base.coverage : null,
    trace: isPlainObject(base.trace) ? base.trace : null,
  }
}

function mapBasicInformation(section = {}) {
  const mapped = { ...(isPlainObject(section) ? section : {}) }
  if (!mapped.zip && mapped.zip_code) mapped.zip = mapped.zip_code
  if (!mapped.zip && mapped.postal_code) mapped.zip = mapped.postal_code
  if (!mapped.state && mapped.address_state) mapped.state = mapped.address_state
  if (!mapped.city && mapped.address_city) mapped.city = mapped.address_city
  return mapped
}

function mapOrganizationDetails(section = {}) {
  const mapped = { ...(isPlainObject(section) ? section : {}) }
  if (!mapped.zip && mapped.hq_zip) mapped.zip = mapped.hq_zip
  if (!mapped.organization_type && mapped.type) mapped.organization_type = mapped.type
  return mapped
}

function mapEducation(section = {}) {
  const mapped = { ...(isPlainObject(section) ? section : {}) }
  if (!mapped.current_institution && mapped.current_college) mapped.current_institution = mapped.current_college
  if (!mapped.intended_major && mapped.field_of_study) mapped.intended_major = mapped.field_of_study
  return mapped
}

function mapFamilyLife(section = {}) {
  const mapped = { ...(isPlainObject(section) ? section : {}) }
  if (mapped.former_incarcerated === true && mapped.formerly_incarcerated !== true) {
    mapped.formerly_incarcerated = true
  }
  return mapped
}

function mapOccupation(section = {}) {
  const mapped = { ...(isPlainObject(section) ? section : {}) }
  if (mapped.is_minority_owned_business_owner === true && mapped.minority_owned_business !== true) {
    mapped.minority_owned_business = true
  }
  if (mapped.is_women_owned_business_owner === true && mapped.women_owned_business !== true) {
    mapped.women_owned_business = true
  }
  return mapped
}

const passthrough = (section = {}) => (isPlainObject(section) ? { ...section } : {})

export const SECTION_MAPPERS = Object.freeze({
  basic_information: mapBasicInformation,
  organization_details: mapOrganizationDetails,
  financial_information: passthrough,
  government_assistance: passthrough,
  health_medical: passthrough,
  demographics: passthrough,
  family_life: mapFamilyLife,
  military_service: passthrough,
  occupation: mapOccupation,
  location_focus: passthrough,
  narrative: passthrough,
  university_applications: passthrough,
  education: mapEducation,
  nonprofit_compliance: passthrough,
  small_business_details: passthrough,
  medical_insurance: passthrough,
  medical_history: passthrough,
  employment: passthrough,
  housing: passthrough,
  family: passthrough,
  programs_services: passthrough,
  comprehensive_application: passthrough,
})

function extractFieldValue(field, sectionsByKey) {
  const rawValues = []
  const sourceSectionKey = normalizeString(field?.source_section_key)
  const sourcePaths = toArray(field?.source_path).filter((entry) => normalizeString(entry))
  const fallbackPaths = toArray(field?.fallback_source_path).filter((entry) => normalizeString(entry))

  if (sourceSectionKey && sourcePaths.length > 0) {
    for (const sourcePath of sourcePaths) {
      const parsed = parseSectionPath(sourcePath, sourceSectionKey)
      if (!parsed?.sectionKey || !parsed.path) continue
      const section = sectionsByKey[parsed.sectionKey]
      rawValues.push(...getValuesAtPath(section, parsed.path))
    }
  }
  if (fallbackPaths.length > 0) {
    for (const fallbackPath of fallbackPaths) {
      const parsed = parseSectionPath(fallbackPath, sourceSectionKey || null)
      if (!parsed?.sectionKey || !parsed.path) continue
      const section = sectionsByKey[parsed.sectionKey]
      rawValues.push(...getValuesAtPath(section, parsed.path))
    }
  }
  return normalizeFieldValue(field, rawValues)
}

function resolveGeo({ facets }) {
  const zip = normalizeZip(getDeep(facets, 'geo.zip'))
  let state = normalizeState(getDeep(facets, 'geo.state'))
  if (!state && zip) {
    try {
      const lookup = zipcodes.lookup(zip)
      if (lookup?.state) state = normalizeState(lookup.state)
      if (!getDeep(facets, 'geo.city') && lookup?.city) {
        setDeep(facets, 'geo.city', normalizeString(lookup.city))
      }
    } catch {
      // no-op
    }
  }
  if (state) setDeep(facets, 'geo.state', state)
  if (zip) setDeep(facets, 'geo.zip', zip)

  if (!getDeep(facets, 'geo.county') && zip) {
    try {
      const county = resolveCountyForZip(zip, state || null)
      if (county) setDeep(facets, 'geo.county', county)
    } catch {
      // no-op
    }
  }
}

function addIntentKeywords(seed = [], additions = []) {
  return uniqueStrings([...seed, ...additions])
}

function deriveIntent({ facets }) {
  const profileType = normalizeLower(getDeep(facets, 'profile.primary_profile_type'))
  const profileApplicantTypes = Array.isArray(getDeep(facets, 'profile.applicant_types'))
    ? getDeep(facets, 'profile.applicant_types').map((value) => normalizeLower(value))
    : []
  const gpaValue = getDeep(facets, 'education.gpa')
  const hasGpaValue = gpaValue !== null && gpaValue !== undefined
  const occupation = getDeep(facets, 'occupation') || {}
  const assistance = getDeep(facets, 'assistance') || {}
  const health = getDeep(facets, 'health') || {}
  const family = getDeep(facets, 'family') || {}
  const military = getDeep(facets, 'military') || {}
  const narrativeValues = [
    getDeep(facets, 'narrative.primary_goal'),
    getDeep(facets, 'narrative.target_population'),
    getDeep(facets, 'narrative.geographic_focus'),
    ...(Array.isArray(getDeep(facets, 'narrative.keywords')) ? getDeep(facets, 'narrative.keywords') : []),
    getDeep(facets, 'assistance.other_programs'),
    getDeep(facets, 'organization.organization_type'),
  ]
  const textTokens = tokenizeText(narrativeValues)
  const tokenSet = new Set(textTokens)
  const tokenHits = (needles = []) =>
    needles.reduce((count, needle) => (tokenSet.has(needle) ? count + 1 : count), 0)
  const hasProfileApplicantType = (needle) =>
    profileType.includes(needle) || profileApplicantTypes.some((entry) => entry.includes(needle))

  const businessTokenHits = tokenHits([
    'business',
    'startup',
    'entrepreneur',
    'food truck',
    'mobile food',
    'vendor',
    'cooperative',
  ])
  const studentTokenHits = tokenHits(['student', 'college', 'scholarship', 'tuition', 'education'])
  const disabilityTokenHits = tokenHits(['disability', 'accessible', 'assistive', 'special needs', 'autism'])
  const healthTokenHits = tokenHits(['health', 'medical', 'treatment', 'copay', 'patient', 'care'])
  const housingTokenHits = tokenHits(['housing', 'eviction', 'rent', 'shelter', 'section8', 'section 8'])
  const veteranTokenHits = tokenHits(['veteran', 'military', 'service member', 'va'])
  const foodTokenHits = tokenHits(['food', 'food bank', 'food pantry', 'nutrition'])
  const transportTokenHits = tokenHits(['transportation', 'van', 'vehicle', 'bus'])

  const hasBusinessSignals =
    occupation.small_business_owner === true ||
    textTokens.some((token) =>
      ['business', 'startup', 'entrepreneur', 'food_truck', 'food truck', 'mobile food', 'vendor', 'cooperative'].includes(
        token,
      ),
    )
  const hasStudentSignals =
    hasProfileApplicantType('student') ||
    hasGpaValue ||
    Boolean(getDeep(facets, 'education.intended_major'))
  const hasHousingSignals =
    family.homeless === true ||
    textTokens.some((token) => ['housing', 'eviction', 'rent', 'shelter', 'section8', 'section 8'].includes(token))
  const hasHealthSignals =
    health.chronic_illness === true ||
    health.mental_health_condition === true ||
    health.neurodivergent === true ||
    Boolean(Array.isArray(health.conditions) && health.conditions.length > 0)
  const hasDisabilitySignals =
    Boolean(Array.isArray(health.disability_types) && health.disability_types.length > 0) ||
    health.visual_impairment === true ||
    health.hearing_impairment === true
  const hasFoodSignals =
    assistance.snap_recipient === true ||
    textTokens.some((token) => ['food', 'food bank', 'food pantry', 'nutrition'].includes(token))
  const hasVeteranSignals = military.veteran === true || military.disabled_veteran === true
  const hasTeacherSignals = occupation.educator === true || textTokens.includes('teacher')
  const hasNurseSignals =
    occupation.healthcare_worker === true &&
    textTokens.some((token) => ['nursing', 'nurse', 'nclex', 'licensure', 'license'].includes(token))
  const hasTransportSignals = textTokens.some((token) => ['transportation', 'van', 'vehicle', 'bus'].includes(token))

  let category = 'general_assistance'
  if (hasBusinessSignals) category = 'business_startup'
  else if (hasStudentSignals) category = 'education'
  else if (hasDisabilitySignals) category = 'disability_support'
  else if (hasHealthSignals) category = 'healthcare_support'
  else if (hasHousingSignals) category = 'housing_stability'
  else if (hasVeteranSignals) category = 'veteran_support'
  else if (hasFoodSignals) category = 'food_security'
  else if (hasTransportSignals) category = 'transportation_access'
  else if (!profileType && textTokens.length === 0) category = 'unknown'

  // Foolproof: when category would be unknown, infer from profile type so crawlers always get usable intent.
  if (category === 'unknown' && profileType) {
    if (profileType.includes('business') || profileType.includes('small_business')) category = 'business_startup'
    else if (profileType.includes('student') || profileType.includes('college') || profileType.includes('school'))
      category = 'education'
    else if (profileType.includes('veteran') || profileType.includes('military')) category = 'veteran_support'
    else if (profileType.includes('nonprofit') || profileType.includes('organization')) category = 'general_assistance'
    else category = 'general_assistance'
  }

  const evidenceByCategory = {
    business_startup:
      (occupation.small_business_owner === true ? 1 : 0) +
      (hasProfileApplicantType('business') ? 1 : 0) +
      (businessTokenHits > 0 ? 1 : 0) +
      (businessTokenHits > 2 ? 1 : 0),
    education:
      (hasProfileApplicantType('student') ? 1 : 0) +
      (hasGpaValue ? 1 : 0) +
      (getDeep(facets, 'education.intended_major') ? 1 : 0) +
      (studentTokenHits > 0 ? 1 : 0),
    disability_support: (hasDisabilitySignals ? 1 : 0) + (disabilityTokenHits > 0 ? 1 : 0),
    healthcare_support: (hasHealthSignals ? 1 : 0) + (healthTokenHits > 0 ? 1 : 0),
    housing_stability: (hasHousingSignals ? 1 : 0) + (housingTokenHits > 0 ? 1 : 0),
    veteran_support: (hasVeteranSignals ? 1 : 0) + (veteranTokenHits > 0 ? 1 : 0),
    food_security: (hasFoodSignals ? 1 : 0) + (foodTokenHits > 0 ? 1 : 0),
    transportation_access: (hasTransportSignals ? 1 : 0) + (transportTokenHits > 0 ? 1 : 0),
    general_assistance: textTokens.length > 0 ? 1 : 0,
  }
  const selectedEvidence = evidenceByCategory[category] ?? 0
  const competingStrongCategories = Object.entries(evidenceByCategory).filter(
    ([entryCategory, entryEvidence]) => entryCategory !== category && entryEvidence >= 2,
  ).length

  let confidence = 0
  if (category !== 'unknown') {
    confidence = 0.42 + selectedEvidence * 0.16
    if (textTokens.length >= 3) confidence += 0.06
    if (textTokens.length === 0) confidence -= 0.08
    if (category === 'general_assistance') confidence -= 0.08
    confidence -= competingStrongCategories * 0.1
  }
  const boundedConfidence = Math.round(normalizeConfidence(confidence) * 100) / 100

  let keywords = uniqueStrings(textTokens)
  let negativeKeywords = []

  if (category === 'business_startup') {
    keywords = addIntentKeywords(keywords, ['small business grant', 'startup support'])
    negativeKeywords = addIntentKeywords(negativeKeywords, ['food bank', 'food pantry', 'soup kitchen', 'hunger relief'])
  }
  if (category === 'food_security') {
    keywords = addIntentKeywords(keywords, ['food assistance', 'nutrition support'])
    negativeKeywords = addIntentKeywords(negativeKeywords, ['food truck startup', 'restaurant franchise'])
  }
  if (category === 'education' && hasTeacherSignals) {
    keywords = addIntentKeywords(keywords, ['teacher classroom supplies', 'classroom grant'])
  }
  if (category === 'education' && hasNurseSignals) {
    keywords = addIntentKeywords(keywords, ['nurse licensure training', 'nclex prep', 'nursing scholarship'])
  }
  if (
    normalizeLower(assistance.medicaid_waiver_program) === 'ecf_choices' ||
    normalizeLower(assistance.ecf_choices_role).length > 0
  ) {
    keywords = addIntentKeywords(keywords, [
      'employment and community first choices',
      'ecf choices',
      'home and community based services',
    ])
  }
  if (category === 'unknown') {
    keywords = []
    negativeKeywords = []
  }

  return {
    primary_need_category: category,
    keywords: keywords.slice(0, 32),
    negative_keywords: negativeKeywords.slice(0, 20),
    confidence: boundedConfidence,
    evidence: {
      selected_evidence: selectedEvidence,
      competing_strong_categories: competingStrongCategories,
    },
  }
}

function applyPiiRules({ facets, sectionsByKey, trace }) {
  const piiRules = schema?.pii_rules && typeof schema.pii_rules === 'object' ? schema.pii_rules : {}

  for (const [ruleName, rule] of Object.entries(piiRules)) {
    const candidates = Array.isArray(rule?.input_candidates) ? rule.input_candidates : []
    let raw = null
    let source = null
    for (const candidate of candidates) {
      const parsed = parseSectionPath(candidate, null)
      if (!parsed?.sectionKey || !parsed.path) continue
      const section = sectionsByKey[parsed.sectionKey]
      const values = getValuesAtPath(section, parsed.path).filter((value) => !isEmptyValue(value))
      if (values.length === 0) continue
      raw = values[0]
      source = candidate
      break
    }

    const has = !isEmptyValue(raw)
    const digits = has ? String(raw).replace(/\D/g, '') : ''
    const masked =
      has && digits.length >= 4
        ? `***${digits.slice(-4)}`
        : has
        ? '***'
        : null

    if (rule?.store_boolean_field) setDeep(facets, rule.store_boolean_field, Boolean(has))
    if (rule?.store_masked_last4_field) setDeep(facets, rule.store_masked_last4_field, masked)

    trace.pii[ruleName] = {
      has_value: Boolean(has),
      source_path: source,
    }
  }
}

function computeCoverage({ sectionsByKey, handledSections, unhandledSections, mappedFieldIds, facets }) {
  const relevantFields = FIELD_DEFINITIONS.filter((field) => field?.relevance === true)
  const relevantTotal = relevantFields.length
  const mappedCount = mappedFieldIds.size
  const pct =
    relevantTotal > 0
      ? Math.round((mappedCount / relevantTotal) * 1000) / 10
      : 0

  const canonicalPresent = CANONICAL_SECTION_KEYS.filter((key) => {
    const section = sectionsByKey[key]
    return isPlainObject(section) && Object.keys(section).length > 0
  })
  const signalCoveragePct = canonicalPresent.length > 0 ? Math.max(1, pct) : 0

  const requiredMissing = []
  const profileType = normalizeLower(getDeep(facets, 'profile.primary_profile_type'))
  const state = normalizeState(getDeep(facets, 'geo.state'))
  const zip = normalizeZip(getDeep(facets, 'geo.zip'))
  const primaryNeed = normalizeLower(getDeep(facets, 'intent.primary_need_category'))

  if (!profileType) requiredMissing.push('profile.primary_profile_type')
  if (!state && !zip) requiredMissing.push('geo.state_or_zip')
  if (!primaryNeed || primaryNeed === 'unknown') requiredMissing.push('intent.primary_need_category')

  return {
    handled_sections: handledSections,
    unhandled_sections: unhandledSections,
    required_missing: requiredMissing,
    field_map_coverage: {
      relevant_fields_total: relevantTotal,
      relevant_fields_mapped: mappedCount,
      pct,
      signal_coverage_pct: signalCoveragePct,
      canonical_sections_present: canonicalPresent.length,
    },
    pii_summary: {
      has_ssn: Boolean(getDeep(facets, 'pii.has_ssn')),
      has_medicaid_id: Boolean(getDeep(facets, 'pii.has_medicaid_id')),
    },
  }
}

function buildBaseFacetShape() {
  return {
    profile: {
      primary_profile_type: null,
      applicant_types: [],
    },
    geo: {
      state: null,
      city: null,
      zip: null,
      county: null,
      county_hint: null,
    },
    organization: {
      organization_type: null,
      nonprofit_ready: null,
    },
    financial: {},
    assistance: {},
    demographics: {},
    health: {
      conditions: [],
      disability_types: [],
    },
    family: {},
    military: {},
    occupation: {},
    education: {},
    narrative: {
      keywords: [],
    },
    intent: {
      primary_need_category: 'unknown',
      keywords: [],
      negative_keywords: [],
      confidence: 0,
    },
    pii: {
      has_ssn: false,
      ssn_last4_masked: null,
      has_medicaid_id: false,
      medicaid_id_last4_masked: null,
    },
  }
}

function mergeProfileFallbacks({ normalizedContext, facets }) {
  const profile = normalizedContext.profile ?? {}
  const org = normalizedContext.organization ?? {}
  if (!getDeep(facets, 'profile.primary_profile_type')) {
    const fallbackType = normalizeLower(profile.primary_type || profile.applicant_type || org.organization_type || '')
    if (fallbackType) setDeep(facets, 'profile.primary_profile_type', fallbackType)
  }
  if (!getDeep(facets, 'geo.state')) {
    const state = normalizeState(profile.state || org.state)
    if (state) setDeep(facets, 'geo.state', state)
  }
  if (!getDeep(facets, 'geo.zip')) {
    const zip = normalizeZip(profile.zip_code || profile.postal_code || profile.zip || org.zip || org.postal_code)
    if (zip) setDeep(facets, 'geo.zip', zip)
  }
  if (!getDeep(facets, 'geo.city')) {
    const city = normalizeString(profile.city || org.city)
    if (city) setDeep(facets, 'geo.city', city)
  }
}

function toError({ code, message, details, status = 400 }) {
  const error = new Error(message)
  error.code = code
  error.status = status
  error.details = details
  return error
}

export function buildProfileFacets(profileContext = {}) {
  const normalizedContext = normalizeContext(profileContext)
  const sectionsByKeyRaw = normalizedContext.sections ?? {}
  const sectionsByKey = {}
  const handledSections = []
  const unhandledSections = []

  for (const [sectionKey, sectionData] of Object.entries(sectionsByKeyRaw)) {
    const mapper = SECTION_MAPPERS[sectionKey]
    if (typeof mapper === 'function') {
      sectionsByKey[sectionKey] = mapper(sectionData, { sections: sectionsByKeyRaw })
      handledSections.push(sectionKey)
    } else {
      sectionsByKey[sectionKey] = passthrough(sectionData)
      unhandledSections.push(sectionKey)
    }
  }

  if (!sectionsByKey.comprehensive_application) {
    sectionsByKey.comprehensive_application = {}
  }

  const trace = {
    extracted_fields: [],
    skipped_fields: [],
    pii: {},
    mappers: {
      handled_sections: handledSections.slice(),
      unhandled_sections: unhandledSections.slice(),
    },
  }

  const facets = buildBaseFacetShape()
  const mappedFieldIds = new Set()

  for (const field of FIELD_DEFINITIONS) {
    if (!field || field.relevance !== true) {
      continue
    }
    const value = extractFieldValue(field, sectionsByKey)
    if (isEmptyValue(value)) {
      trace.skipped_fields.push({
        id: field.id,
        reason: 'empty_or_missing',
      })
      continue
    }
    setDeep(facets, field.facet_path, value)
    mappedFieldIds.add(field.id)
    trace.extracted_fields.push({
      id: field.id,
      facet_path: field.facet_path,
      source_section_key: field.source_section_key,
    })
  }

  mergeProfileFallbacks({ normalizedContext, facets })
  resolveGeo({ facets })
  const intent = deriveIntent({ facets })
  setDeep(facets, 'intent.primary_need_category', intent.primary_need_category)
  setDeep(facets, 'intent.keywords', intent.keywords)
  setDeep(facets, 'intent.negative_keywords', intent.negative_keywords)
  setDeep(facets, 'intent.confidence', intent.confidence)
  trace.intent = {
    primary_need_category: intent.primary_need_category,
    confidence: intent.confidence,
    evidence: intent.evidence,
  }

  applyPiiRules({ facets, sectionsByKey, trace })

  const coverage = computeCoverage({
    sectionsByKey,
    handledSections,
    unhandledSections,
    mappedFieldIds,
    facets,
  })

  const enriched = {
    ...normalizedContext,
    sectionsByKey,
    facets,
    coverage,
    trace,
  }

  if (String(process.env.PROFILE_TAXONOMY_DEBUG || '').toLowerCase() === 'true') {
    console.log('[profileTaxonomy] facets built', {
      required_missing: coverage.required_missing,
      mapped_fields: mappedFieldIds.size,
      relevant_fields: coverage.field_map_coverage.relevant_fields_total,
    })
  }

  return enriched
}

export function requireFacets(profileContext, opts = {}) {
  const strict = opts?.strict !== false
  const context =
    profileContext && profileContext.facets && profileContext.coverage
      ? profileContext
      : buildProfileFacets(profileContext)

  const missingMappers = CANONICAL_SECTION_KEYS.filter((sectionKey) => typeof SECTION_MAPPERS[sectionKey] !== 'function')
  if (strict && missingMappers.length > 0) {
    throw toError({
      code: 'PROFILE_TAXONOMY_MAPPER_GAP',
      message: 'One or more canonical profile sections are not mapped in profile taxonomy.',
      status: 500,
      details: { missing_mappers: missingMappers },
    })
  }

  const requiredMissing = Array.isArray(context?.coverage?.required_missing)
    ? context.coverage.required_missing
    : []
  // When strict is false (e.g. crawlers), never throw on missing facets — run with best-effort context.
  if (strict && requiredMissing.length > 0) {
    throw toError({
      code: 'PROFILE_CONTEXT_INCOMPLETE',
      message: `Missing required profile facets: ${requiredMissing.join(', ')}`,
      status: 400,
      details: {
        required_missing: requiredMissing,
        required_for_crawling: REQUIRED_FACETS,
        coverage: context.coverage,
      },
    })
  }

  return context
}

export function buildIntentTokens({ facets } = {}) {
  const category = normalizeLower(facets?.intent?.primary_need_category || '')
  const confidence = normalizeConfidence(facets?.intent?.confidence)
  const allowAggressiveMustNot = confidence >= INTENT_MUST_NOT_CONFIDENCE_THRESHOLD
  const baseKeywords = Array.isArray(facets?.intent?.keywords) ? facets.intent.keywords : []
  const negativeKeywords = Array.isArray(facets?.intent?.negative_keywords)
    ? facets.intent.negative_keywords
    : []

  const mustTerms = []
  const shouldTerms = []
  const mustNotTerms = allowAggressiveMustNot ? [...negativeKeywords] : []

  for (const keyword of baseKeywords) {
    const normalized = normalizeLower(keyword)
    if (!normalized) continue
    if (normalized.includes(' ') && normalized.length >= 5) mustTerms.push(normalized)
    else shouldTerms.push(normalized)
  }

  const categoryExpansions = {
    business_startup: ['small business grant', 'startup', 'entrepreneur'],
    education: ['scholarship', 'tuition assistance', 'classroom grant'],
    disability_support: ['disability support', 'accessible services'],
    healthcare_support: ['medical assistance', 'patient support'],
    housing_stability: ['housing assistance', 'rent support', 'eviction prevention'],
    veteran_support: ['veteran assistance', 'military family support'],
    food_security: ['food assistance', 'nutrition support', 'pantry access'],
    transportation_access: ['transportation assistance', 'vehicle grant'],
  }
  if (category && categoryExpansions[category]) {
    shouldTerms.push(...categoryExpansions[category])
  }

  if (allowAggressiveMustNot && category === 'business_startup' && mustNotTerms.length === 0) {
    mustNotTerms.push('food bank', 'food pantry', 'hunger relief')
  }
  if (allowAggressiveMustNot && category === 'food_security' && mustNotTerms.length === 0) {
    mustNotTerms.push('food truck startup', 'restaurant franchise')
  }

  return {
    mustTerms: uniqueStrings(mustTerms).slice(0, 12),
    shouldTerms: uniqueStrings(shouldTerms).slice(0, 32),
    mustNotTerms: uniqueStrings(mustNotTerms).slice(0, 24),
  }
}

// Backward-compatible alias used by older callers that expect phrase arrays.
export function buildIntentPhrases({ facets } = {}) {
  const tokens = buildIntentTokens({ facets })
  return uniqueStrings([...tokens.mustTerms, ...tokens.shouldTerms]).slice(0, 20)
}