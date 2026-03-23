/**
 * Profile Normalizer
 *
 * Produces a canonical profile structure from raw profile + sections data.
 * Handles aliasing between old/new field names, entity type normalization,
 * need category normalization, and fingerprint computation.
 */

import crypto from 'crypto'

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
  mental_health: 'health_medical',
  behavioral_health: 'health_medical',
  dental: 'health_medical',
  vision: 'health_medical',

  // Food
  food: 'food',
  nutrition: 'food',
  food_insecurity: 'food',
  groceries: 'food',
  snap: 'food',

  // Education / student
  education: 'education',
  student: 'education',
  college: 'education',
  tuition: 'education',
  scholarship: 'education',
  school: 'education',
  training: 'education',
  workforce: 'education',
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
  religious_organization: 'nonprofit',

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
export function normalizeProfile(rawProfile, sections = null) {
  if (!rawProfile) return null

  const profile = rawProfile?.profile ?? rawProfile
  const profileSections = sections ?? rawProfile?.sections ?? {}

  // -- Entity type --
  const rawType =
    profile.primary_type ??
    profile.applicant_type ??
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
    }
  }

  const needCategories = [...new Set(rawNeeds.map(normalizeNeedCategory).filter(Boolean))]

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
  const isNonprofit =
    Boolean(profile.is_nonprofit) ||
    Boolean(profile.requires_501c3) ||
    entityType === 'nonprofit' ||
    String(rawType ?? '').toLowerCase().includes('nonprofit')

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

  // -- Housing instability --
  let hasHousingInstabilityFromSections = false
  const housingSection =
    profileSections?.housing ??
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

  // -- Employment need signals --
  let hasEmploymentNeed = false
  const employmentSection =
    profileSections?.employment ??
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

  const hasBusinessNeed = needCategories.includes('business') || isBusiness

  // -- Age (for scholarship/senior eligibility) --
  const age = profile.age ?? null

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
    hasChronicIllness: normalizedProfile.hasChronicIllness,
    hasEmergencyNeed: normalizedProfile.hasEmergencyNeed,
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(relevant))
    .digest('hex')
    .slice(0, 16)
}
