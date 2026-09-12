// The applicant vocabulary of each profile bucket ('individual' | 'org' |
// 'business' | 'farm').
//
// Two readers of "who may apply" share these lists so they cannot drift:
//   - services/applicantTypeGate.js matches STATED applicant types against them;
//   - crawler-os/applicantTypeEvidence.js matches eligibility PROSE against them
//     for the four-truth `profile_qualifies` leg.
// Pure data with one dependency-free import, so Crawler OS may consume it.
import { FARM_APPLICANT_TOKENS } from '../services/eligibility/farmIdentity.js'

/**
 * Population tokens that name a PERSON. Sourced from what the live registries
 * actually emit into `entity_types_allowed` (measured on the catalog replica:
 * `["individual","family","veteran","student"]`, `["individual","family",
 * "veteran","senior"]`, `["student","family"]`, `["individual","family",
 * "veteran","active_duty","guard_reserve","transitioning_service_member",
 * "military_spouse","student"]`, `["individual","student"]`). A row typed with
 * ONLY one of the narrower tokens must pass an individual profile, not
 * hard-mismatch it.
 */
export const INDIVIDUAL_APPLICANT_TOKENS = Object.freeze([
  'individual', 'individuals', 'family', 'families', 'household', 'households',
  'student', 'students', 'consumer', 'consumers', 'patient', 'patients',
  'person', 'people', 'resident', 'residents',
  'veteran', 'veterans', 'senior', 'seniors', 'elder', 'elders',
  'caregiver', 'caregivers', 'parent', 'parents', 'youth', 'child', 'children',
  'homeowner', 'homeowners', 'renter', 'renters', 'tenant', 'tenants',
  'active_duty', 'guard_reserve', 'transitioning_service_member',
  'military_spouse', 'survivor', 'survivors', 'disabled', 'low_income',
])

export const ORG_APPLICANT_TOKENS = Object.freeze([
  'organization', 'organizations', 'nonprofit', 'nonprofits', 'non-profit',
  '501c3', '501(c)(3)', 'church', 'school', 'institution', 'institutions',
  'university', 'college', 'state', 'state_agency', 'government', 'public_agency',
])

export const BUSINESS_APPLICANT_TOKENS = Object.freeze([
  'small_business', 'business', 'businesses', 'enterprise', 'startup', 'entrepreneur', 'for_profit',
])

export const APPLICANT_BUCKET_TOKENS = Object.freeze({
  individual: INDIVIDUAL_APPLICANT_TOKENS,
  org: ORG_APPLICANT_TOKENS,
  business: BUSINESS_APPLICANT_TOKENS,
  // A farm operation IS a for-profit business — USDA/FSA/SBA treat it as
  // one, and crawler-os already widens farm → business on both sides of its
  // own gate (crawler-os/matchEngine.js APPLICANT_TYPE_TO_CANONICAL_ALLOWED
  // / OPPORTUNITY_APPLICANT_TYPE_TO_ALLOWED). So a farm applicant passes
  // BOTH the agricultural-producer vocabulary and the business vocabulary.
  farm: Object.freeze([...FARM_APPLICANT_TOKENS, ...BUSINESS_APPLICANT_TOKENS, 'rural_business']),
})

export default { APPLICANT_BUCKET_TOKENS, INDIVIDUAL_APPLICANT_TOKENS, ORG_APPLICANT_TOKENS, BUSINESS_APPLICANT_TOKENS }
