/**
 * Profile-type groups used to decide which profile sections apply.
 * Kept in shared/ so frontend completion UI and tests stay aligned with
 * the curated profile-type list in profileTypeOptions.js.
 */
import { canonicalizeProfileTypeId } from './profileTypeOptions.js'

export const LEGACY_ORG_TYPES = Object.freeze(['organization', 'government', 'small_business'])

export const MISSION_ORG_TYPES = Object.freeze([
  'nonprofit',
  'church',
  'ministry',
  'food_pantry',
  'homeless_shelter',
  'animal_rescue',
])

export const PUBLIC_ORG_TYPES = Object.freeze([
  'volunteer_fire_department',
  'county_government',
  'municipality',
  'public_agency',
  'tribal_government',
  'public_health_department',
])

export const EDUCATION_ORG_TYPES = Object.freeze([
  'school_district',
  'public_school',
  'library',
  'teacher',
  'classroom_teacher',
])

export const BUSINESS_TYPES = Object.freeze([
  'business',
  'medium_corporation',
  'large_corporation',
  'minority_owned_business',
  'women_owned_business',
  'small_business',
])

export const STUDENT_TYPES = Object.freeze([
  'student',
  'high_school_student',
  'college_student',
  'graduate_student',
])

export const MEDICAL_PROFILE_TYPES = Object.freeze([
  'medical_need',
  'medical_assistance',
  'individual_need',
  'family',
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

export function isProfileTypeInList(rawType, allowedTypes) {
  if (!Array.isArray(allowedTypes) || allowedTypes.length === 0) return true
  const canonical = canonicalizeProfileTypeId(rawType) || String(rawType || '').trim()
  if (!canonical) return false
  return allowedTypes.includes(canonical)
}

export function sectionAppliesToProfileType(sectionConfig, profile) {
  const appliesTo = sectionConfig?.applies_to ?? sectionConfig?.appliesTo ?? null
  if (!Array.isArray(appliesTo) || appliesTo.length === 0) return true
  const primaryType = profile?.primary_type ?? profile?.primaryType ?? profile?.applicant_type ?? ''
  return isProfileTypeInList(primaryType, appliesTo)
}
