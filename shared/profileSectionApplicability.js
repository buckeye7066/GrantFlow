/**
 * Single source of truth for PROFILE-TYPE CLASSIFICATION.
 *
 * Every surface that needs to know "is this an organization, a person, or a
 * student?" — the profile editor (which sections/fields to show), the
 * completion meter, the "improve your matches" prompts, and Anya's context —
 * must derive that answer here, so a new profile type is recognised everywhere
 * the moment it is added to profileTypeOptions.js.
 *
 * Kept in shared/ (pure JS, no node deps) so the frontend and backend both
 * import it. The curated, user-facing type list lives in profileTypeOptions.js;
 * the rich backend registry (strategies, sources) lives in
 * backend/services/profileTypeRegistry.js. The groups below MUST stay in sync
 * with the curated list — tests/unit/profile-section-applicability.test.mjs (and
 * the frontend applicability test) assert every curated id is classified.
 */
import { canonicalizeProfileTypeId } from './profileTypeOptions.js'

// ── People & households (non-student persons) ───────────────────────────────
export const PEOPLE_TYPES = Object.freeze([
  'individual',
  'family',
  'medical_need',
  'medical_assistance', // legacy alias of medical_need, kept for stored data
  'individual_need', // legacy alias of individual
  'medical', // legacy alias
  'homeschool_family',
  'senior',
  'veteran',
  'disabled_adult',
])

export const STUDENT_TYPES = Object.freeze([
  'student',
  'high_school_student',
  'college_student',
  'graduate_student',
])

/**
 * Person-scoped profiles that may carry medical / patient-assistance fields.
 * (Superset kept stable for existing sectionMetadata imports.)
 */
export const MEDICAL_PROFILE_TYPES = Object.freeze([
  'medical_need',
  'medical_assistance',
  'individual_need',
  'medical',
  'disabled_adult',
  'senior',
  'veteran',
  'family',
])

// ── Organizations ───────────────────────────────────────────────────────────
export const LEGACY_ORG_TYPES = Object.freeze(['organization', 'government', 'small_business'])

export const MISSION_ORG_TYPES = Object.freeze([
  'nonprofit',
  'church',
  'ministry',
  'food_pantry',
  'homeless_shelter',
  'animal_rescue',
  'mental_health_nonprofit',
  'substance_recovery_org',
  'reentry_program',
  'community_center',
  'museum',
])

export const PUBLIC_ORG_TYPES = Object.freeze([
  'volunteer_fire_department',
  'county_government',
  'municipality',
  'public_agency',
  'local_housing_authority',
  'parks_department',
  'regional_planning_agency',
  'economic_development_agency',
  'tribal_government',
  'public_health_department',
])

export const EDUCATION_ORG_TYPES = Object.freeze([
  'teacher',
  'classroom_teacher',
  'school_district',
  'public_school',
  'special_education_program',
  'school_food_service',
  'school_transportation',
  'pta_pto',
  'library',
])

export const BUSINESS_TYPES = Object.freeze([
  'business',
  'medium_corporation',
  'large_corporation',
  'minority_owned_business',
  'women_owned_business',
  'small_business',
])

/** Entity-style profiles that should capture org registration, EIN, budget, etc. */
export const ORGANIZATION_DETAILS_TYPES = Object.freeze([
  ...MISSION_ORG_TYPES,
  ...PUBLIC_ORG_TYPES,
  ...EDUCATION_ORG_TYPES,
  ...BUSINESS_TYPES,
  ...LEGACY_ORG_TYPES,
])

/** Mission-driven orgs that may need 501(c)(3) / SAM readiness fields */
export const NONPROFIT_COMPLIANCE_TYPES = Object.freeze([
  ...MISSION_ORG_TYPES,
  'organization',
])

/** For-profit profiles that should capture NAICS, revenue, certifications */
export const SMALL_BUSINESS_DETAILS_TYPES = Object.freeze([...BUSINESS_TYPES])

// ── Rolled-up groups used for section/field applicability ───────────────────
/** Every person profile (people + students) — the "applies to a human applicant" set. */
export const ALL_PERSON_TYPES = Object.freeze([...new Set([...PEOPLE_TYPES, ...STUDENT_TYPES])])

/** Every organization-style profile — the "applies to an entity applicant" set. */
export const ALL_ORG_TYPES = Object.freeze([...new Set(ORGANIZATION_DETAILS_TYPES)])

const ORG_SET = new Set(ALL_ORG_TYPES)
const PERSON_SET = new Set(ALL_PERSON_TYPES)
const STUDENT_SET = new Set(STUDENT_TYPES)

function canonical(raw) {
  return canonicalizeProfileTypeId(raw) || String(raw || '').trim().toLowerCase()
}

export function isProfileTypeInList(rawType, allowedTypes) {
  if (!Array.isArray(allowedTypes) || allowedTypes.length === 0) return true
  const c = canonical(rawType)
  if (!c) return false
  return allowedTypes.includes(c)
}

/** True for organization-style profiles (nonprofit, government, business, school, …). */
export function isOrganizationProfileType(rawType) {
  return ORG_SET.has(canonical(rawType))
}

/** True for human-applicant profiles (people + students). */
export function isPersonProfileType(rawType) {
  return PERSON_SET.has(canonical(rawType))
}

/** True for student profiles (any level). */
export function isStudentProfileType(rawType) {
  return STUDENT_SET.has(canonical(rawType))
}

function primaryTypeOf(profile) {
  return profile?.primary_type ?? profile?.primaryType ?? profile?.applicant_type ?? ''
}

/**
 * Does a config (section OR field) with an optional `applies_to`/`appliesTo`
 * array apply to this profile? Absent/empty list = universal. Unknown or
 * "other" profile types fall through to universal so we never over-hide a
 * section the user might still need.
 */
function configAppliesToProfileType(config, profile) {
  const appliesTo = config?.applies_to ?? config?.appliesTo ?? null
  if (!Array.isArray(appliesTo) || appliesTo.length === 0) return true
  const c = canonical(primaryTypeOf(profile))
  // Explicit catch-all "other" sees every section — we don't know what they
  // need, so never hide. A missing/blank type (mid-onboarding, before a type is
  // chosen) shows only the universal sections, matching long-standing behavior.
  if (c === 'other') return true
  if (!c) return false
  return appliesTo.includes(c)
}

export function sectionAppliesToProfileType(sectionConfig, profile) {
  return configAppliesToProfileType(sectionConfig, profile)
}

export function fieldAppliesToProfileType(fieldConfig, profile) {
  return configAppliesToProfileType(fieldConfig, profile)
}
