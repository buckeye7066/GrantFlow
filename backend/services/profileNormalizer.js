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

  // -- Location --
  const state = profile.state ?? profile.primary_state ?? null
  const zip = profile.postal_code ?? profile.zip_code ?? profile.zip ?? null
  const county = profile.county ?? null
  const city = profile.city ?? null

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

  // -- Flags --
  const isVeteran =
    Boolean(profile.is_veteran) ||
    entityType === 'veteran' ||
    needCategories.includes('veteran') ||
    String(rawType ?? '').toLowerCase().includes('veteran')

  const isStudent =
    Boolean(profile.is_student) ||
    entityType === 'student' ||
    String(rawType ?? '').toLowerCase().includes('student')

  const isNonprofit =
    Boolean(profile.is_nonprofit) ||
    Boolean(profile.requires_501c3) ||
    entityType === 'nonprofit' ||
    String(rawType ?? '').toLowerCase().includes('nonprofit')

  const isBusiness =
    Boolean(profile.is_business) ||
    entityType === 'business' ||
    String(rawType ?? '').toLowerCase().includes('business')

  const hasDisabilityNeed = needCategories.includes('disability')
  const hasEmergencyNeed = needCategories.includes('emergency')
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
    hasDisabilityNeed,
    hasEmergencyNeed,
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
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(relevant))
    .digest('hex')
    .slice(0, 16)
}
