/**
 * Profile Normalizer
 *
 * Produces a canonical profile structure from raw profile + sections data.
 * Handles aliasing between old/new field names, entity type normalization,
 * need category normalization, and fingerprint computation.
 */

import { createHash } from 'crypto'
import { resolveApplicantType } from './profileHelpers.js'

// ---------------------------------------------------------------------------
// Need category alias map
// Multiple names can refer to the same canonical need bucket.
// ---------------------------------------------------------------------------
export const NEED_ALIAS_MAP = {
  // Housing / shelter
  housing: 'housing',
  housing_instability: 'housing',
  rent: 'housing',
  rental_assistance: 'housing',
  housing_repair: 'housing',
  home_repair: 'housing',
  homeless: 'housing',
  homelessness: 'housing',
  eviction: 'housing',
  eviction_prevention: 'housing',
  mortgage: 'housing',

  // Utilities
  utilities: 'utilities',
  utility: 'utilities',
  electric: 'utilities',
  gas: 'utilities',
  water: 'utilities',
  internet: 'utilities',

  // Medical / health
  medical: 'health_medical',
  health: 'health_medical',
  health_medical: 'health_medical',
  healthcare: 'health_medical',
  medical_bills: 'health_medical',
  prescription: 'health_medical',
  dental: 'health_medical',
  vision: 'health_medical',

  // Food
  food: 'food',
  nutrition: 'food',
  food_insecurity: 'food',
  groceries: 'food',
  snap: 'food',

  // Employment / workforce
  employment: 'employment',
  job: 'employment',
  jobs: 'employment',
  workforce: 'employment',
  job_training: 'employment',
  career: 'employment',

  // Education / student
  education: 'education',
  student: 'education',
  college: 'education',
  tuition: 'education',
  scholarship: 'education',
  school: 'education',
  training: 'education',
  vocational: 'education',
  financial_aid: 'education',

  // Disability
  disability: 'disability',
  chronic_illness: 'disability',
  adaptive_equipment: 'disability',
  assistive_technology: 'disability',
  dme: 'disability',

  // Caregiver / family
  caregiver: 'family_life',
  family: 'family_life',
  family_life: 'family_life',
  childcare: 'family_life',
  child_care: 'family_life',
  parenting: 'family_life',
  family_support: 'family_life',
  child: 'family_life',
  children: 'family_life',
  foster: 'family_life',
  adoption: 'family_life',

  // Transportation
  transportation: 'transportation',
  vehicle: 'transportation',
  car: 'transportation',
  bus: 'transportation',
  transit: 'transportation',

  // Business / entrepreneurship
  business: 'business',
  small_business: 'business',
  entrepreneurship: 'business',
  startup: 'business',
  self_employment: 'business',
  entrepreneur: 'business',
  microenterprise: 'business',

  // Nonprofit / church / faith-based
  nonprofit: 'nonprofit_ministry',
  church: 'nonprofit_ministry',
  faith: 'nonprofit_ministry',
  ministry: 'nonprofit_ministry',
  religious: 'nonprofit_ministry',
  community_organization: 'nonprofit_ministry',

  // Research / arts
  research: 'research_arts',
  arts: 'research_arts',
  artist: 'research_arts',
  culture: 'research_arts',
  creative: 'research_arts',

  // Emergency / crisis
  emergency: 'emergency',
  crisis: 'emergency',
  disaster: 'emergency',
  fema: 'emergency',
  emergency_assistance: 'emergency',

  // Veteran
  veteran: 'veteran',
  veterans: 'veteran',
  military: 'veteran',
  armed_forces: 'veteran',

  // Clothing / personal items
  clothing: 'clothing_goods',
  goods: 'clothing_goods',
  household_goods: 'clothing_goods',
  furniture: 'clothing_goods',
  uniforms: 'clothing_goods',
  work_clothing: 'clothing_goods',
  work_uniforms: 'clothing_goods',
  work_clothes: 'clothing_goods',
  professional_clothing: 'clothing_goods',
  interview_clothing: 'clothing_goods',

  // Technology / equipment / digital access
  technology: 'technology_equipment',
  computer: 'technology_equipment',
  laptop: 'technology_equipment',
  desktop: 'technology_equipment',
  tablet: 'technology_equipment',
  hotspot: 'technology_equipment',
  wifi: 'technology_equipment',
  broadband: 'technology_equipment',
  digital_access: 'technology_equipment',
  digital_equity: 'technology_equipment',
  digital_inclusion: 'technology_equipment',
  device: 'technology_equipment',
  phone: 'technology_equipment',
  cell_phone: 'technology_equipment',
  smartphone: 'technology_equipment',
  equipment: 'technology_equipment',

  // Cash assistance / financial aid
  cash_assistance: 'cash_assistance',
  income_support: 'cash_assistance',
  financial_assistance: 'cash_assistance',
  tanf: 'cash_assistance',
  ssi: 'cash_assistance',
  ssdi: 'cash_assistance',

  // Legal services
  legal: 'legal',
  legal_aid: 'legal',
  legal_help: 'legal',

  // Substance recovery — own canonical bucket so it can be filtered independently
  substance_recovery: 'substance_recovery',
  substance_abuse: 'substance_recovery',
  addiction: 'substance_recovery',
  rehab: 'substance_recovery',
  recovery: 'substance_recovery',

  // Mental health — split from health_medical for finer matching
  mental_health: 'mental_health',
  behavioral_health: 'mental_health',
  counseling: 'mental_health',
  therapy: 'mental_health',

  // Seniors / aging
  senior: 'senior',
  seniors: 'senior',
  elderly: 'senior',
  aging: 'senior',
  older_adult: 'senior',

  // Children / youth
  youth: 'children_youth',
  children_youth: 'children_youth',
  at_risk_youth: 'children_youth',
  juvenile: 'children_youth',
  young_people: 'children_youth',

  // Women
  women: 'women',
  female: 'women',
  women_owned: 'women',
  domestic_violence: 'women',

  // BIPOC / minority
  minority: 'minority',
  bipoc: 'minority',
  african_american: 'minority',
  hispanic: 'minority',
  latino: 'minority',
  underrepresented: 'minority',

  // Immigrant / refugee
  immigrant: 'immigrant_refugee',
  refugee: 'immigrant_refugee',
  immigrant_refugee: 'immigrant_refugee',
  resettlement: 'immigrant_refugee',
  asylum: 'immigrant_refugee',
  asylee: 'immigrant_refugee',

  // Tribal / native
  tribal: 'tribal',
  native_american: 'tribal',
  indigenous: 'tribal',
  indian_nation: 'tribal',

  // Fire / EMS / public safety
  fire_department: 'public_safety',
  volunteer_fire: 'public_safety',
  ems: 'public_safety',
  first_responder: 'public_safety',
  public_safety: 'public_safety',

  // Municipality / government
  municipality: 'municipality',
  county_government: 'municipality',
  city_government: 'municipality',
  local_government: 'municipality',

  // Environment / conservation
  environment: 'environment',
  conservation: 'environment',
  climate: 'environment',
  sustainability: 'environment',

  // Agriculture / farming
  agriculture: 'agriculture',
  farming: 'agriculture',
  ranch: 'agriculture',
  usda: 'agriculture',

  // Community development
  community_development: 'community_development',
  economic_development: 'community_development',
  revitalization: 'community_development',
  neighborhood: 'community_development',

  // Rural communities
  rural: 'rural',
  appalachian: 'rural',
  small_town: 'rural',
  underserved: 'rural',
}

// ---------------------------------------------------------------------------
// Entity type alias map
// ---------------------------------------------------------------------------
export const ENTITY_TYPE_ALIAS_MAP = {
  individual: 'individual',
  individual_need: 'individual',
  person: 'individual',
  family: 'individual',
  household: 'individual',
  adult: 'individual',
  senior: 'individual',

  student: 'student',
  college_student: 'student',
  graduate_student: 'student',
  high_school_student: 'student',
  k12_student: 'student',
  undergraduate: 'student',

  veteran: 'veteran',
  military_veteran: 'veteran',

  caregiver: 'caregiver',
  foster_parent: 'caregiver',
  parent: 'caregiver',

  nonprofit: 'nonprofit',
  '501c3': 'nonprofit',
  charity: 'nonprofit',
  ngo: 'nonprofit',
  community_organization: 'nonprofit',
  faith_based: 'nonprofit',
  church: 'nonprofit',
  ministry: 'nonprofit',
  religious_organization: 'nonprofit',
  volunteer_fire: 'nonprofit',
  fire_department: 'nonprofit',
  volunteer_fire_department: 'nonprofit',
  ems: 'nonprofit',
  emergency_services: 'nonprofit',
  fire_station: 'nonprofit',
  first_responder_org: 'nonprofit',
  rescue_squad: 'nonprofit',

  business: 'business',
  small_business: 'business',
  entrepreneur: 'business',
  startup: 'business',
  self_employed: 'business',
  llc: 'business',
  corporation: 'business',

  researcher: 'researcher',
  academic: 'researcher',
  scientist: 'researcher',
  faculty: 'researcher',

  artist: 'artist',
  creative: 'artist',

  organization: 'organization',
  institution: 'organization',
  government: 'organization',
  school: 'organization',
  school_district: 'organization',
  k12_school: 'organization',
  charter_school: 'organization',
  public_school: 'organization',
  private_school: 'organization',
  library: 'organization',
  housing_authority: 'organization',
  tribal_organization: 'organization',
}

// ---------------------------------------------------------------------------
// Normalize a need category string to canonical value
// ---------------------------------------------------------------------------
export function normalizeNeedCategory(raw) {
  if (!raw || typeof raw !== 'string') return null
  const key = raw.toLowerCase().trim().replace(/[\s-]+/g, '_')
  return NEED_ALIAS_MAP[key] ?? key
}

// ---------------------------------------------------------------------------
// Normalize entity type to canonical value
// ---------------------------------------------------------------------------
export function normalizeEntityType(raw) {
  if (!raw || typeof raw !== 'string') return null
  const key = raw.toLowerCase().trim().replace(/[\s-]+/g, '_')
  return ENTITY_TYPE_ALIAS_MAP[key] ?? key
}

// ---------------------------------------------------------------------------
// Safe JSON parse helper
// ---------------------------------------------------------------------------
function safeParseArray(val) {
  if (Array.isArray(val)) return val
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val)
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }
  return []
}

// ---------------------------------------------------------------------------
// Normalize a profile + sections into a canonical structure
// ---------------------------------------------------------------------------
/**
 * Normalize a raw profile and its sections into the canonical structure used
 * by the decision engine.
 *
 * @param {Object} rawProfile     - Raw profile row or { profile, sections } object
 * @param {Object|null} sections  - Profile sections keyed by section name
 * @param {Object|null} signals   - Optional signals object from buildProfileSignals().
 *   When provided, signals.needs (a Set of inferred need strings) is merged into
 *   needCategories after the normalizer's own extraction, canonicalized via NEED_ALIAS_MAP.
 *   This bridges the rich signal engine output into the scoring pipeline.
 * @returns {Object|null} Normalized profile or null if rawProfile is falsy
 */
export function normalizeProfile(rawProfile, sections = null, signals = null) {
  if (!rawProfile) return null

  const profile = rawProfile?.profile ?? rawProfile
  const profileSections = sections ?? rawProfile?.sections ?? {}

  // -- Entity type --
  const rawType =
    resolveApplicantType(profile) ??
    profile.type ??
    profile.entity_type ??
    null
  const entityType = normalizeEntityType(rawType)

  // -- Location: top-level first, then fall back to sections --
  let state = profile.state ?? profile.primary_state ?? null
  let zip = profile.postal_code ?? profile.zip_code ?? profile.zip ?? null
  let county = profile.county ?? null
  let city = profile.city ?? null

  // Extract location from sections if top-level is incomplete.
  // Check standard section keys used in real profile data.
  if ((!state || !zip) && profileSections) {
    const locationCandidates = [
      profileSections.basic_information,    // most common real section
      profileSections.location_focus,       // service/preferred location
      profileSections.location,
      profileSections.address,
      profileSections.contact_info,
    ]
    for (const section of locationCandidates) {
      if (!section) continue
      const la = section.answers ?? section
      if (!la || typeof la !== 'object') continue
      if (!state) {
        // Handle nested address objects like { address: { state: 'TN' } }
        const addrObj = la.address && typeof la.address === 'object' ? la.address : null
        state = la.state ?? la.primary_state ?? addrObj?.state ?? null
        // Parse state from a string address like "123 Main St, Nashville, TN 37201"
        if (!state && typeof la.address === 'string') {
          const m = la.address.match(/\b([A-Z]{2})\s*,?\s*\d{5}/)
          if (m) state = m[1]
        }
      }
      if (!zip) {
        const addrObj = la.address && typeof la.address === 'object' ? la.address : null
        zip = la.zip ?? la.postal_code ?? la.zip_code ?? addrObj?.zip ?? addrObj?.postal_code ?? null
      }
      if (!county) county = la.county ?? null
      if (!city) city = la.city ?? null
      if (state && zip) break // Got everything we need
    }
    // Also check organization section
    const orgSection = profileSections.organization ?? profileSections.org ?? null
    if (orgSection) {
      const oa = orgSection.answers ?? orgSection
      if (oa && typeof oa === 'object') {
        if (!state) state = oa.state ?? null
        if (!zip) zip = oa.zip ?? oa.postal_code ?? null
        if (!city) city = oa.city ?? null
      }
    }
  }

  // -- Need categories --
  const rawNeeds = [
    ...safeParseArray(profile.needs),
    ...safeParseArray(profile.need_categories),
    ...safeParseArray(profile.tags),
  ]

  // Pull needs from profile sections too
  if (profileSections) {
    for (const [sectionKey, sectionData] of Object.entries(profileSections)) {
      if (!sectionData) continue
      const answers = sectionData.answers ?? sectionData
      if (answers && typeof answers === 'object') {
        // Look for need-related section keys
        const needKeys = ['needs', 'need_categories', 'primary_needs', 'support_needs']
        for (const nk of needKeys) {
          if (answers[nk]) rawNeeds.push(...safeParseArray(answers[nk]))
        }
      }
      // Section key itself may be a need category (e.g. "medical", "housing")
      if (NEED_ALIAS_MAP[sectionKey.toLowerCase()]) {
        rawNeeds.push(sectionKey)
      }
      // Also handle '_information' suffix keys used in real profile sections
      // e.g. "health_information" → "health" → maps to "health_medical"
      // e.g. "housing_information" → "housing", "education_information" → "education"
      const baseKey = sectionKey.toLowerCase().replace(/_information$/, '')
      if (baseKey !== sectionKey.toLowerCase() && NEED_ALIAS_MAP[baseKey]) {
        rawNeeds.push(baseKey)
      }
    }
  }

  const needCategories = [...new Set(rawNeeds.map(normalizeNeedCategory).filter(Boolean))]

  // -- Merge signals.needs from buildProfileSignals() if provided --
  // The signal engine produces a richer set of inferred needs from profile sections
  // (healthcare, employment, cash_assistance, transportation, etc.) that normalizeProfile()
  // may not extract on its own. Merge these in using the alias map so they're canonical.
  if (signals?.needs instanceof Set) {
    for (const need of signals.needs) {
      const canonical = normalizeNeedCategory(need)
      if (canonical && !needCategories.includes(canonical)) {
        needCategories.push(canonical)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Derive richer signals from section content
  // ---------------------------------------------------------------------------

  // -- Veteran status: top-level flags or military_service section --
  let isVeteranFromSections = false
  const militarySection =
    profileSections?.military_service ??
    profileSections?.military ??
    profileSections?.veteran ??
    null
  if (militarySection) {
    const ma = militarySection.answers ?? militarySection
    if (ma && typeof ma === 'object') {
      isVeteranFromSections =
        Boolean(ma.is_veteran) ||
        Boolean(ma.veteran) ||                        // common field name: { veteran: true }
        Boolean(ma.served_in_military) ||
        Boolean(ma.military_service) ||
        Boolean(ma.veteran_status) ||
        String(ma.branch ?? '').length > 0 ||
        String(ma.military_branch ?? '').length > 0 || // common field: military_branch: "Army"
        String(ma.discharge_status ?? '').length > 0
    }
  }

  const isVeteran =
    Boolean(profile.is_veteran) ||
    entityType === 'veteran' ||
    needCategories.includes('veteran') ||
    String(rawType ?? '').toLowerCase().includes('veteran') ||
    isVeteranFromSections

  // -- Student status: top-level flags or education section --
  let isStudentFromSections = false
  const educationSection =
    profileSections?.education ??
    profileSections?.education_information ??
    profileSections?.student ??
    null
  if (educationSection) {
    const ea = educationSection.answers ?? educationSection
    if (ea && typeof ea === 'object') {
      isStudentFromSections =
        Boolean(ea.is_student) ||
        Boolean(ea.currently_enrolled) ||
        Boolean(ea.enrolled_in_school) ||
        Boolean(ea.first_generation) ||              // first-gen college student signal
        String(ea.school_name ?? '').length > 0 ||
        String(ea.grade_level ?? '').length > 0 ||
        String(ea.degree_program ?? '').length > 0 ||
        String(ea.field_of_study ?? '').length > 0 || // common field: field_of_study
        String(ea.highest_level ?? '').length > 0    // common field: highest_level: "high school"
    }
  }

  const isStudent =
    Boolean(profile.is_student) ||
    entityType === 'student' ||
    String(rawType ?? '').toLowerCase().includes('student') ||
    isStudentFromSections

  // -- Nonprofit status --
  // Includes volunteer fire departments, EMS organizations, churches, ministries, and
  // other community service organizations that operate as nonprofits even if not 501(c)(3).
  const rawTypeLower = String(rawType ?? '').toLowerCase()
  const isNonprofit =
    Boolean(profile.is_nonprofit) ||
    Boolean(profile.requires_501c3) ||
    entityType === 'nonprofit' ||
    rawTypeLower.includes('nonprofit') ||
    rawTypeLower.includes('volunteer_fire') ||
    rawTypeLower.includes('fire_department') ||
    rawTypeLower.includes('church') ||
    rawTypeLower.includes('ministry') ||
    rawTypeLower.includes('rescue_squad') ||
    rawTypeLower.includes('ems')

  // -- Business status: top-level flags or business section --
  let isBusinessFromSections = false
  const businessSection =
    profileSections?.business ??
    profileSections?.small_business_details ??       // common section key in real profiles
    profileSections?.self_employment ??
    profileSections?.entrepreneurship ??
    null
  if (businessSection) {
    const ba = businessSection.answers ?? businessSection
    if (ba && typeof ba === 'object') {
      isBusinessFromSections =
        Boolean(ba.owns_business) ||
        Boolean(ba.is_self_employed) ||
        Boolean(ba.has_business) ||
        String(ba.business_name ?? '').length > 0 ||
        String(ba.naics_code ?? '').length > 0 ||    // common business field
        String(ba.ein ?? '').length > 0
    }
  }

  const isBusiness =
    Boolean(profile.is_business) ||
    entityType === 'business' ||
    String(rawType ?? '').toLowerCase().includes('business') ||
    isBusinessFromSections

  // -- Caregiver / family: family_life section, dependents, foster indicators --
  let isCaregiverFromSections = false
  let hasFosterIndicator = false
  const familySection =
    profileSections?.family_life ??
    profileSections?.family ??
    profileSections?.caregiving ??
    null
  if (familySection) {
    const fa = familySection.answers ?? familySection
    if (fa && typeof fa === 'object') {
      isCaregiverFromSections =
        Boolean(fa.is_caregiver) ||
        Boolean(fa.provides_care) ||
        Boolean(fa.has_dependents) ||
        Boolean(fa.cares_for_family_member) ||
        Number(fa.number_of_dependents ?? 0) > 0 ||
        Number(fa.num_dependents ?? 0) > 0
      hasFosterIndicator =
        Boolean(fa.is_foster_parent) ||
        Boolean(fa.foster_care) ||
        Boolean(fa.has_foster_children) ||
        String(fa.foster_status ?? '').toLowerCase().includes('foster')
    }
  }

  const isCaregiver =
    Boolean(profile.is_caregiver) ||
    entityType === 'caregiver' ||
    isCaregiverFromSections ||
    needCategories.includes('family_life')

  // -- Disability / chronic illness / DME --
  let hasChronicIllnessFromSections = false
  const healthSection =
    profileSections?.health_medical ??
    profileSections?.health_information ??
    profileSections?.medical ??
    profileSections?.health ??
    null
  if (healthSection) {
    const ha = healthSection.answers ?? healthSection
    if (ha && typeof ha === 'object') {
      hasChronicIllnessFromSections =
        Boolean(ha.has_disability) ||
        Boolean(ha.has_chronic_illness) ||
        // common field: { chronic_illness: true }
        Boolean(ha.chronic_illness) ||
        Boolean(ha.has_medical_condition) ||
        Boolean(ha.needs_dme) ||
        Boolean(ha.uses_assistive_technology) ||
        String(ha.conditions ?? '').length > 0 ||
        // common fields: chronic_illness_type, disability_type
        String(ha.chronic_illness_type ?? '').length > 0 ||
        String(ha.disability_type ?? '').length > 0 ||
        safeParseArray(ha.diagnoses).length > 0
    }
  }

  const hasDisabilityNeed = needCategories.includes('disability') || hasChronicIllnessFromSections
  const hasChronicIllness = hasChronicIllnessFromSections || needCategories.includes('disability')

  // When chronic illness / disability is section-derived, ensure 'disability' appears in needCategories
  // so need alignment can match against opportunity needTypesSupported.
  if (hasChronicIllnessFromSections && !needCategories.includes('disability')) {
    needCategories.push('disability')
  }

  // -- Emergency / disaster context --
  let hasEmergencyFromSections = false
  const emergencySection =
    profileSections?.emergency ??
    profileSections?.disaster ??
    profileSections?.crisis ??
    null
  if (emergencySection) {
    const ema = emergencySection.answers ?? emergencySection
    if (ema && typeof ema === 'object') {
      hasEmergencyFromSections =
        Boolean(ema.has_emergency) ||
        Boolean(ema.disaster_affected) ||
        Boolean(ema.in_crisis) ||
        Boolean(ema.fema_eligible) ||
        String(ema.disaster_type ?? '').length > 0
    }
  }

  const hasEmergencyNeed = needCategories.includes('emergency') || hasEmergencyFromSections

  // Ensure 'emergency' appears in needCategories when section-derived emergency is detected
  if (hasEmergencyFromSections && !needCategories.includes('emergency')) {
    needCategories.push('emergency')
  }

  // -- Housing instability --
  let hasHousingInstabilityFromSections = false
  const housingSection =
    profileSections?.housing ??
    profileSections?.housing_information ??
    profileSections?.shelter ??
    null
  if (housingSection) {
    const hua = housingSection.answers ?? housingSection
    if (hua && typeof hua === 'object') {
      hasHousingInstabilityFromSections =
        Boolean(hua.housing_instability) ||
        Boolean(hua.risk_of_eviction) ||
        Boolean(hua.homeless) ||
        Boolean(hua.temporary_housing) ||
        String(hua.housing_situation ?? '').toLowerCase().includes('unstable') ||
        String(hua.housing_situation ?? '').toLowerCase().includes('evict')
    }
  }

  const hasHousingNeed = needCategories.includes('housing') || hasHousingInstabilityFromSections

  // Ensure 'housing' appears in needCategories when section-derived housing instability is detected
  if (hasHousingInstabilityFromSections && !needCategories.includes('housing')) {
    needCategories.push('housing')
  }

  // -- Employment need signals --
  let hasEmploymentNeed = false
  const employmentSection =
    profileSections?.employment ??
    profileSections?.employment_information ??
    profileSections?.work ??
    profileSections?.income ??
    null
  if (employmentSection) {
    const empa = employmentSection.answers ?? employmentSection
    if (empa && typeof empa === 'object') {
      hasEmploymentNeed =
        Boolean(empa.unemployed) ||
        Boolean(empa.seeking_employment) ||
        Boolean(empa.needs_job_training) ||
        Boolean(empa.underemployed) ||
        String(empa.employment_status ?? '').toLowerCase().includes('unemployed')
    }
  }

  // Ensure 'employment' appears in needCategories when section-derived employment need is detected
  if (hasEmploymentNeed && !needCategories.includes('employment')) {
    needCategories.push('employment')
  }

  const hasBusinessNeed = needCategories.includes('business') || isBusiness

  // Ensure 'business' appears in needCategories when business status is detected
  if (isBusiness && !needCategories.includes('business')) {
    needCategories.push('business')
  }

  // -- Financial information section: derive need categories from explicit content --
  // Real profiles store financial data in a 'financial_information' section which doesn't
  // directly map to a canonical need type. Parse its content to infer relevant needs.
  const financialSection =
    profileSections?.financial_information ??
    profileSections?.financial ??
    null
  if (financialSection) {
    const fa = financialSection.answers ?? financialSection
    if (fa && typeof fa === 'object') {
      // Combine all text fields to look for explicit need indicators
      const finText = [
        fa.notes, fa.challenges, fa.needs, fa.description, fa.financial_needs,
        fa.housing_costs, fa.rent_mortgage, fa.food_costs, fa.utility_costs,
      ].filter(Boolean).join(' ').toLowerCase()

      const finNeedKeywords = {
        housing: ['rent', 'housing', 'evict', 'mortgage'],
        food: ['food', 'groceries', 'hunger', 'nutrition'],
        utilities: ['utility', 'electric', 'gas bill', 'water bill', 'heating'],
        health_medical: ['medical', 'health', 'prescription'],
      }
      for (const [need, keywords] of Object.entries(finNeedKeywords)) {
        if (!needCategories.includes(need) && keywords.some((kw) => finText.includes(kw))) {
          needCategories.push(need)
        }
      }

      // Low-income household signals: add food and utilities as baseline needs
      const monthlyIncome = Number(fa.monthly_income ?? fa.income ?? 0)
      const annualIncome = Number(fa.annual_income ?? fa.household_income ?? 0)
      const isLowIncome = fa.is_low_income || fa.financial_hardship || fa.receives_benefits ||
        (monthlyIncome > 0 && monthlyIncome < 2000) ||
        (annualIncome > 0 && annualIncome < 24000)
      if (isLowIncome) {
        if (!needCategories.includes('food')) needCategories.push('food')
        if (!needCategories.includes('utilities')) needCategories.push('utilities')
      }
    }
  }

  // -- Age (for scholarship/senior eligibility) --
  const age = profile.age ?? null

  // -- Age group signal --
  const ageGroup = profile.age_group ?? null
  const demographicsSection = profileSections?.demographics ?? null
  let ageGroupFromSections = null
  if (demographicsSection) {
    const da = demographicsSection.answers ?? demographicsSection
    if (da && typeof da === 'object') {
      ageGroupFromSections = da.age_group ?? null
    }
  }
  const resolvedAgeGroup = ageGroup ?? ageGroupFromSections

  // -- Work capability signal --
  let isUnableToWork = false
  if (employmentSection) {
    const empa = employmentSection.answers ?? employmentSection
    if (empa && typeof empa === 'object') {
      isUnableToWork = String(empa.notes ?? '').toLowerCase().includes('not able to work') ||
        String(empa.notes ?? '').toLowerCase().includes('unable to work') ||
        String(empa.notes ?? '').toLowerCase().includes('cannot work') ||
        String(empa.current_status ?? '').toLowerCase().includes('disabled')
    }
  }

  // -- Already-enrolled government programs signal --
  const govSection = profileSections?.government_assistance ?? null
  const enrolledPrograms = []
  if (govSection) {
    const ga = govSection.answers ?? govSection
    if (ga && typeof ga === 'object') {
      if (ga.medicaid_enrolled || ga.medicaid) enrolledPrograms.push('medicaid')
      if (ga.medicare_recipient || ga.medicare) enrolledPrograms.push('medicare')
      if (ga.ssi_recipient || ga.ssi) enrolledPrograms.push('ssi')
      if (ga.ssdi_recipient || ga.ssdi) enrolledPrograms.push('ssdi')
      if (ga.snap_recipient || ga.snap) enrolledPrograms.push('snap')
      if (ga.tanf_recipient || ga.tanf) enrolledPrograms.push('tanf')
      if (ga.section8_housing || ga.section_8) enrolledPrograms.push('section8')
      // Medicaid waiver / ECF CHOICES signals
      if (ga.medicaid_waiver_program && typeof ga.medicaid_waiver_program === 'string') {
        enrolledPrograms.push('medicaid_waiver')
        if (/ecf|choices/i.test(ga.medicaid_waiver_program)) enrolledPrograms.push('ecf_choices')
      }
      if (ga.ecf_choices_role && typeof ga.ecf_choices_role === 'string' && !enrolledPrograms.includes('ecf_choices')) {
        enrolledPrograms.push('ecf_choices')
      }
    }
  }

  // -- Medicaid waiver / ECF --
  let medicaidWaiverProgram = null
  let ecfChoicesRole = null
  if (govSection) {
    const ga = govSection.answers ?? govSection
    if (ga && typeof ga === 'object') {
      medicaidWaiverProgram = ga.medicaid_waiver_program ?? null
      ecfChoicesRole = ga.ecf_choices_role ?? null
    }
  }

  // -- Citizenship signal --
  let isCitizen = false
  if (demographicsSection) {
    const da = demographicsSection.answers ?? demographicsSection
    if (da && typeof da === 'object') {
      isCitizen =
        Boolean(da.us_citizen) ||
        /^us|united\s*states|american/i.test(String(da.citizenship ?? '')) ||
        da.immigrant_status === 'us_citizen'
    }
  }

  // -- Heritage signal --
  let heritage = null
  if (demographicsSection) {
    const da = demographicsSection.answers ?? demographicsSection
    if (da && typeof da === 'object') {
      heritage = da.heritage ?? null
    }
  }

  // -- Languages signal --
  let languages = []
  if (demographicsSection) {
    const da = demographicsSection.answers ?? demographicsSection
    if (da && typeof da === 'object' && da.languages) {
      languages = typeof da.languages === 'string'
        ? da.languages.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean)
        : Array.isArray(da.languages) ? da.languages : []
    }
  }

  // -- Ethnicity signal --
  let ethnicity = profile.ethnicity ?? null
  if (!ethnicity && demographicsSection) {
    const da = demographicsSection.answers ?? demographicsSection
    if (da && typeof da === 'object') {
      ethnicity = da.ethnicity ?? null
    }
  }

  // -- Household children signal --
  const householdSection = profileSections?.household_details ?? null
  let householdHasChildren = false
  let householdSize = 0
  if (householdSection) {
    const hha = householdSection.answers ?? householdSection
    if (hha && typeof hha === 'object') {
      householdSize = Number(hha.household_size ?? 0)
    }
  }
  if (familySection) {
    const fa = familySection.answers ?? familySection
    if (fa && typeof fa === 'object') {
      householdHasChildren = Boolean(fa.has_children) || Number(fa.number_of_children ?? 0) > 0
    }
  }

  // -- Refugee/immigrant signal --
  let isRefugee = false
  const immigrationSection = profileSections?.immigration ?? null
  if (immigrationSection) {
    const ia = immigrationSection.answers ?? immigrationSection
    if (ia && typeof ia === 'object') {
      isRefugee = Boolean(ia.is_refugee) || Boolean(ia.refugee_status)
    }
  }

  const normalized = {
    id: profile.id,
    entityType,
    state,
    zip,
    county,
    city,
    needCategories,
    isVeteran,
    isStudent,
    isNonprofit,
    isBusiness,
    isCaregiver,
    hasFosterIndicator,
    hasChronicIllness,
    hasDisabilityNeed,
    hasEmergencyNeed,
    hasHousingNeed,
    hasEmploymentNeed,
    hasBusinessNeed,
    age,
    ageGroup: resolvedAgeGroup,
    isUnableToWork,
    enrolledPrograms,
    ethnicity,
    householdHasChildren,
    householdSize,
    isRefugee,
    isCitizen,
    heritage,
    languages,
    medicaidWaiverProgram,
    ecfChoicesRole,
    displayName: profile.display_name ?? profile.name ?? null,
  }

  return normalized
}

// ---------------------------------------------------------------------------
// Compute a deterministic fingerprint for a normalized profile
// Changes when entity type, location, or need categories change.
// ---------------------------------------------------------------------------
export function computeProfileFingerprint(normalizedProfile) {
  if (!normalizedProfile) return null
  const relevant = {
    entityType: normalizedProfile.entityType,
    state: normalizedProfile.state,
    zip: normalizedProfile.zip,
    needCategories: (normalizedProfile.needCategories ?? []).slice().sort(),
    isVeteran: normalizedProfile.isVeteran,
    isStudent: normalizedProfile.isStudent,
    isNonprofit: normalizedProfile.isNonprofit,
    isBusiness: normalizedProfile.isBusiness,
    isCaregiver: normalizedProfile.isCaregiver,
    hasFosterIndicator: normalizedProfile.hasFosterIndicator,
    hasChronicIllness: normalizedProfile.hasChronicIllness,
    hasDisabilityNeed: normalizedProfile.hasDisabilityNeed,
    hasEmergencyNeed: normalizedProfile.hasEmergencyNeed,
    hasHousingNeed: normalizedProfile.hasHousingNeed,
    hasEmploymentNeed: normalizedProfile.hasEmploymentNeed,
    hasBusinessNeed: normalizedProfile.hasBusinessNeed,
    isRefugee: normalizedProfile.isRefugee,
    isCitizen: normalizedProfile.isCitizen,
    householdHasChildren: normalizedProfile.householdHasChildren,
    ageGroup: normalizedProfile.ageGroup,
    enrolledPrograms: (normalizedProfile.enrolledPrograms ?? []).slice().sort(),
    medicaidWaiverProgram: normalizedProfile.medicaidWaiverProgram,
    ecfChoicesRole: normalizedProfile.ecfChoicesRole,
  }
  return createHash('sha256')
    .update(JSON.stringify(relevant))
    .digest('hex')
    .slice(0, 16)
}
