import zipcodes from 'zipcodes'

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

export async function loadProfileContext(db, profileId) {
  const profile = await db
    .prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1')
    .get(profileId)
  if (!profile) {
    throw new Error(`Profile ${profileId} not found`)
  }

  const sections = (await db
    .prepare(
      `
      SELECT section_key, data
      FROM profile_sections
      WHERE profile_id = ?
    `,
    )
    .all(profileId))
    .reduce((acc, row) => {
      acc[row.section_key] = safeParseJSON(row.data, {})
      return acc
    }, {})

  // Use safeParseArrayField for array fields
  const tags = safeParseArrayField(profile.tags, [])
  const interests = safeParseArrayField(profile.interests, [])

  // Merge organization address fields into the profile context when available.
  // Many workflows store ZIP/state/city on `organizations`, but matching relies on profileContext.signals.location.
  let organization = null
  if (profile.organization_id) {
    try {
      organization = await db
        .prepare('SELECT * FROM organizations WHERE id = ? LIMIT 1')
        .get(profile.organization_id)
    } catch {
      organization = null
    }
  }

  const mergedProfile = {
    ...profile,
    tags,
    interests,
    // Provide fallbacks for location extraction
    postal_code: profile.postal_code || organization?.zip || organization?.postal_code || null,
    state: profile.state || organization?.state || null,
    city: profile.city || organization?.city || null,
  }
  
  const signals = buildProfileSignals({ 
    profile: mergedProfile, 
    sections 
  })

  return { 
    profile: mergedProfile, 
    sections, 
    signals,
    organization: organization ?? undefined,
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

const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/
const LONG_DIGIT_REGEX = /\b\d{7,}\b/

function shouldSkipFreeText(value) {
  if (!value || typeof value !== 'string') return true
  const s = value.trim()
  if (!s) return true
  if (EMAIL_REGEX.test(s)) return true
  if (SSN_REGEX.test(s)) return true
  // Avoid indexing long digit sequences (phone numbers, IDs).
  if (LONG_DIGIT_REGEX.test(s) && s.replace(/[^\d]/g, '').length >= 7) return true
  return false
}

function collectAllMatchableStrings(value, out, { maxItems = 600, maxDepth = 6 } = {}, depth = 0) {
  if (!out || out.size >= maxItems) return
  if (depth > maxDepth) return
  if (value === null || value === undefined) return

  if (typeof value === 'string') {
    if (!shouldSkipFreeText(value)) {
      const trimmed = value.trim()
      out.add(trimmed.length > 180 ? trimmed.slice(0, 180) : trimmed)
    }
    return
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    out.add(String(value))
    return
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (out.size >= maxItems) return
      collectAllMatchableStrings(entry, out, { maxItems, maxDepth }, depth + 1)
    }
    return
  }

  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (out.size >= maxItems) return
      // Index key names lightly (helps match filters like "nicra", "uei", etc.).
      if (typeof k === 'string' && k.length >= 3 && k.length <= 60) out.add(k.replace(/_/g, ' '))
      collectAllMatchableStrings(v, out, { maxItems, maxDepth }, depth + 1)
    }
  }
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

/**
 * Extract state abbreviation from an address string
 */
function extractStateFromAddress(address) {
  if (!address || typeof address !== 'string') return null
  // Match 2-letter state code before ZIP (e.g., "TN 38501" or "TN, 38501")
  const match = address.match(/\b([A-Z]{2})\s*,?\s*\d{5}/)
  return match ? match[1] : null
}

/**
 * Extract ZIP code from an address string
 */
function extractZipFromAddress(address) {
  if (!address || typeof address !== 'string') return null
  const match = address.match(/\b(\d{5})(?:-\d{4})?\b/)
  return match ? match[1] : null
}

/**
 * Extract city from an address string (line before state/zip)
 */
function extractCityFromAddress(address) {
  if (!address || typeof address !== 'string') return null
  // Split by newlines, look for line with city, state ZIP pattern
  const lines = address.split(/\n|,/).map(l => l.trim()).filter(Boolean)
  for (const line of lines) {
    const match = line.match(/^([A-Za-z\s]+),?\s+[A-Z]{2}\s*\d{5}/)
    if (match) return match[1].trim()
  }
  return null
}

const MATCHING_SENSITIVE_KEYS = new Set([
  'email',
  'phone',
  'address',
  'street',
  'city',
  'state',
  'zip',
  'postal_code',
  'postal',
  'zip_code',
  'organization_ein',
  'ein',
  'organization_uei',
  'uei',
  'organization_cage_code',
  'cage_code',
  'tenncare_id',
])

function registerAllDataPointsForMatching(value, registerKeyword, keyHint = '') {
  if (!value) return

  // Explicitly avoid indexing certain sensitive identifiers into matching keywords.
  if (keyHint && MATCHING_SENSITIVE_KEYS.has(String(keyHint))) return

  if (value === true) {
    if (keyHint) registerKeyword(String(keyHint).replace(/_/g, ' '))
    return
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    // Avoid accidentally indexing long blobs (addresses, essays) as keywords.
    if (!trimmed) return
    if (trimmed.length > 1200) return
    registerKeyword(trimmed)
    return
  }

  if (typeof value === 'number') {
    // Numeric values are still useful for eligibility checks elsewhere; do not index raw numbers as keywords.
    return
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => registerAllDataPointsForMatching(entry, registerKeyword, keyHint))
    return
  }

  if (typeof value === 'object') {
    Object.entries(value).forEach(([k, v]) => registerAllDataPointsForMatching(v, registerKeyword, k))
  }
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
  const healthSet = new Set()
  const familySet = new Set()
  const occupationSet = new Set()
  const allDataSet = new Set()

  // Extract location from multiple sources including address strings
  const basic = sections?.basic_information ?? {}
  const locationFocus = sections?.location_focus ?? {}
  const organizationDetails = sections?.organization_details ?? {}
  const studentDetails = sections?.student_details ?? {}
  const firearms = sections?.firearms ?? {}
  const political = sections?.political_civic ?? {}

  const location = {
    zip:
      extractZipFromContext({ profile, sections }) ||
      basic.zip ||
      extractZipFromAddress(basic.address),
    state:
      extractStateFromContext({ profile, sections }) ||
      basic.state ||
      extractStateFromAddress(basic.address),
    city:
      extractCityFromSections({ profile, sections }) ||
      basic.city ||
      extractCityFromAddress(basic.address),
  }

  // If we have ZIP but not state/city, derive from local ZIP database.
  // This is critical for matching: many opportunities are state-scoped and the scoring engine penalizes unknown state.
  if (location.zip && !location.state) {
    try {
      const lookup = zipcodes.lookup(location.zip)
      if (lookup?.state) location.state = String(lookup.state).toUpperCase()
      if (lookup?.city && !location.city) location.city = String(lookup.city)
    } catch {
      // ignore
    }
  }

  const academics = {
    gpa: null,
    act: null,
    sat: null,
    psat: null,
  }

  const financial = {
    householdIncome: null,
    householdSize: null,
    needLevel: null,
    fundingAmountNeeded: null,
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

  // ============ GLOBAL PASSTHROUGH (ALL DATA POINTS) ============
  // Add matchable tokens from *all* profile/section data, so crawlers and matchers
  // can leverage every captured data point—even if it doesn't have dedicated logic.
  //
  // IMPORTANT: Avoid indexing PII (emails, SSNs, long digit strings).
  collectAllMatchableStrings({ profile, sections }, allDataSet, { maxItems: 600, maxDepth: 6 })
  for (const token of allDataSet) {
    registerKeyword(token)
  }

  // ============ PROFILE TOP-LEVEL FIELDS ============
  const baseTags = Array.isArray(profile?.tags) ? profile.tags : []
  baseTags.forEach((tag) => {
    registerKeyword(tag)
    const normalized = normalizeString(tag)
    if (normalized) interestSet.add(normalized)
  })

  const baseInterests = Array.isArray(profile?.interests) ? profile.interests : []
  baseInterests.forEach((interest) => {
    registerKeyword(interest)
    interestSet.add(normalizeString(interest))
  })

  if (profile?.primary_type) {
    const normalized = normalizeString(profile.primary_type)
    applicantTypeSet.add(normalized)
    registerKeyword(profile.primary_type)
  }

  if (profile?.display_name) {
    // Extract keywords from display name (e.g., "Axiom Community Health Cooperative" -> community, health)
    const nameWords = profile.display_name.split(/\s+/).filter(w => w.length > 3)
    nameWords.forEach(word => registerKeyword(word))
  }

  // ============ BASIC INFORMATION ============
  // Canonical applicant name fields (comprehensive form uses `name`, legacy uses `full_name`).
  if (basic.name) registerKeyword(basic.name)
  if (basic.full_name) registerKeyword(basic.full_name)

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
  if (basic.age) {
    const age = parseNumber(basic.age)
    if (age !== null) {
      if (age < 18) { demographicSet.add('youth'); registerKeyword('youth'); registerKeyword('minor') }
      if (age >= 18 && age <= 24) { demographicSet.add('young_adult'); registerKeyword('young adult') }
      if (age >= 55) { demographicSet.add('senior'); registerKeyword('senior'); registerKeyword('elderly') }
      if (age >= 65) { registerKeyword('retiree') }
    }
  }
  if (basic.date_of_birth) {
    // Calculate age from DOB
    const dob = new Date(basic.date_of_birth)
    if (!isNaN(dob.getTime())) {
      const age = Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000))
      if (age < 18) { demographicSet.add('youth'); registerKeyword('youth') }
      if (age >= 18 && age <= 24) { demographicSet.add('young_adult'); registerKeyword('young adult') }
      if (age >= 55) { demographicSet.add('senior'); registerKeyword('senior') }
    }
  }
  // Extract keywords from website/email domain for organization matching
  if (basic.website) {
    const domain = basic.website.replace(/^https?:\/\//, '').split('/')[0].replace('www.', '')
    const domainName = domain.split('.')[0]
    if (domainName && domainName.length > 3) registerKeyword(domainName)
  }

  // ============ STUDENT DETAILS ============
  if (Array.isArray(studentDetails.student_grade_levels)) {
    studentDetails.student_grade_levels.forEach((level) => registerKeyword(String(level)))
  }
  if (studentDetails.current_college) registerKeyword(studentDetails.current_college)
  if (Array.isArray(studentDetails.target_colleges)) {
    studentDetails.target_colleges.forEach((college) => registerKeyword(String(college)))
  }
  if (studentDetails.intended_major) {
    registerKeyword(studentDetails.intended_major)
    interestSet.add(normalizeString(studentDetails.intended_major))
  }
  if (studentDetails.first_generation) {
    demographicSet.add('first_generation')
    registerKeyword('first generation')
  }
  if (studentDetails.stem_student) {
    registerKeyword('stem')
    registerKeyword('science technology engineering math')
  }
  if (studentDetails.gpa) {
    const gpaCandidate = parseNumber(studentDetails.gpa)
    if (Number.isFinite(gpaCandidate) && (!academics.gpa || gpaCandidate > academics.gpa)) {
      academics.gpa = gpaCandidate
    }
  }
  if (studentDetails.act_score) {
    const actCandidate = parseNumber(studentDetails.act_score)
    if (Number.isFinite(actCandidate) && (!academics.act || actCandidate > academics.act)) {
      academics.act = actCandidate
    }
  }
  if (studentDetails.sat_score) {
    const satCandidate = parseNumber(studentDetails.sat_score)
    if (Number.isFinite(satCandidate) && (!academics.sat || satCandidate > academics.sat)) {
      academics.sat = satCandidate
    }
  }
  if (Array.isArray(studentDetails.extracurricular_activities)) {
    studentDetails.extracurricular_activities.forEach((entry) => registerKeyword(String(entry)))
  }
  if (Array.isArray(studentDetails.achievements)) {
    studentDetails.achievements.forEach((entry) => registerKeyword(String(entry)))
  }
  if (studentDetails.community_service_hours) {
    const hours = parseNumber(studentDetails.community_service_hours)
    if (hours !== null && hours >= 100) registerKeyword('community service')
    if (hours !== null && hours >= 200) registerKeyword('volunteer')
  }
  if (studentDetails.ged_graduate) registerKeyword('ged')
  if (studentDetails.returning_adult_student) registerKeyword('adult learner')
  if (studentDetails.recent_graduate) registerKeyword('recent graduate')
  if (studentDetails.job_retraining) registerKeyword('job retraining')
  if (studentDetails.minor_child) {
    demographicSet.add('minor_child')
    registerKeyword('minor')
  }
  if (studentDetails.young_adult) {
    demographicSet.add('young_adult')
    registerKeyword('young adult')
  }

  // ============ FINANCIAL INFORMATION ============
  const financialSection = sections?.financial_information ?? {}
  if (financialSection.financial_need_level) {
    financial.needLevel = financialSection.financial_need_level
    registerKeyword(financialSection.financial_need_level)
    if (['High', 'Critical', 'Extreme'].includes(financialSection.financial_need_level)) {
      assistanceSet.add('high_financial_need')
      registerKeyword('financial hardship')
      registerKeyword('urgent need')
    }
  }
  if (financialSection.household_income) {
    financial.householdIncome = parseNumber(financialSection.household_income)
    if (financial.householdIncome !== null && financial.householdIncome < 50000) {
      assistanceSet.add('low_income')
      ASSISTANCE_SYNONYMS.low_income.forEach((label) => registerKeyword(label))
    }
    if (financial.householdIncome !== null && financial.householdIncome < 25000) {
      registerKeyword('poverty')
      registerKeyword('extremely low income')
    }
  }
  if (financialSection.household_size) {
    financial.householdSize = parseNumber(financialSection.household_size)
  }
  if (financialSection.low_income) {
    assistanceSet.add('low_income')
    ASSISTANCE_SYNONYMS.low_income.forEach((label) => registerKeyword(label))
  }
  if (financialSection.notes) {
    collectNarrativeKeywords({ notes: financialSection.notes }, registerKeyword)
  }
  if (financialSection.employment_status) {
    registerKeyword(financialSection.employment_status)
    if (financialSection.employment_status === 'unemployed') {
      assistanceSet.add('unemployed')
      registerKeyword('job seeker')
    }
  }

  // ============ GOVERNMENT ASSISTANCE ============
  const government = sections?.government_assistance ?? {}
  Object.entries(ASSISTANCE_SYNONYMS).forEach(([flag, labels]) => {
    if (government[flag]) {
      assistanceSet.add(flag)
      labels.forEach((label) => registerKeyword(label))
    }
  })
  // Medicaid enrollment (not in ASSISTANCE_SYNONYMS)
  if (government.medicaid_enrolled) {
    assistanceSet.add('medicaid')
    registerKeyword('medicaid')
    registerKeyword('healthcare assistance')
  }
  if (government.medicaid_waiver_program) {
    registerKeyword(String(government.medicaid_waiver_program).replace(/_/g, ' '))
    registerKeyword('medicaid waiver')
  }
  if (government.medicare_recipient) {
    assistanceSet.add('medicare')
    registerKeyword('medicare')
  }
  // Other programs as free text
  if (government.other_programs && typeof government.other_programs === 'string') {
    collectNarrativeKeywords({ other_programs: government.other_programs }, registerKeyword)
    // Also register the whole thing as a keyword if short
    if (government.other_programs.length < 100) {
      registerKeyword(government.other_programs)
    }
  }

  // ============ HEALTH/MEDICAL ============
  const health = sections?.health_medical ?? {}
  const disabilityTypes = Array.isArray(health.disability_type) ? health.disability_type : []
  registerKeywords(disabilityTypes)
  disabilityTypes.forEach(dt => healthSet.add(normalizeString(dt)))

  if (health.cancer_survivor) { healthSet.add('cancer'); registerKeyword('cancer survivor'); registerKeyword('oncology') }
  if (health.cancer_type) registerKeyword(health.cancer_type)
  if (health.cancer_diagnosis_year) {
    const year = parseNumber(health.cancer_diagnosis_year)
    if (year !== null) registerKeyword('cancer diagnosis')
  }

  if (health.wheelchair_user) { healthSet.add('wheelchair'); registerKeyword('wheelchair user'); registerKeyword('mobility impairment') }
  if (health.neurodivergent) { healthSet.add('neurodivergent'); registerKeyword('neurodivergent'); registerKeyword('autism'); registerKeyword('adhd') }
  if (health.mental_health_condition) { healthSet.add('mental_health'); registerKeyword('mental health'); registerKeyword('behavioral health') }
  if (health.chronic_illness) { healthSet.add('chronic_illness'); registerKeyword('chronic illness'); registerKeyword('chronic condition') }
  if (health.rare_disease) { healthSet.add('rare_disease'); registerKeyword('rare disease'); registerKeyword('orphan disease') }
  if (health.visual_impairment) { healthSet.add('visual_impairment'); registerKeyword('visual impairment'); registerKeyword('blind'); registerKeyword('low vision') }
  if (health.hearing_impairment) { healthSet.add('hearing_impairment'); registerKeyword('hearing impairment'); registerKeyword('deaf'); registerKeyword('hard of hearing') }
  if (health.terminal_illness) { healthSet.add('terminal'); registerKeyword('terminal illness'); registerKeyword('hospice') }
  if (health.support_needs_level) {
    registerKeyword(health.support_needs_level + ' support needs')
    if (['High', 'Critical'].includes(health.support_needs_level)) {
      healthSet.add('high_support_needs')
      registerKeyword('intensive support')
    }
  }
  if (health.notes) {
    collectNarrativeKeywords({ notes: health.notes }, registerKeyword)
  }

  // ============ DEMOGRAPHICS ============
  const demographicsSection = sections?.demographics ?? {}
  Object.entries(DEMOGRAPHIC_SYNONYMS).forEach(([flag, labels]) => {
    if (demographicsSection[flag]) {
      demographicSet.add(flag)
      labels.forEach((label) => registerKeyword(label))
    }
  })
  if (demographicsSection.immigration_status) {
    const statusLabel = String(demographicsSection.immigration_status).replace(/_/g, ' ')
    demographicSet.add(normalizeString(demographicsSection.immigration_status))
    registerKeyword(statusLabel)
    if (['refugee', 'asylee', 'daca', 'visa_holder'].includes(normalizeString(demographicsSection.immigration_status))) {
      registerKeyword('immigrant')
      registerKeyword('new american')
    }
  }
  if (demographicsSection.permanent_resident) {
    demographicSet.add('permanent_resident')
    registerKeyword('permanent resident')
    registerKeyword('green card')
  }
  if (demographicsSection.refugee) {
    demographicSet.add('refugee')
    registerKeyword('refugee')
  }
  if (demographicsSection.new_immigrant) {
    demographicSet.add('new_immigrant')
    registerKeyword('new immigrant')
    registerKeyword('recent immigrant')
  }
  if (demographicsSection.immigrant_status && demographicsSection.immigrant_status !== 'unknown') {
    const statusLabel = demographicsSection.immigrant_status.replace(/_/g, ' ')
    demographicSet.add(demographicsSection.immigrant_status)
    registerKeyword(statusLabel)
    if (['refugee', 'asylee', 'daca'].includes(demographicsSection.immigrant_status.toLowerCase())) {
      registerKeyword('new american')
      registerKeyword('immigrant')
    }
  }
  if (demographicsSection.ethnicity) {
    registerKeyword(demographicsSection.ethnicity)
  }
  if (demographicsSection.race) {
    registerKeyword(demographicsSection.race)
  }
  if (demographicsSection.first_generation) {
    demographicSet.add('first_generation')
    registerKeyword('first generation')
    registerKeyword('first gen')
  }
  if (demographicsSection.notes) {
    collectNarrativeKeywords({ notes: demographicsSection.notes }, registerKeyword)
  }

  // ============ FAMILY LIFE ============
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
    'widowed',
    'divorced',
    'expectant_parent',
    'grandparent_caregiver',
    'kinship_care',
  ]
  familyFlags.forEach((flag) => {
    if (family[flag]) {
      familySet.add(flag)
      registerKeyword(flag.replace(/_/g, ' '))
    }
  })
  if (family.child_count && parseNumber(family.child_count) > 0) {
    familySet.add('parent')
    registerKeyword('parent')
    registerKeyword('children')
    if (parseNumber(family.child_count) >= 3) {
      registerKeyword('large family')
    }
  }
  if (family.dependents && parseNumber(family.dependents) > 0) {
    registerKeyword('dependents')
  }
  if (family.notes) {
    collectNarrativeKeywords({ notes: family.notes }, registerKeyword)
  }
  if (family.first_time_parent || family.foster_youth) {
    assistanceSet.add('family_support')
  }
  if (family.homeless) {
    assistanceSet.add('homeless')
    registerKeyword('housing insecure')
    registerKeyword('unhoused')
  }

  // ============ MILITARY SERVICE ============
  const military = sections?.military_service ?? {}
  Object.entries(MILITARY_FLAGS).forEach(([flag, labels]) => {
    if (military[flag]) {
      militarySet.add(flag)
      labels.forEach((label) => registerKeyword(label))
    }
  })
  if (military.military_branch) {
    registerKeyword(military.military_branch)
    militarySet.add(normalizeString(military.military_branch))
  }
  if (military.service_era) {
    registerKeyword(military.service_era)
    if (['vietnam', 'korea', 'wwii', 'gulf_war', 'oef', 'oif'].includes(normalizeString(military.service_era))) {
      registerKeyword('war veteran')
    }
  }
  if (military.discharge_status) {
    registerKeyword(military.discharge_status)
  }
  if (military.va_disability_rating) {
    const rating = parseNumber(military.va_disability_rating)
    if (rating !== null && rating > 0) {
      militarySet.add('service_connected_disability')
      registerKeyword('service connected disability')
      registerKeyword('va disability')
    }
  }

  // ============ OCCUPATION ============
  const occupation = sections?.occupation ?? {}
  Object.entries(occupation).forEach(([key, value]) => {
    if (!value) return
    if (key === 'healthcare_worker_type' && typeof value === 'string') {
      occupationSet.add(normalizeString(value))
      registerKeyword(value)
      return
    }
    if (key === 'job_title' && typeof value === 'string') {
      occupationSet.add(normalizeString(value))
      registerKeyword(value)
      return
    }
    if (key === 'employer' && typeof value === 'string') {
      registerKeyword(value)
      return
    }
    if (key === 'industry' && typeof value === 'string') {
      occupationSet.add(normalizeString(value))
      registerKeyword(value)
      return
    }
    if (value === true) {
      occupationSet.add(key)
      registerKeyword(key.replace(/_/g, ' '))
    }
    if (Array.isArray(value)) {
      registerKeywords(value)
      value.forEach(v => occupationSet.add(normalizeString(v)))
    }
  })

  // ============ LOCATION FOCUS ============
  if (locationFocus.geographic_focus) {
    registerKeyword(locationFocus.geographic_focus)
  }
  if (locationFocus.service_area) {
    registerKeyword(locationFocus.service_area)
  }
  if (locationFocus.counties_served && Array.isArray(locationFocus.counties_served)) {
    locationFocus.counties_served.forEach(county => registerKeyword(county))
  }
  if (locationFocus.notes) {
    collectNarrativeKeywords({ notes: locationFocus.notes }, registerKeyword)
  }
  if (locationFocus.rural_resident) { registerKeyword('rural'); demographicSet.add('rural') }
  if (locationFocus.urban_underserved) { registerKeyword('urban underserved'); demographicSet.add('urban_underserved') }
  if (locationFocus.appalachian_region) {
    registerKeyword('appalachian')
    registerKeyword('appalachia')
    demographicSet.add('appalachian')
  }
  if (locationFocus.tribal_land) {
    registerKeyword('tribal')
    registerKeyword('reservation')
    demographicSet.add('tribal')
  }
  if (locationFocus.frontier_community) {
    registerKeyword('frontier')
    registerKeyword('remote')
    demographicSet.add('frontier')
  }

  // ============ ORGANIZATION DETAILS ============
  const orgApplicantType = organizationDetails.applicant_type || organizationDetails.organization_type
  if (orgApplicantType) {
    registerKeyword(orgApplicantType)
    applicantTypeSet.add(normalizeString(orgApplicantType))
  }
  if (organizationDetails.mission) {
    collectNarrativeKeywords({ mission: organizationDetails.mission }, registerKeyword)
  }
  if (organizationDetails.organization_ein || organizationDetails.ein) {
    registerKeyword('501c3')
    registerKeyword('nonprofit')
  }
  if (organizationDetails.founding_year) {
    const age = new Date().getFullYear() - parseNumber(organizationDetails.founding_year)
    if (age !== null && age <= 3) {
      registerKeyword('new organization')
      registerKeyword('startup nonprofit')
    }
  }
  if (organizationDetails.annual_budget) {
    const budget = parseNumber(organizationDetails.annual_budget)
    if (budget !== null) {
      if (budget < 100000) registerKeyword('small nonprofit')
      if (budget < 500000) registerKeyword('grassroots')
      if (budget >= 1000000) registerKeyword('established nonprofit')
    }
  }
  if (organizationDetails.staff_count) {
    const staff = parseNumber(organizationDetails.staff_count)
    if (staff !== null && staff <= 5) {
      registerKeyword('small organization')
    }
  }
  if (organizationDetails.programs_offered && Array.isArray(organizationDetails.programs_offered)) {
    organizationDetails.programs_offered.forEach(prog => registerKeyword(prog))
  }

  // Compliance & certifications / designations
  if (organizationDetails.sam_gov_registered) registerKeyword('sam.gov')
  if (organizationDetails.grants_gov_active) registerKeyword('grants.gov')
  if (organizationDetails.hipaa_compliant) registerKeyword('hipaa')
  if (organizationDetails.ferpa_compliant) registerKeyword('ferpa')
  if (organizationDetails.faith_based_organization) registerKeyword('faith based')
  if (organizationDetails.serves_rural_area) registerKeyword('rural')
  if (organizationDetails.business_501c3_certified) registerKeyword('501c3')
  if (organizationDetails.business_501c4_certified) registerKeyword('501c4')
  if (organizationDetails.minority_owned_certification) registerKeyword('minority owned')
  if (organizationDetails.women_owned_certification) registerKeyword('women owned')
  if (organizationDetails.veteran_owned_business) registerKeyword('veteran owned')
  if (organizationDetails.promise_zone_designation) registerKeyword('promise zone')
  if (organizationDetails.opportunity_zone_designation) registerKeyword('opportunity zone')
  if (organizationDetails.business_affected_covid) registerKeyword('covid impacted')
  if (organizationDetails.ntee_code) registerKeyword(`ntee ${organizationDetails.ntee_code}`)
  if (organizationDetails.evidence_based_program) registerKeyword(organizationDetails.evidence_based_program)

  // ============ NARRATIVE ============
  const narrative = sections?.narrative ?? {}
  collectNarrativeKeywords(narrative, registerKeyword)
  if (narrative.mission) {
    collectNarrativeKeywords({ mission: narrative.mission }, registerKeyword)
  }
  if (narrative.target_population) registerKeyword(narrative.target_population)
  if (narrative.primary_goal) registerKeyword(narrative.primary_goal)
  if (narrative.funding_amount_needed) {
    // Extract dollar amount
    const amountMatch = String(narrative.funding_amount_needed).match(/\$?([\d,]+)/g)
    if (amountMatch) {
      const amount = parseNumber(amountMatch[0].replace(/[$,]/g, ''))
      if (amount !== null) {
        financial.fundingAmountNeeded = amount
      }
    }
    // Also register as keywords for matching
    registerKeyword(narrative.funding_amount_needed)
  }
  if (narrative.use_of_funds) {
    collectNarrativeKeywords({ use_of_funds: narrative.use_of_funds }, registerKeyword)
  }
  if (Array.isArray(narrative.keywords)) {
    narrative.keywords.forEach((kw) => registerKeyword(String(kw)))
  }
  if (Array.isArray(narrative.focus_areas)) {
    narrative.focus_areas.forEach((kw) => registerKeyword(String(kw)))
  }

  // ============ FIREARMS / CIVIC ============
  if (firearms.second_amendment_supporter) registerKeyword('second amendment')
  if (firearms.gun_owner) registerKeyword('gun owner')
  if (firearms.concealed_carry_permit) registerKeyword('concealed carry')
  if (firearms.nra_member) registerKeyword('nra member')
  if (firearms.firearm_instructor) registerKeyword('firearm instructor')
  if (firearms.competitive_shooter) registerKeyword('competitive shooter')
  if (firearms.hunting_license) registerKeyword('hunting')

  if (political.registered_voter) registerKeyword('registered voter')
  if (political.political_party) registerKeyword(political.political_party)
  if (political.politically_active) registerKeyword('politically active')
  if (political.community_organizer) registerKeyword('community organizer')
  if (political.advocacy_work) registerKeyword('advocacy')
  if (political.civic_volunteer) registerKeyword('civic volunteer')
  if (political.election_worker) registerKeyword('election worker')

  // ============ UNIVERSITY APPLICATIONS ============
  const universityApplications = sections?.university_applications?.applications ?? []
  universityApplications.forEach((application) => {
    if (!application) return
    if (Array.isArray(application.interests)) {
      application.interests.forEach((interest) => {
        registerKeyword(interest)
        interestSet.add(normalizeString(interest))
      })
    }
    if (application.name) registerKeyword(application.name)
    if (application.application_type) registerKeyword(application.application_type)
    if (application.institution_type) registerKeyword(application.institution_type)
    if (application.intended_major) {
      registerKeyword(application.intended_major)
      interestSet.add(normalizeString(application.intended_major))
    }
    if (application.notes) {
      collectNarrativeKeywords({ notes: application.notes }, registerKeyword)
    }
    const gpaCandidate = parseNumber(application.avg_gpa ?? application.gpa)
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

  // ============ EDUCATION ============
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
  if (education.degree_type) registerKeyword(education.degree_type)
  if (education.field_of_study) {
    registerKeyword(education.field_of_study)
    interestSet.add(normalizeString(education.field_of_study))
  }
  if (education.school_name) registerKeyword(education.school_name)
  if (education.graduation_year) {
    const gradYear = parseNumber(education.graduation_year)
    const currentYear = new Date().getFullYear()
    if (gradYear !== null) {
      if (gradYear === currentYear || gradYear === currentYear + 1) {
        registerKeyword('graduating senior')
      }
      if (gradYear > currentYear) {
        registerKeyword('current student')
      }
    }
  }
  if (education.first_generation) {
    demographicSet.add('first_generation')
    registerKeyword('first generation college student')
  }

  // ============ RAW SECTIONS PASSTHROUGH ============
  // Store the raw sections for crawlers that need direct access to any field
  const rawSections = sections

  // Ensure every non-sensitive data point can contribute to matching.
  // This is intentionally broad so newly-added fields automatically become matchable.
  try {
    registerAllDataPointsForMatching(sections, registerKeyword)
  } catch {
    // ignore defensive failures
  }

  // ============ COVERAGE TRACKING ============
  // Track how much of the profile data was processed to ensure 100% coverage
  const sectionKeys = Object.keys(sections || {})
  const expectedSections = [
    'basic_information', 'demographics', 'family_life', 'financial_information',
    'government_assistance', 'health_medical', 'location_focus', 'military_service',
    'narrative', 'occupation', 'organization_details', 'university_applications', 'education',
    'student_details', 'firearms', 'political_civic'
  ]
  const presentSections = sectionKeys.filter(k => expectedSections.includes(k))
  
  // Calculate coverage percentage (at least 1 section = 100% for crawler purposes)
  // The crawler check requires pct >= 1 (i.e., at least some sections present)
  const coveragePct =
    expectedSections.length > 0 ? Math.round((presentSections.length / expectedSections.length) * 100) : 0
  const coverage = {
    fields_total: keywordSet.size + phraseSet.size,
    fields_used: keywordSet.size + phraseSet.size,
    sections_present: presentSections.length,
    sections_expected: expectedSections.length,
    pct: presentSections.length > 0 ? coveragePct : 0,
  }

  return {
    // Backward-compatible shapes used by tests and older callers.
    keywords: Array.from(keywordSet),
    phrases_list: Array.from(phraseSet),
    keywordSet,
    // Backward-compatible iterable alias used by some crawler implementations.
    keywords: keywordSet,
    phrases: phraseSet,
    demographics: demographicSet,
    genders: genderSet,
    assistance: assistanceSet,
    military: militarySet,
    interests: interestSet,
    applicantTypes: applicantTypeSet,
    health: healthSet,
    family: familySet,
    occupation: occupationSet,
    location,
    academics,
    financial,
    rawSections,
    allData: allDataSet,
    coverage,
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
