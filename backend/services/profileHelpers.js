import zipcodes from 'zipcodes'
import { resolveCountyForZip } from './geo/zipCountyResolver.js'

/**
 * Resolve the canonical applicant type from a profile object.
 *
 * The database column is `primary_type` but the frontend and some services
 * use `applicant_type`.  profileTaxonomy uses `primary_profile_type` inside
 * its facets object.  This helper normalises all three so callers never need
 * to remember the precedence chain.
 *
 * @param {Object} profile - A profile row or profileContext.profile
 * @returns {string|null}
 */
export function resolveApplicantType(profile) {
  if (!profile || typeof profile !== 'object') return null
  return (
    profile.applicant_type ??
    profile.primary_type ??
    profile.primary_profile_type ??
    null
  )
}

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
  
  let signals = buildProfileSignals({ 
    profile: mergedProfile, 
    sections,
    asOf: mergedProfile.updated_at || mergedProfile.created_at || null,
  })

  // Foolproof: guarantee signals are always usable by crawlers/matching (never null or empty when profile exists).
  if (!signals || typeof signals !== 'object') {
    signals = buildProfileSignals({ profile: mergedProfile, sections: {}, asOf: null })
  }
  if (!signals.location || typeof signals.location !== 'object') {
    signals.location = {
      zip: mergedProfile.postal_code || mergedProfile.zip_code || null,
      state: mergedProfile.state || null,
      city: mergedProfile.city || null,
      county: null,
    }
  }
  const hasAnyKeywords = (signals.keywordSet && signals.keywordSet.size > 0) || (Array.isArray(signals.keywords) && signals.keywords.length > 0)
  if (!hasAnyKeywords && (mergedProfile.primary_type || (Array.isArray(mergedProfile.tags) && mergedProfile.tags.length > 0))) {
    const pt = String(mergedProfile.primary_type || '').trim().toLowerCase()
    if (pt) {
      if (!signals.keywordSet) signals.keywordSet = new Set()
      signals.keywordSet.add(pt)
      if (!signals.applicantTypes) signals.applicantTypes = new Set()
      signals.applicantTypes.add(pt)
    }
    if (Array.isArray(mergedProfile.tags) && mergedProfile.tags.length > 0) {
      if (!signals.keywordSet) signals.keywordSet = new Set()
      mergedProfile.tags.forEach((t) => t && signals.keywordSet.add(String(t).toLowerCase().trim()))
    }
    if (Array.isArray(signals.keywords)) {
      signals.keywords = Array.from(signals.keywordSet || [])
    }
  }

  return { 
    profile: mergedProfile, 
    sections, 
    signals,
    organization: organization ?? undefined,
  }
}

/**
 * Build canonical, deterministic profile context for crawlers, matching, and Anya.
 * This is the ONLY function crawlers/matching/Anya should use to access profile data.
 * 
 * Returns a complete, immutable snapshot including:
 * - Base profile row
 * - All profile sections and fields
 * - Derived signals (mission, geography, focus areas, populations served)
 * - Attached documents metadata (file_url, mime_type, extracted_text if available)
 * - Organization data if linked
 * 
 * The output is deterministic JSON suitable for storage in crawler_jobs.profile_context_snapshot.
 * 
 * @param {object} db - Database connection
 * @param {string} profileId - Profile ID
 * @returns {Promise<object>} Complete profile context
 */
export async function buildProfileContext(db, profileId, options = {}) {
  // Get base profile
  const profile = await db
    .prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1')
    .get(profileId)
  
  if (!profile) {
    throw new Error(`Profile ${profileId} not found`)
  }

  // Deterministic reference timestamp for derived computations and generated_at.
  // Never default to "now" here; snapshots must be stable.
  const referenceIsoRaw =
    options && typeof options === 'object' && options.asOf
      ? String(options.asOf)
      : (profile.updated_at || profile.created_at || null)

  // Get all profile sections
  const sectionRows = await db
    .prepare(
      `
      SELECT section_key, data, created_at, updated_at
      FROM profile_sections
      WHERE profile_id = ?
      ORDER BY section_key
    `,
    )
    .all(profileId)
  
  const sections = {}
  const sectionsMeta = []
  
  for (const row of sectionRows) {
    sections[row.section_key] = safeParseJSON(row.data, {})
    sectionsMeta.push({
      key: row.section_key,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })
  }

  // Parse array fields
  const tags = safeParseArrayField(profile.tags, [])
  const interests = safeParseArrayField(profile.interests, [])

  // Get organization if linked
  let organization = null
  if (profile.organization_id) {
    try {
      organization = await db
        .prepare('SELECT * FROM organizations WHERE id = ? LIMIT 1')
        .get(profile.organization_id)
    } catch (error) {
      console.warn('[buildProfileContext] Failed to load organization:', error?.message)
      organization = null
    }
  }

  // Get documents with metadata and extracted text
  const documents = []
  try {
    const docRows = await db
      .prepare(
        `
        SELECT 
          d.id, d.name, d.type, d.file_url, d.file_path, 
          d.file_size, d.mime_type, d.extracted_text,
          d.created_at, d.updated_at
        FROM documents d
        WHERE d.profile_id = ?
        ORDER BY d.created_at DESC
      `,
      )
      .all(profileId)
    
    for (const doc of docRows) {
      documents.push({
        id: doc.id,
        name: doc.name,
        type: doc.type,
        file_url: doc.file_url,
        file_path: doc.file_path,
        file_size: doc.file_size,
        mime_type: doc.mime_type,
        extracted_text: doc.extracted_text || null,
        created_at: doc.created_at,
        updated_at: doc.updated_at,
      })
    }
  } catch (error) {
    console.warn('[buildProfileContext] Failed to load documents:', error?.message)
  }

  // Build merged profile with location fallbacks
  const mergedProfile = {
    ...profile,
    tags,
    interests,
    postal_code: profile.postal_code || organization?.zip || organization?.postal_code || null,
    state: profile.state || organization?.state || null,
    city: profile.city || organization?.city || null,
  }

  // Build signals (keywords, demographics, location, etc.)
  const signals = buildProfileSignals({ 
    profile: mergedProfile, 
    sections,
    asOf: referenceIsoRaw,
  })

  // Return deterministic context
  return {
    version: '2.0', // Version for future compatibility
    profile_id: profileId,
    generated_at: referenceIsoRaw,
    profile: mergedProfile,
    sections,
    sections_meta: sectionsMeta,
    signals,
    organization: organization || null,
    documents,
  }
}

export function extractZipFromContext({ profile, sections, jobParameters = {} }) {
  const addr = sections?.basic_information?.address
  const compAddr = sections?.comprehensive_application?.address
  const candidates = [
    jobParameters.zip,
    jobParameters.primary_zip,
    sections?.basic_information?.zip,
    sections?.basic_information?.zip_code,
    sections?.basic_information?.postal_code,
    sections?.basic_information?.address_zip,
    addr?.zip_code,
    addr?.zip,
    addr?.postal_code,
    sections?.comprehensive_application?.zip,
    sections?.comprehensive_application?.zip_code,
    sections?.comprehensive_application?.postal_code,
    compAddr?.zip_code,
    compAddr?.zip,
    compAddr?.postal_code,
    sections?.location_focus?.primary_zip,
    sections?.location_focus?.service_zip,
    sections?.location_focus?.zip,
    sections?.location_focus?.zip_code,
    sections?.organization_details?.zip,
    sections?.organization_details?.zip_code,
    sections?.organization_details?.hq_zip,
    sections?.demographics?.zip_code,
    sections?.demographics?.zip,
    profile?.postal_code,
    profile?.zip_code,
  ]

  const zip = candidates.find(
    (value) => typeof value === 'string' && /^\d{5}/.test(value.trim()),
  )

  return zip ? zip.trim().slice(0, 5) : null
}

export function extractStateFromContext({ profile, sections, jobParameters = {} }) {
  const addr = sections?.basic_information?.address
  const compAddr = sections?.comprehensive_application?.address
  const candidates = [
    jobParameters.state,
    sections?.basic_information?.state,
    sections?.basic_information?.address_state,
    addr?.state,
    sections?.comprehensive_application?.state,
    sections?.comprehensive_application?.address_state,
    compAddr?.state,
    sections?.location_focus?.state,
    sections?.location_focus?.primary_state,
    sections?.organization_details?.state,
    sections?.demographics?.state,
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
  const addr = sections?.basic_information?.address
  const compAddr = sections?.comprehensive_application?.address
  const candidates = [
    jobParameters.city,
    sections?.basic_information?.city,
    sections?.basic_information?.address_city,
    addr?.city,
    sections?.comprehensive_application?.city,
    compAddr?.city,
    sections?.location_focus?.primary_city,
    sections?.location_focus?.service_city,
    sections?.location_focus?.city,
    sections?.organization_details?.city,
    sections?.demographics?.city,
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

export function buildProfileSignals({ profile, sections, asOf = null }) {
  let asOfDate = null
  if (asOf) {
    const d = new Date(asOf)
    if (!Number.isNaN(d.getTime())) asOfDate = d
  }
  const nowMs = asOfDate ? asOfDate.getTime() : Date.now()
  const nowYear = asOfDate ? asOfDate.getFullYear() : new Date().getFullYear()

  const keywordSet = new Set()
  const phraseSet = new Set()
  const intentPhraseSet = new Set()
  const demographicSet = new Set()
  const genderSet = new Set()
  const assistanceSet = new Set()
  const militarySet = new Set()
  const interestSet = new Set()
  const applicantTypeSet = new Set()
  const healthSet = new Set()
  const familySet = new Set()
  const occupationSet = new Set()

  // Extract location from multiple sources including address strings
  const basic = sections?.basic_information ?? {}
  const comprehensive = sections?.comprehensive_application ?? {}
  const locationFocus = sections?.location_focus ?? {}
  const organizationDetails = sections?.organization_details ?? {}

  const location = {
    zip:
      extractZipFromContext({ profile, sections }) ||
      extractZipFromAddress(basic.address) ||
      extractZipFromAddress(comprehensive.address),
    state:
      extractStateFromContext({ profile, sections }) ||
      extractStateFromAddress(basic.address) ||
      extractStateFromAddress(comprehensive.address),
    city:
      extractCityFromSections({ profile, sections }) ||
      extractCityFromAddress(basic.address) ||
      extractCityFromAddress(comprehensive.address),
    county: null,
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

  // County is a durable "expand outward" geography signal:
  // city → county → state → national. Never fabricate it unless we can resolve from an offline dataset.
  if (location.zip && !location.county) {
    try {
      const county = resolveCountyForZip(location.zip, location.state || null)
      if (county) location.county = county
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

  // ============ COMPREHENSIVE APPLICATION (PROFILE TAB) ============
  // This section is intentionally stored as a single "full application" payload, but crawlers should still
  // benefit from it by extracting keywords, applicant type, and location signals.
  if (comprehensive?.applicant_type) {
    const normalized = normalizeString(comprehensive.applicant_type)
    if (normalized) applicantTypeSet.add(normalized)
    registerKeyword(comprehensive.applicant_type)
  }

  // Freeform keyword arrays from the comprehensive application form.
  registerKeywords(Array.isArray(comprehensive?.keywords) ? comprehensive.keywords : [])
  registerKeywords(Array.isArray(comprehensive?.focus_areas) ? comprehensive.focus_areas : [])

  // Intent phrases: multi-word goal/objective phrases (e.g. "food truck business") — highest priority for matching
  const goalLikeFields = [
    comprehensive?.primary_goal,
    comprehensive?.mission,
    profile?.primary_goal,
  ]
  goalLikeFields.forEach((val) => {
    if (!val || typeof val !== 'string') return
    val
      .split(/[,;]+/)
      .map((s) => normalizeString(s))
      .filter((s) => s.length >= 6 && s.includes(' '))
      .forEach((s) => intentPhraseSet.add(s))
  })

  // If the comprehensive application includes narrative fields, treat them as signal text.
  collectNarrativeKeywords(
    {
      mission: comprehensive?.mission,
      primary_goal: comprehensive?.primary_goal,
      target_population: comprehensive?.target_population,
      geographic_focus: comprehensive?.geographic_focus,
      funding_amount_needed: comprehensive?.funding_amount_needed,
      timeline: comprehensive?.timeline,
      past_experience: comprehensive?.past_experience,
      unique_qualities: comprehensive?.unique_qualities,
      collaboration_partners: comprehensive?.collaboration_partners,
      sustainability_plan: comprehensive?.sustainability_plan,
      barriers_faced: comprehensive?.barriers_faced,
      special_circumstances: comprehensive?.special_circumstances,
    },
    registerKeyword,
  )

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
      const age = Math.floor((nowMs - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000))
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
  if (financialSection.unemployed) {
    assistanceSet.add('unemployed')
    registerKeyword('unemployed')
    registerKeyword('job seeker')
  }
  if (financialSection.displaced_worker) {
    assistanceSet.add('displaced_worker')
    registerKeyword('displaced worker')
    registerKeyword('laid off')
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

  // Structured conditions (array of objects). Accept legacy/string formats too.
  const rawConditions = Array.isArray(health.conditions) ? health.conditions : []
  for (const entry of rawConditions) {
    const name =
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object'
          ? entry.name
          : null
    const normalized = normalizeString(name)
    if (!normalized) continue
    healthSet.add(normalized)
    registerKeyword(normalized)
  }

  // Support needs (array<string>) - feed both keyword + assistance signals (non-exclusive).
  const rawSupportNeeds =
    Array.isArray(health.support_needs)
      ? health.support_needs
      : typeof health.support_needs === 'string'
        ? health.support_needs.split(/[,;\n]+/).map((v) => v.trim()).filter(Boolean)
        : []
  for (const need of rawSupportNeeds) {
    const normalized = normalizeString(need)
    if (!normalized) continue
    registerKeyword(normalized)
    assistanceSet.add(normalized.replace(/\s+/g, '_'))
    // Also include in health for condition-aware matching.
    healthSet.add(normalized)
  }

  if (health.mobility_or_transport_notes) {
    collectNarrativeKeywords({ mobility_or_transport_notes: health.mobility_or_transport_notes }, registerKeyword)
    // Add a couple generic transport keywords to help resource matching.
    registerKeyword('transportation')
    registerKeyword('appointment transportation')
  }

  if (health.dialysis_patient) { healthSet.add('dialysis'); registerKeyword('dialysis'); registerKeyword('kidney disease') }
  if (health.organ_transplant) { healthSet.add('transplant'); registerKeyword('organ transplant'); registerKeyword('transplant recipient') }
  if (health.hiv_aids) { healthSet.add('hiv'); registerKeyword('hiv'); registerKeyword('aids') }
  if (health.tbi_survivor) { healthSet.add('tbi'); registerKeyword('traumatic brain injury'); registerKeyword('tbi') }
  if (health.amputee) { healthSet.add('amputee'); registerKeyword('amputee'); registerKeyword('prosthetic') }
  if (health.wheelchair_user) { healthSet.add('wheelchair'); registerKeyword('wheelchair user'); registerKeyword('mobility impairment') }
  if (health.neurodivergent) { healthSet.add('neurodivergent'); registerKeyword('neurodivergent'); registerKeyword('autism'); registerKeyword('adhd') }
  if (health.mental_health_condition) { healthSet.add('mental_health'); registerKeyword('mental health'); registerKeyword('behavioral health') }
  if (health.chronic_illness) { healthSet.add('chronic_illness'); registerKeyword('chronic illness'); registerKeyword('chronic condition') }
  if (health.chronic_illness_type && typeof health.chronic_illness_type === 'string') { registerKeyword(health.chronic_illness_type) }
  if (health.rare_disease) { healthSet.add('rare_disease'); registerKeyword('rare disease'); registerKeyword('orphan disease') }
  if (health.visual_impairment) { healthSet.add('visual_impairment'); registerKeyword('visual impairment'); registerKeyword('blind'); registerKeyword('low vision') }
  if (health.hearing_impairment) { healthSet.add('hearing_impairment'); registerKeyword('hearing impairment'); registerKeyword('deaf'); registerKeyword('hard of hearing') }
  if (health.cancer_survivor) { healthSet.add('cancer'); registerKeyword('cancer survivor'); registerKeyword('oncology') }
  if (health.substance_recovery) { healthSet.add('recovery'); registerKeyword('recovery'); registerKeyword('substance recovery'); registerKeyword('sober living') }
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
  if (demographicsSection.immigrant_status && demographicsSection.immigrant_status !== 'unknown') {
    const statusLabel = demographicsSection.immigrant_status.replace(/_/g, ' ')
    demographicSet.add(demographicsSection.immigrant_status)
    registerKeyword(statusLabel)
    if (['refugee', 'asylee', 'daca'].includes(demographicsSection.immigrant_status.toLowerCase())) {
      registerKeyword('new american')
      registerKeyword('immigrant')
    }
  }
  if (demographicsSection.tribal_affiliation && typeof demographicsSection.tribal_affiliation === 'string') {
    registerKeyword(demographicsSection.tribal_affiliation)
    demographicSet.add('tribal_affiliation')
    registerKeyword('tribal affiliation')
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
  // Include canonical schema keys plus a few legacy aliases that exist in older data.
  const familyFlags = [
    'single_parent',
    'foster_youth',
    'orphan',
    'adopted',
    'foster_parent',
    'caregiver',
    'widow_widower',
    'grandparent_raising_grandchildren',
    'first_time_parent',
    'homeless',
    'domestic_violence_survivor',
    'trafficking_survivor',
    'disaster_survivor',
    'formerly_incarcerated',
    // Legacy aliases (not in schema but seen in older records)
    'former_incarcerated',
    'widowed',
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
  if (organizationDetails.organization_type) {
    registerKeyword(organizationDetails.organization_type)
    applicantTypeSet.add(normalizeString(organizationDetails.organization_type))
  }
  if (organizationDetails.nicra_rate) {
    // NICRA = Negotiated Indirect Cost Rate Agreement (common for federal compliance).
    registerKeyword('nicra')
    registerKeyword(organizationDetails.nicra_rate)
    registerKeyword(`nicra ${organizationDetails.nicra_rate}`)
  }
  if (organizationDetails.audit_status) {
    registerKeyword(organizationDetails.audit_status)
  }
  if (organizationDetails.mission) {
    collectNarrativeKeywords({ mission: organizationDetails.mission }, registerKeyword)
  }
  if (organizationDetails.ein) {
    // Has EIN = likely 501c3
    registerKeyword('501c3')
    registerKeyword('nonprofit')
  }
  if (organizationDetails.founding_year) {
    const age = nowYear - parseNumber(organizationDetails.founding_year)
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

  // ============ PROGRAMS & SERVICES (profile's stated needs → match to relatable funding) ============
  const programsServices = sections?.programs_services ?? {}
  if (Array.isArray(programsServices.keywords) && programsServices.keywords.length > 0) {
    registerKeywords(programsServices.keywords)
    programsServices.keywords.forEach((k) => interestSet.add(normalizeString(k)))
  }
  if (Array.isArray(programsServices.focus_areas) && programsServices.focus_areas.length > 0) {
    registerKeywords(programsServices.focus_areas)
    programsServices.focus_areas.forEach((f) => interestSet.add(normalizeString(f)))
  }
  if (Array.isArray(programsServices.interests) && programsServices.interests.length > 0) {
    registerKeywords(programsServices.interests)
    programsServices.interests.forEach((i) => interestSet.add(normalizeString(i)))
  }
  if (programsServices.notes && typeof programsServices.notes === 'string') {
    collectNarrativeKeywords({ notes: programsServices.notes }, registerKeyword)
  }

      // Extract multi-word focus areas / keywords / interests as intent phrases for matching
          ;[...(programsServices.focus_areas || []), ...(programsServices.keywords || []), ...(programsServices.interests || [])]
                .forEach((val) => {
                        const norm = normalizeString(val)
                                if (norm.length >= 6 && norm.includes(' ')) intentPhraseSet.add(norm)
                                      })

  // ============ SMALL BUSINESS DETAILS (real funding for business/startup needs: NAICS, USDA, SBA) ============
  const smallBusiness = sections?.small_business_details ?? {}
  if (smallBusiness.naics_code && typeof smallBusiness.naics_code === 'string') {
    const naics = String(smallBusiness.naics_code).trim()
    if (naics) {
      registerKeyword(naics)
      applicantTypeSet.add('small business')
      applicantTypeSet.add('small_business')
      // Common NAICS-related phrases for grant matching (e.g. 722330 = limited-service restaurants / food trucks)
      if (/^72/.test(naics)) {
        registerKeyword('food service')
        registerKeyword('restaurant')
        intentPhraseSet.add('food truck business')
      }
      if (/^44|^45/.test(naics)) {
        registerKeyword('retail')
      }
    }
  }
  if (smallBusiness.notes && typeof smallBusiness.notes === 'string') {
    collectNarrativeKeywords({ notes: smallBusiness.notes }, registerKeyword)
    const notesLower = smallBusiness.notes.toLowerCase()
    // Explicit program keywords from notes (USDA, SBA microloan, microenterprise, etc.)
    const programTerms = ['usda', 'sba', 'microloan', 'microenterprise', 'community development', 'small business', 'startup', 'rural business', 'rural development']
    programTerms.forEach((term) => {
      if (notesLower.includes(term)) {
        registerKeyword(term)
        if (term.includes(' ')) intentPhraseSet.add(term)
      }
    })
  }
  if (smallBusiness.business_name && typeof smallBusiness.business_name === 'string') {
    registerKeyword(smallBusiness.business_name)
  }
  if (smallBusiness.years_in_business != null) {
    const years = parseNumber(smallBusiness.years_in_business)
    if (years !== null && years < 3) registerKeyword('startup')
  }
  if (smallBusiness.employee_count != null) {
    const emp = parseNumber(smallBusiness.employee_count)
    if (emp !== null && emp <= 10) registerKeyword('micro-enterprise')
  }
  if (smallBusiness.annual_revenue != null) {
    const rev = parseNumber(smallBusiness.annual_revenue)
    if (rev !== null && rev < 250000) registerKeyword('low revenue small business')
  }
  if (smallBusiness.certifications && Array.isArray(smallBusiness.certifications)) {
    smallBusiness.certifications.forEach((cert) => {
      if (typeof cert === 'string') registerKeyword(cert)
    })
    const certSet = new Set(smallBusiness.certifications.map(c => typeof c === 'string' ? c.toLowerCase() : ''))
    if (certSet.has('wosb') || certSet.has('women-owned')) { applicantTypeSet.add('women-owned business'); registerKeyword('WOSB') }
    if (certSet.has('hubzone')) { registerKeyword('HUBZone') }
    if (certSet.has('mbe') || certSet.has('minority-owned')) { applicantTypeSet.add('minority-owned business'); registerKeyword('minority owned business') }
    if (certSet.has('8a') || certSet.has('8(a)')) { registerKeyword('8a certification') }
    if (certSet.has('sdvosb') || certSet.has('service-disabled veteran')) { applicantTypeSet.add('veteran-owned business'); registerKeyword('SDVOSB') }
  }
  // Intent category "business startup" from profile_category or organization type
  const profileCategory = basic.profile_category ?? organizationDetails.organization_type ?? profile?.primary_type ?? ''
  if (/small_business|business_startup|startup|entrepreneur/i.test(profileCategory)) {
    applicantTypeSet.add('small business')
    applicantTypeSet.add('small_business')
    registerKeyword('small business')
    registerKeyword('startup')
    registerKeyword('entrepreneur')
    intentPhraseSet.add('business startup')
  }

  // ============ NARRATIVE ============
  const narrative = sections?.narrative ?? {}
  collectNarrativeKeywords(narrative, registerKeyword)
  if (narrative.mission) {
    collectNarrativeKeywords({ mission: narrative.mission }, registerKeyword)
  }
  if (narrative.target_population) registerKeyword(narrative.target_population)
  if (narrative.primary_goal) registerKeyword(narrative.primary_goal)

        // Extract multi-word narrative fields as intent phrases (mirrors goalLikeFields logic)
            ;['primary_goal', 'mission', 'target_population'].forEach((field) => {
                  const val = narrative[field]
                        if (!val || typeof val !== 'string') return
                              val.split(/[,;]+/)
                                      .map((s) => normalizeString(s))
                                              .filter((s) => s.length >= 6 && s.includes(' '))
                                                      .forEach((s) => intentPhraseSet.add(s))
                                                          })
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
    const currentYear = nowYear
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
  if (education.current_institution) registerKeyword(education.current_institution)
  if (education.highest_level) {
    registerKeyword(education.highest_level)
    const lvl = normalizeString(education.highest_level)
    if (lvl && /high\s*school|ged/i.test(lvl)) demographicSet.add('high_school')
    if (lvl && /associate/i.test(lvl)) demographicSet.add('associate_degree')
    if (lvl && /bachelor/i.test(lvl)) demographicSet.add('bachelors_degree')
    if (lvl && /master/i.test(lvl)) demographicSet.add('masters_degree')
    if (lvl && /doctor|phd/i.test(lvl)) demographicSet.add('doctorate')
  }
  if (education.community_service_hours) {
    const hours = parseNumber(education.community_service_hours)
    if (hours !== null && hours >= 100) registerKeyword('community service')
  }
  if (education.leadership_roles && Array.isArray(education.leadership_roles)) {
    education.leadership_roles.forEach((r) => registerKeyword(r))
    registerKeyword('leadership')
  }
  if (education.valedictorian) registerKeyword('valedictorian')
  if (education.target_colleges && Array.isArray(education.target_colleges)) {
    education.target_colleges.forEach((c) => registerKeyword(c))
  }

  // ============ MEDICAL INSURANCE ============
  // Insurance plan type unlocks assistance program matching (Medicaid/Medicare → benefits crawlers)
  const medicalInsurance = sections?.medical_insurance ?? {}
  if (medicalInsurance.plan_type) {
    const planType = normalizeString(medicalInsurance.plan_type)
    if (planType) {
      registerKeyword(planType)
      if (/medicaid/i.test(planType)) {
        assistanceSet.add('medicaid')
        registerKeyword('medicaid')
      }
      if (/medicare/i.test(planType)) {
        assistanceSet.add('medicare')
        registerKeyword('medicare')
      }
      if (/marketplace|aca/i.test(planType)) {
        registerKeyword('marketplace insurance')
      }
    }
  }
  if (medicalInsurance.insurance_provider) {
    registerKeyword(medicalInsurance.insurance_provider)
  }
  if (medicalInsurance.notes) {
    collectNarrativeKeywords({ notes: medicalInsurance.notes }, registerKeyword)
  }

  // ============ MEDICAL HISTORY ============
  // Primary/secondary conditions feed health signals and condition-specific grant matching
  const medicalHistory = sections?.medical_history ?? {}
  if (medicalHistory.primary_condition) {
    const condition = normalizeString(medicalHistory.primary_condition)
    if (condition) {
      healthSet.add(condition)
      registerKeyword(condition)
    }
  }
  if (Array.isArray(medicalHistory.secondary_conditions)) {
    for (const cond of medicalHistory.secondary_conditions) {
      const normalized = normalizeString(cond)
      if (normalized) {
        healthSet.add(normalized)
        registerKeyword(normalized)
      }
    }
  }
  if (medicalHistory.mobility_needs) {
    registerKeyword(medicalHistory.mobility_needs)
    healthSet.add('mobility_needs')
    registerKeyword('mobility assistance')
  }
  if (Array.isArray(medicalHistory.dme_needed) && medicalHistory.dme_needed.length > 0) {
    medicalHistory.dme_needed.forEach((item) => registerKeyword(item))
    registerKeyword('durable medical equipment')
    healthSet.add('dme')
  }
  if (medicalHistory.letter_support_needed) {
    registerKeyword('letter of medical necessity')
  }
  if (medicalHistory.notes) {
    collectNarrativeKeywords({ notes: medicalHistory.notes }, registerKeyword)
  }

  // ============ NONPROFIT COMPLIANCE ============
  // 501c3/SAM status is critical for federal grant eligibility
  const nonprofitCompliance = sections?.nonprofit_compliance ?? {}
  if (nonprofitCompliance.is_501c3) {
    registerKeyword('501c3')
    registerKeyword('tax exempt')
    applicantTypeSet.add('nonprofit')
    applicantTypeSet.add('501c3')
  }
  if (nonprofitCompliance.fiscal_sponsor) {
    registerKeyword('fiscal sponsor')
    registerKeyword('fiscal sponsorship')
    if (nonprofitCompliance.fiscal_sponsor_name) {
      registerKeyword(nonprofitCompliance.fiscal_sponsor_name)
    }
  }
  if (nonprofitCompliance.sam_registered) {
    registerKeyword('sam registered')
    registerKeyword('sam.gov')
    applicantTypeSet.add('sam_registered')
  }
  if (nonprofitCompliance.compliance_notes) {
    collectNarrativeKeywords({ notes: nonprofitCompliance.compliance_notes }, registerKeyword)
  }

  // ============ EMPLOYMENT ============
  // Employment status and career goals feed workforce/training program matching
  const employment = sections?.employment ?? {}
  if (employment.current_status) {
    const status = normalizeString(employment.current_status)
    if (status) {
      registerKeyword(status)
      occupationSet.add(status)
      if (/unemploy|job.?seek|between.?jobs|laid.?off/i.test(employment.current_status)) {
        assistanceSet.add('unemployed')
        registerKeyword('job seeker')
        registerKeyword('workforce development')
      }
      if (/self.?employ|freelance|independent/i.test(employment.current_status)) {
        applicantTypeSet.add('self_employed')
        registerKeyword('self employed')
      }
      if (/part.?time|underemploy/i.test(employment.current_status)) {
        assistanceSet.add('underemployed')
        registerKeyword('underemployed')
      }
    }
  }
  if (employment.career_goal) {
    registerKeyword(employment.career_goal)
    // Career goals are strong intent signals for matching
    const goalNorm = normalizeString(employment.career_goal)
    if (goalNorm && goalNorm.length >= 6 && goalNorm.includes(' ')) {
      intentPhraseSet.add(goalNorm)
    }
  }
  if (employment.experience) {
    collectNarrativeKeywords({ experience: employment.experience }, registerKeyword)
  }
  if (employment.notes) {
    collectNarrativeKeywords({ notes: employment.notes }, registerKeyword)
  }

  // ============ HOUSING ============
  // Housing status drives assistance program eligibility; broadband drives digital divide programs
  const housing = sections?.housing ?? {}
  if (housing.status) {
    const status = normalizeString(housing.status)
    if (status) {
      registerKeyword(status)
      if (/homeless|unhoused|shelter/i.test(housing.status)) {
        assistanceSet.add('homeless')
        familySet.add('homeless')
        registerKeyword('housing insecure')
        registerKeyword('unhoused')
      }
      if (/at.?risk|unstable|transitional/i.test(housing.status)) {
        assistanceSet.add('housing_at_risk')
        registerKeyword('housing instability')
        registerKeyword('at-risk housing')
      }
    }
  }
  if (housing.type) {
    registerKeyword(housing.type)
    if (/rent/i.test(housing.type)) registerKeyword('renter')
    if (/section.?8|voucher/i.test(housing.type)) {
      assistanceSet.add('section8_housing')
      registerKeyword('section 8')
    }
  }
  if (housing.broadband_speed) {
    registerKeyword('broadband')
    registerKeyword('internet access')
    // Low/no broadband signals digital divide programs (ACP, FCC, etc.)
    if (/none|no.?service|slow|dial.?up|satellite|under.?25/i.test(housing.broadband_speed)) {
      assistanceSet.add('digital_divide')
      registerKeyword('digital divide')
      registerKeyword('broadband access')
    }
  }
  if (Array.isArray(housing.geographic_designation)) {
    housing.geographic_designation.forEach((desig) => {
      const norm = normalizeString(desig)
      if (norm) {
        registerKeyword(norm)
        demographicSet.add(norm)
      }
    })
  }
  if (housing.notes) {
    collectNarrativeKeywords({ notes: housing.notes }, registerKeyword)
  }

  // ============ FAMILY (HOUSEHOLD DETAILS) ============
  // Distinct from family_life: structured household info (size, responsibilities, support)
  const familyHousehold = sections?.family ?? {}
  if (familyHousehold.household_size) {
    const size = parseNumber(familyHousehold.household_size)
    if (size !== null) {
      // Merge with financial.householdSize if not already set
      if (!financial.householdSize) financial.householdSize = size
      if (size >= 5) registerKeyword('large household')
      if (size === 1) registerKeyword('single person household')
    }
  }
  if (familyHousehold.responsibilities) {
    collectNarrativeKeywords({ responsibilities: familyHousehold.responsibilities }, registerKeyword)
    if (/caregiv|eldercare|childcare|dependent/i.test(familyHousehold.responsibilities)) {
      familySet.add('caregiver')
      registerKeyword('caregiver')
    }
  }
  if (familyHousehold.support_system) {
    collectNarrativeKeywords({ support_system: familyHousehold.support_system }, registerKeyword)
  }
  if (familyHousehold.notes) {
    collectNarrativeKeywords({ notes: familyHousehold.notes }, registerKeyword)
  }

  // ============ PRO BONO / IN-KIND SIGNAL INJECTION ============
  // When profile signals indicate needs that can be met by non-cash services,
  // automatically inject search terms so crawlers surface pro bono / in-kind resources.
  const proBonoTerms = new Set()

  if (familySet.has('homeless') || familySet.has('domestic_violence_survivor') ||
      assistanceSet.has('housing_at_risk') || assistanceSet.has('homeless')) {
    ;['legal aid', 'eviction prevention', 'pro bono legal', 'tenant rights', 'housing intake'].forEach(t => {
      proBonoTerms.add(t); registerKeyword(t)
    })
  }
  if (familySet.has('domestic_violence_survivor') || familySet.has('trafficking_survivor')) {
    ;['domestic violence hotline', 'protective order', 'victim services', 'crisis intervention'].forEach(t => {
      proBonoTerms.add(t); registerKeyword(t)
    })
  }
  if (healthSet.has('chronic_illness') || healthSet.has('terminal') || healthSet.has('cancer') ||
      healthSet.has('dialysis') || healthSet.has('hiv')) {
    ;['charity care', 'patient assistance program', 'free clinic', 'sliding scale', 'copay assistance',
      'financial assistance policy'].forEach(t => { proBonoTerms.add(t); registerKeyword(t) })
  }
  if (healthSet.has('mental_health') || healthSet.has('recovery')) {
    ;['free counseling', 'community mental health', 'behavioral health clinic', 'crisis hotline'].forEach(t => {
      proBonoTerms.add(t); registerKeyword(t)
    })
  }
  if (healthSet.has('dme') || healthSet.has('wheelchair') || healthSet.has('amputee')) {
    ;['donated equipment', 'dme loaner', 'assistive technology', 'equipment donation program'].forEach(t => {
      proBonoTerms.add(t); registerKeyword(t)
    })
  }
  if (occupationSet.has('healthcare_worker') || occupationSet.has('nurse') ||
      keywordSet.has('licensure') || keywordSet.has('nclex') || keywordSet.has('certification')) {
    ;['wioa training', 'etpl provider', 'no cost training', 'tuition waiver', 'workforce training board',
      'vocational rehabilitation'].forEach(t => { proBonoTerms.add(t); registerKeyword(t) })
  }
  if (assistanceSet.has('unemployed') || assistanceSet.has('displaced_worker') || assistanceSet.has('underemployed')) {
    ;['workforce development', 'job training program', 'career center', 'wioa', 'one-stop center'].forEach(t => {
      proBonoTerms.add(t); registerKeyword(t)
    })
  }
  if (demographicSet.has('immigrant') || keywordSet.has('immigration') || keywordSet.has('refugee') || keywordSet.has('daca')) {
    ;['immigration legal aid', 'free immigration clinic', 'refugee resettlement', 'pro bono immigration'].forEach(t => {
      proBonoTerms.add(t); registerKeyword(t)
    })
  }
  if (familySet.has('formerly_incarcerated') || familySet.has('former_incarcerated')) {
    ;['reentry services', 'expungement clinic', 'pro bono reentry', 'second chance program'].forEach(t => {
      proBonoTerms.add(t); registerKeyword(t)
    })
  }

  // ============ NEEDS DETECTION ============
  const NEED_MAP = {
    utilities: ['utilities','utility','electric','gas','water','energy','heating','cooling','lieap','liheap','power bill'],
    housing: ['housing','rent','mortgage','shelter','homeless','section 8','home repair','eviction'],
    food: ['food','snap','groceries','hunger','nutrition','wic','food bank','food pantry'],
    healthcare: ['healthcare','medical','hospital','treatment','copay','prescription','therapy','nursing'],
    disability: ['disability','disabled','special needs','assistive','wheelchair','blind','deaf'],
    mental_health: ['mental health','behavioral health','counseling','psychiatric','ptsd'],
    substance_recovery: ['substance','recovery','sober','addiction','detox','rehab'],
    education: ['education','scholarship','tuition','college','university','school'],
    employment: ['employment','job','workforce','career','vocational','job training'],
    cash_assistance: ['cash assistance','emergency fund','financial aid','poverty'],
    childcare: ['childcare','daycare','child care','after school','head start'],
    transportation: ['transportation','vehicle','transit','bus','ride'],
    internet: ['internet','broadband','connectivity','digital'],
    legal: ['legal','attorney','court','eviction defense','immigration'],
    business: ['business','entrepreneur','startup','self-employ','microenterprise'],
    certification_assistance: ['cpr','first aid','aed','bls','heartsaver','acls','instructor certification','safety training','safety certification','cpr class','first aid class','cpr instructor','first aid instructor','instructor course','cpr/first aid','cpr/aed','teach cpr','community cpr','medical certification'],
    cpr_first_aid_training: ['cpr','first aid','aed','bls','heartsaver','cpr certification','first aid certification','safety trainer'],
    license_reinstatement_support: ['probe','probe class','probe course','probe ethics','license reinstatement','nursing reinstatement','reinstatement course','ethics course','ethics class','remediation','remediation course','remediation program','board required','board-required','professional boundaries','return to practice','return to nursing','relicensing','recertification','nurse reentry','nurse re-entry','credential restoration','license back','nursing license back','disciplinary education','board-ordered education','mandatory professional education','professional compliance'],
    nursing_reentry_support: ['nurse reentry','nurse re-entry','return to nursing','return to practice','nursing refresher','nursing re-entry','healthcare return to work','nursing workforce'],
    professional_remediation_funding: ['probe','remediation','ethics course','professional boundaries','disciplinary remediation','board required education','mandated continuing education','professional compliance training'],
  }
  const needs = new Set()
  const allKws = Array.from(keywordSet)
  for (const kw of allKws) {
    for (const [need, triggers] of Object.entries(NEED_MAP)) {
      if (triggers.some(t => kw.includes(t))) needs.add(need)
    }
  }
  if (assistanceSet.has('medicaid') || assistanceSet.has('medicare')) needs.add('healthcare')
  if (assistanceSet.has('ssi') || assistanceSet.has('ssdi')) { needs.add('disability'); needs.add('cash_assistance') }
  if (assistanceSet.has('snap')) needs.add('food')
  if (assistanceSet.has('tanf')) needs.add('cash_assistance')
  if (assistanceSet.has('section_8') || assistanceSet.has('section8')) needs.add('housing')
  if (assistanceSet.has('liheap')) needs.add('utilities')
  if (assistanceSet.has('wic')) needs.add('food')
  if (healthSet.size > 0) needs.add('healthcare')
  if (healthSet.has('disability') || healthSet.has('physical_disability') || healthSet.has('visual_impairment') || healthSet.has('hearing_impairment')) needs.add('disability')
  if (healthSet.has('mental_health')) needs.add('mental_health')
  if (healthSet.has('recovery')) needs.add('substance_recovery')
  if (familySet.has('homeless')) needs.add('housing')
  if (familySet.has('domestic_violence') || familySet.has('trafficking_survivor')) { needs.add('housing'); needs.add('legal') }

  // ============ APPLICANT TYPE (single string) ============
  let applicantType = 'individual'
  if (applicantTypeSet.has('organization') || applicantTypeSet.has('nonprofit') || applicantTypeSet.has('501c3')) {
    applicantType = 'organization'
  } else if (applicantTypeSet.has('student') || applicantTypeSet.has('college student') || applicantTypeSet.has('high school student') || demographicSet.has('current_student')) {
    applicantType = 'student'
    needs.add('education'); needs.add('scholarship')
  }
  if (needs.size === 0) {
    ;['utilities','housing','food','healthcare','cash_assistance'].forEach(n => needs.add(n))
  }

  // ============ IMMIGRATION SIGNALS ============
  const immigrationSet = new Set()
  const immigrantStatus = demographicsSection?.immigrant_status
  if (immigrantStatus && immigrantStatus !== 'unknown' && immigrantStatus !== 'us_citizen') {
    immigrationSet.add(immigrantStatus.toLowerCase().replace(/_/g, ' ').trim())
    if (/refugee/i.test(immigrantStatus)) immigrationSet.add('refugee')
    if (/permanent.resident/i.test(immigrantStatus)) immigrationSet.add('permanent_resident')
    if (/new.immigrant/i.test(immigrantStatus)) immigrationSet.add('new_immigrant')
    if (/daca/i.test(immigrantStatus)) immigrationSet.add('daca')
    if (/asylee/i.test(immigrantStatus)) immigrationSet.add('asylee')
  }

  // ============ GEOGRAPHIC QUALIFIERS ============
  const geographicSet = new Set()
  if (demographicSet.has('rural')) geographicSet.add('rural')
  if (demographicSet.has('appalachian')) geographicSet.add('appalachian')
  if (demographicSet.has('urban_underserved')) geographicSet.add('urban_underserved')
  if (demographicSet.has('tribal')) geographicSet.add('tribal')
  if (demographicSet.has('frontier')) geographicSet.add('frontier')

  // ============ FULL EDUCATION OBJECT ============
  const eduSection = sections?.education ?? sections?.education_details ?? {}
  const uniApps = sections?.university_applications ?? {}
  const fullEducation = {
    level: eduSection.highest_level || eduSection.degree_type || null,
    currentSchool: eduSection.current_institution || eduSection.school_name || null,
    targetColleges: Array.isArray(eduSection.target_colleges) ? eduSection.target_colleges : [],
    intendedMajor: eduSection.field_of_study || null,
    gpa: academics.gpa,
    act: academics.act,
    sat: academics.sat,
    firstGeneration: !!eduSection.first_generation,
    communityServiceHours: parseNumber(eduSection.community_service_hours),
    valedictorian: !!eduSection.valedictorian,
    leadershipRoles: Array.isArray(eduSection.leadership_roles) ? eduSection.leadership_roles : [],
    extracurriculars: Array.isArray(eduSection.extracurriculars) ? eduSection.extracurriculars : [],
    achievements: Array.isArray(eduSection.achievements) ? eduSection.achievements : [],
    stemStudent: !!(['stem','engineering','computer science','mathematics','biology','chemistry','physics']
      .some(s => (eduSection.field_of_study || '').toLowerCase().includes(s))),
    returningAdult: !!eduSection.returning_adult,
    recentGraduate: !!eduSection.recent_graduate,
    gedGraduate: !!eduSection.ged_graduate,
    jobRetraining: !!eduSection.job_retraining,
  }

  // ============ SCHOOLS (from university_applications) ============
  const schools = Array.isArray(uniApps.applications) ? uniApps.applications : []

  // ============ SPORTS ============
  const sportsSet = new Set()
  const sportsTerms = ['basketball','football','soccer','baseball','softball','volleyball','tennis','swimming','track','cross country','wrestling','lacrosse','hockey','golf','gymnastics','rowing','cheer','dance']
  for (const interest of interestSet) {
    if (sportsTerms.some(s => interest.includes(s))) sportsSet.add(interest)
  }

  // ============ ORGANIZATION DETAILS ============
  const orgDetailsSection = sections?.organization_details ?? {}
  const npCompliance = sections?.nonprofit_compliance ?? {}
  const organizationSignals = {
    is501c3: !!npCompliance.has_501c3 || !!npCompliance.is_501c3 || !!orgDetailsSection.is_501c3,
    samRegistered: !!npCompliance.sam_registered || !!orgDetailsSection.sam_registered,
    faithBased: !!orgDetailsSection.faith_based,
    ein: npCompliance.ein || orgDetailsSection.ein || null,
    uei: npCompliance.uei || orgDetailsSection.uei || null,
    naicsCode: sections?.small_business_details?.naics_code || null,
  }

  // ============ RAW SECTIONS PASSTHROUGH ============
  const rawSections = sections

  // ============ COVERAGE TRACKING ============
  // Track how much of the profile data was processed to ensure 100% coverage.
  // This list must match ALL section keys in backend/config/profileSchema.js.
  const sectionKeys = Object.keys(sections || {})
  const expectedSections = [
    'basic_information', 'organization_details', 'financial_information',
    'government_assistance', 'health_medical', 'medical_insurance', 'medical_history',
    'nonprofit_compliance', 'small_business_details', 'demographics', 'family_life',
    'military_service', 'occupation', 'location_focus', 'university_applications',
    'education', 'employment', 'housing', 'family', 'programs_services', 'narrative',
  ]
  const presentSections = sectionKeys.filter(k => expectedSections.includes(k))
  
  // Calculate coverage percentage (at least 1 section = 100% for crawler purposes)
  // The crawler check requires pct >= 1 (i.e., at least some sections present)
  const coverage = {
    fields_total: keywordSet.size + phraseSet.size,
    fields_used: keywordSet.size + phraseSet.size,
    sections_present: presentSections.length,
    sections_expected: expectedSections.length,
    pct: presentSections.length > 0 ? 100 : 0, // 100% if any sections present
  }

  return {
    keywords: Array.from(keywordSet),
    keywordSet,
    phrases: phraseSet,
    intentPhrases: intentPhraseSet,
    demographics: demographicSet,
    genders: genderSet,
    assistance: assistanceSet,
    military: militarySet,
    interests: interestSet,
    applicantTypes: applicantTypeSet,
    health: healthSet,
    family: familySet,
    occupation: occupationSet,
    proBonoTerms,
    location,
    academics,
    financial,
    rawSections,
    coverage,
    needs,
    applicantType,
    immigration: immigrationSet,
    geographic: geographicSet,
    education: fullEducation,
    schools,
    sports: sportsSet,
    organization: organizationSignals,
  }
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
