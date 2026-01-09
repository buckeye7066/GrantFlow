function safeParseJSON(value, fallback) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch (error) {
    console.warn('[profileHelpers] Failed to parse JSON', error)
    return fallback
  }
}

/**
 * Safely parse array fields that may be JSON arrays or comma-separated strings
 * Handles:
 * - JSON arrays: ["item1", "item2"]
 * - Comma-separated strings: "item1,item2,item3"
 * - Already parsed arrays: ["item1", "item2"]
 * - null/undefined/empty values
 */
export function safeParseArrayField(value, fallback = []) {
  if (!value) return fallback
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        return Array.isArray(parsed) ? parsed : fallback
      } catch {
        // Fall through to comma-split
      }
    }
    // Handle comma-separated strings
    return trimmed.split(',').map(s => s.trim()).filter(Boolean)
  }
  return fallback
}

export function loadProfileContext(db, profileId) {
  const profile = db
    .prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1')
    .get(profileId)
  if (!profile) {
    throw new Error(`Profile ${profileId} not found`)
  }

  const sections = db
    .prepare(
      `
      SELECT section_key, data
      FROM profile_sections
      WHERE profile_id = ?
    `,
    )
    .all(profileId)
    .reduce((acc, row) => {
      acc[row.section_key] = safeParseJSON(row.data, {})
      return acc
    }, {})

  // Use safeParseArrayField for array fields
  const tags = safeParseArrayField(profile.tags, [])
  const interests = safeParseArrayField(profile.interests, [])
  
  const signals = buildProfileSignals({ 
    profile: { ...profile, tags, interests }, 
    sections 
  })

  return { 
    profile: { ...profile, tags, interests }, 
    sections, 
    signals 
  }
}

export function extractZipFromContext({ profile, sections, jobParameters = {} }) {
  const candidates = [
    jobParameters.zip,
    jobParameters.primary_zip,
    sections?.basic_information?.zip,
    sections?.basic_information?.postal_code,
    sections?.basic_information?.address_zip,
    sections?.location_focus?.primary_zip,
    sections?.location_focus?.service_zip,
    sections?.location_focus?.zip,
    sections?.organization_details?.zip,
    sections?.organization_details?.hq_zip,
    profile?.postal_code,
  ]

  const zip = candidates.find(
    (value) => typeof value === 'string' && /^\d{5}$/.test(value.trim()),
  )

  return zip?.trim() ?? null
}

export function extractStateFromContext({ profile, sections, jobParameters = {} }) {
  const candidates = [
    jobParameters.state,
    sections?.basic_information?.state,
    sections?.basic_information?.address_state,
    sections?.location_focus?.state,
    sections?.location_focus?.primary_state,
    sections?.organization_details?.state,
    profile?.state,
  ]

  const state = candidates
    .map((value) =>
      typeof value === 'string' && value.trim().length === 2
        ? value.trim().toUpperCase()
        : null,
    )
    .find(Boolean)

  return state ?? null
}

export function extractStudentCampusZip({ sections, jobParameters = {} }) {
  const candidates = [
    jobParameters.campus_zip,
    sections?.education?.campus_zip,
    sections?.education?.planned_campus_zip,
    sections?.education?.target_school_zip,
  ]

  const zip = candidates.find(
    (value) => typeof value === 'string' && /^\d{5}$/.test(value.trim()),
  )

  return zip?.trim() ?? null
}

export function getAssistanceFlags(sections = {}) {
  const assistance = sections.government_assistance ?? {}
  return {
    lowIncome:
      assistance.snap_recipient ||
      assistance.tanf_recipient ||
      assistance.section8_housing ||
      assistance.other_programs,
    veteran: sections.military_service?.veteran ?? false,
    disabled:
      assistance.ssi_recipient ||
      assistance.ssdi_recipient ||
      sections.health_medical?.disability_type?.length > 0 ||
      sections.health_medical?.wheelchair_user ||
      sections.health_medical?.visual_impairment ||
      sections.health_medical?.hearing_impairment ||
      sections.health_medical?.chronic_illness ||
      sections.health_medical?.mental_health_condition,
    student: ['student', 'high_school_student', 'college_student'].includes(
      sections.basic_information?.profile_category ??
        sections.organization_details?.organization_type ??
        '',
    ),
  }
}

const GENDER_SYNONYMS = {
  female: ['female', 'woman', 'women', 'girl', 'girls', 'female-led', 'female identifying'],
  male: ['male', 'man', 'men', 'boy', 'boys'],
  nonbinary: ['nonbinary', 'non-binary', 'genderqueer', 'gender nonconforming', 'non conforming'],
}

const DEMOGRAPHIC_SYNONYMS = {
  african_american: ['african american', 'black', 'black american'],
  hispanic_latino: ['hispanic', 'latino', 'latina', 'latinx'],
  asian_american: ['asian american', 'asian', 'pacific islander', 'aapi'],
  native_american: ['native american', 'indigenous', 'tribal'],
  lgbtq: ['lgbtq', 'queer', 'gay', 'lesbian', 'transgender', 'trans'],
  immigrant: ['immigrant', 'refugee', 'foreign-born', 'new american'],
}

const ASSISTANCE_SYNONYMS = {
  low_income: ['low income', 'need-based', 'economic hardship', 'income eligible'],
  homeless: ['homeless', 'housing insecure'],
  ssi_recipient: ['ssi', 'supplemental security income'],
  ssdi_recipient: ['ssdi', 'social security disability'],
  snap_recipient: ['snap', 'food stamps'],
  tanf_recipient: ['tanf', 'temporary assistance for needy families'],
  section8_housing: ['section 8', 'housing voucher'],
}

const MILITARY_FLAGS = {
  veteran: ['veteran', 'military veteran'],
  active_duty_military: ['active duty', 'currently serving'],
  national_guard: ['national guard', 'guard'],
  disabled_veteran: ['disabled veteran'],
  military_spouse: ['military spouse'],
  military_dependent: ['military dependent'],
  gold_star_family: ['gold star family'],
}

const TOKEN_SPLIT_REGEX = /[^a-z0-9]+/gi

function normalizeString(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

function addKeyword(set, value) {
  const normalized = normalizeString(value)
  if (!normalized) return
  set.add(normalized)
  normalized
    .split(TOKEN_SPLIT_REGEX)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .forEach((token) => set.add(token))
}

function addMultipleKeywords(set, values = []) {
  values.forEach((value) => addKeyword(set, value))
}

function collectTrueFlags(section = {}, mapping = {}) {
  const matched = []
  Object.entries(mapping).forEach(([key, labels]) => {
    if (!section || !section[key]) return
    labels.forEach((label) => matched.push(label))
  })
  return matched
}

function extractCityFromSections({ sections, jobParameters = {}, profile }) {
  const candidates = [
    jobParameters.city,
    sections?.basic_information?.city,
    sections?.basic_information?.address_city,
    sections?.location_focus?.primary_city,
    sections?.location_focus?.service_city,
    profile?.city,
  ]
  const city = candidates.find((value) => typeof value === 'string' && value.trim().length > 0)
  return city ? city.trim() : null
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function parseSatRange(range) {
  const normalized = normalizeString(range)
  if (!normalized) return null
  const matches = normalized.match(/\d{3,4}/g)
  if (!matches || matches.length === 0) return null
  const numbers = matches.map((entry) => Number.parseInt(entry, 10)).filter((entry) => Number.isFinite(entry))
  if (numbers.length === 0) return null
  const max = Math.max(...numbers)
  return Number.isFinite(max) ? max : null
}

function collectNarrativeKeywords(section = {}, register) {
  const fields = [
    'primary_goal',
    'target_population',
    'unique_qualities',
    'collaboration_partners',
    'sustainability_plan',
    'special_circumstances',
  ]
  fields.forEach((field) => {
    const value = section[field]
    if (!value || typeof value !== 'string') return
    value
      .split(/[,;]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && entry.length <= 60)
      .forEach((entry) => register(entry))
  })
}

export function extractCityFromContext({ profile, sections, jobParameters = {} }) {
  return extractCityFromSections({ profile, sections, jobParameters })
}

export function buildProfileSignals({ profile, sections }) {
  const keywordSet = new Set()
  const phraseSet = new Set()
  const demographicSet = new Set()
  const genderSet = new Set()
  const assistanceSet = new Set()
  const militarySet = new Set()
  const interestSet = new Set()
  const applicantTypeSet = new Set()

  const location = {
    zip: extractZipFromContext({ profile, sections }),
    state: extractStateFromContext({ profile, sections }),
    city: extractCityFromSections({ profile, sections }),
  }

  const academics = {
    gpa: null,
    act: null,
    sat: null,
    psat: null,
  }

  const registerKeyword = (value) => {
    const normalized = normalizeString(value)
    if (!normalized) return
    phraseSet.add(normalized)
    addKeyword(keywordSet, normalized)
  }

  const registerKeywords = (values = []) => {
    if (!Array.isArray(values)) return
    values.forEach((value) => registerKeyword(value))
  }

  const baseTags = Array.isArray(profile?.tags) ? profile.tags : []
  baseTags.forEach((tag) => {
    registerKeyword(tag)
    const normalized = normalizeString(tag)
    if (normalized) interestSet.add(normalized)
  })

  if (profile?.primary_type) {
    const normalized = normalizeString(profile.primary_type)
    applicantTypeSet.add(normalized)
    registerKeyword(profile.primary_type)
  }

  const basic = sections?.basic_information ?? {}
  if (basic.gender) {
    const normalizedGender = normalizeString(basic.gender)
    if (normalizedGender) {
      genderSet.add(normalizedGender)
      registerKeyword(normalizedGender)
      const synonyms = GENDER_SYNONYMS[normalizedGender]
      if (Array.isArray(synonyms)) {
        synonyms.forEach((synonym) => registerKeyword(synonym))
      }
    }
  }

  const financial = sections?.financial_information ?? {}
  if (financial.financial_need_level) {
    registerKeyword(financial.financial_need_level)
  }
  if (financial.low_income) {
    assistanceSet.add('low_income')
    ASSISTANCE_SYNONYMS.low_income.forEach((label) => registerKeyword(label))
  }
  if (financial.notes) {
    collectNarrativeKeywords({ notes: financial.notes }, registerKeyword)
  }

  const government = sections?.government_assistance ?? {}
  Object.entries(ASSISTANCE_SYNONYMS).forEach(([flag, labels]) => {
    if (government[flag]) {
      assistanceSet.add(flag)
      labels.forEach((label) => registerKeyword(label))
    }
  })

  const health = sections?.health_medical ?? {}
  const disabilityTypes = Array.isArray(health.disability_type) ? health.disability_type : []
  registerKeywords(disabilityTypes)
  if (health.wheelchair_user) registerKeyword('wheelchair user')
  if (health.neurodivergent) registerKeyword('neurodivergent')
  if (health.mental_health_condition) registerKeyword('mental health')

  const demographicsSection = sections?.demographics ?? {}
  Object.entries(DEMOGRAPHIC_SYNONYMS).forEach(([flag, labels]) => {
    if (demographicsSection[flag]) {
      demographicSet.add(flag)
      labels.forEach((label) => registerKeyword(label))
    }
  })
  if (demographicsSection.immigrant_status && demographicsSection.immigrant_status !== 'unknown') {
    const statusLabel = demographicsSection.immigrant_status.replace(/_/g, ' ')
    demographicSet.add(demographicsSection.immigrant_status)
    registerKeyword(statusLabel)
  }
  if (demographicsSection.notes) {
    collectNarrativeKeywords({ notes: demographicsSection.notes }, registerKeyword)
  }

  const family = sections?.family_life ?? {}
  const familyFlags = [
    'single_parent',
    'foster_youth',
    'first_time_parent',
    'domestic_violence_survivor',
    'trafficking_survivor',
    'former_incarcerated',
    'homeless',
    'caregiver',
    'disaster_survivor',
  ]
  familyFlags.forEach((flag) => {
    if (family[flag]) {
      registerKeyword(flag.replace(/_/g, ' '))
    }
  })
  if (family.notes) {
    collectNarrativeKeywords({ notes: family.notes }, registerKeyword)
  }
  if (family.first_time_parent || family.foster_youth) {
    assistanceSet.add('family_support')
  }

  const military = sections?.military_service ?? {}
  Object.entries(MILITARY_FLAGS).forEach(([flag, labels]) => {
    if (military[flag]) {
      militarySet.add(flag)
      labels.forEach((label) => registerKeyword(label))
    }
  })

  const occupation = sections?.occupation ?? {}
  Object.entries(occupation).forEach(([key, value]) => {
    if (!value) return
    if (key === 'healthcare_worker_type' && typeof value === 'string') {
      registerKeyword(value)
      return
    }
    if (value === true) {
      registerKeyword(key.replace(/_/g, ' '))
    }
    if (Array.isArray(value)) {
      registerKeywords(value)
    }
  })

  const locationFocus = sections?.location_focus ?? {}
  if (locationFocus.geographic_focus) {
    registerKeyword(locationFocus.geographic_focus)
  }
  if (locationFocus.notes) {
    collectNarrativeKeywords({ notes: locationFocus.notes }, registerKeyword)
  }
  if (locationFocus.rural_resident) registerKeyword('rural')
  if (locationFocus.urban_underserved) registerKeyword('urban underserved')
  if (locationFocus.appalachian_region) {
    registerKeyword('appalachian')
    demographicSet.add('appalachian')
  }

  const organizationDetails = sections?.organization_details ?? {}
  if (organizationDetails.organization_type) {
    registerKeyword(organizationDetails.organization_type)
  }
  if (organizationDetails.mission) {
    collectNarrativeKeywords({ mission: organizationDetails.mission }, registerKeyword)
  }

  const narrative = sections?.narrative ?? {}
  collectNarrativeKeywords(narrative, registerKeyword)
  if (narrative.target_population) registerKeyword(narrative.target_population)

  const universityApplications = sections?.university_applications?.applications ?? []
  universityApplications.forEach((application) => {
    if (!application) return
    if (Array.isArray(application.interests)) {
      application.interests.forEach((interest) => {
        registerKeyword(interest)
        interestSet.add(normalizeString(interest))
      })
    }
    if (application.application_type) registerKeyword(application.application_type)
    if (application.institution_type) registerKeyword(application.institution_type)
    const gpaCandidate = parseNumber(application.avg_gpa)
    if (Number.isFinite(gpaCandidate) && (!academics.gpa || gpaCandidate > academics.gpa)) {
      academics.gpa = gpaCandidate
    }
    const actCandidate = parseNumber(application.act_score ?? application.act)
    if (Number.isFinite(actCandidate) && (!academics.act || actCandidate > academics.act)) {
      academics.act = actCandidate
    }
    const satCandidate = parseNumber(application.sat_score ?? application.sat)
    const satRangeCandidate = parseSatRange(application.sat_range)
    const satValue = satCandidate ?? satRangeCandidate
    if (Number.isFinite(satValue) && (!academics.sat || satValue > academics.sat)) {
      academics.sat = satValue
    }
  })

  const education = sections?.education ?? sections?.education_details ?? {}
  if (education.gpa) {
    const gpaCandidate = parseNumber(education.gpa)
    if (Number.isFinite(gpaCandidate) && (!academics.gpa || gpaCandidate > academics.gpa)) {
      academics.gpa = gpaCandidate
    }
  }
  if (education.act_score) {
    const actCandidate = parseNumber(education.act_score)
    if (Number.isFinite(actCandidate) && (!academics.act || actCandidate > academics.act)) {
      academics.act = actCandidate
    }
  }
  if (education.sat_score || education.sat_range) {
    const satCandidate = parseNumber(education.sat_score)
    const satRangeCandidate = parseSatRange(education.sat_range)
    const satValue = satCandidate ?? satRangeCandidate
    if (Number.isFinite(satValue) && (!academics.sat || satValue > academics.sat)) {
      academics.sat = satValue
    }
  }
  if (education.programs && Array.isArray(education.programs)) {
    education.programs.forEach((program) => registerKeyword(program))
  }

  return {
    keywordSet,
    phrases: phraseSet,
    demographics: demographicSet,
    genders: genderSet,
    assistance: assistanceSet,
    military: militarySet,
    interests: interestSet,
    applicantTypes: applicantTypeSet,
    location,
    academics,
  }
}

export function calculateMatchScore(profile, opportunity) {
  // Simple match scoring algorithm
  let score = 50 // Base score
  
  // Geographic match
  if (opportunity.state === profile.state || opportunity.is_national) {
    score += 20
  }
  
  // Type match
  if (opportunity.eligibility_criteria?.includes(profile.primary_type)) {
    score += 15
  }
  
  // REMOVED: Random variation for testing - use deterministic scoring only
  // Use matchingEngine.js for production scoring
  
  return Math.min(100, score)
}

export function summarizeProfileSignals(signals) {
  const parts = []
  if (signals.demographics?.size) {
    const labels = Array.from(signals.demographics)
      .slice(0, 3)
      .map((label) => label.replace(/_/g, ' '))
    parts.push(`Demographics: ${labels.join(', ')}`)
  }
  if (signals.genders?.size) {
    const labels = Array.from(signals.genders)
      .slice(0, 2)
      .map((label) => label.replace(/_/g, ' '))
    parts.push(`Gender: ${labels.join(', ')}`)
  }
  if (signals.assistance?.size) {
    const labels = Array.from(signals.assistance)
      .slice(0, 3)
      .map((label) => label.replace(/_/g, ' '))
    parts.push(`Assistance: ${labels.join(', ')}`)
  }
  if (signals.interests?.size) {
    const labels = Array.from(signals.interests)
      .slice(0, 4)
      .map((label) => label.replace(/_/g, ' '))
    parts.push(`Interests: ${labels.join(', ')}`)
  }
  if (signals.academics) {
    const academicParts = []
    if (signals.academics.gpa) academicParts.push(`GPA ${signals.academics.gpa}`)
    if (signals.academics.act) academicParts.push(`ACT ${signals.academics.act}`)
    if (signals.academics.sat) academicParts.push(`SAT ${signals.academics.sat}`)
    if (academicParts.length > 0) {
      parts.push(`Academics: ${academicParts.join(', ')}`)
    }
  }
  return parts.join(' • ')
}
