/**
 * ANYA_ONBOARDING_INTAKE_CONTRACT
 *
 * Source of truth for what Anya's first-time-user onboarding must collect.
 * The contract is intentionally a plain data structure so:
 *
 *   - The Anya conversation engine can drive question selection from it.
 *   - Sam's onboarding auditor can verify any concrete question tree
 *     satisfies the contract (and flag missing/duplicated/irrelevant
 *     questions).
 *   - Tests can assert against it directly.
 *
 * The contract describes "what minimum data we need for a useful
 * GrantFlow profile" — it does NOT prescribe exact prompts. Multiple
 * question phrasings can map to the same intake field (see
 * `anyaOnboardingFieldMap.js`).
 *
 * Mission rules embedded here:
 *
 *   - Profile fields *increase* match score; missing fields never
 *     disqualify a profile from search. The contract therefore separates
 *     `required_fields` (minimum viable profile) from `recommended_fields`
 *     (sharper matching) — never `forbidden_unless`.
 *   - Sensitive demographic / financial questions are always optional and
 *     must carry an explanation (the `sensitive: true` + `rationale_required`
 *     pair below).
 *   - Every branch supports an "I don't know" / skip path on every
 *     non-identity question.
 */

export const SUPPORTED_BRANCHES = Object.freeze([
  'individual',
  'family',
  'student',
  'church',
  'ministry',
  'nonprofit',
  'school',
  'volunteer_fire_department',
  'small_business',
  'other_organization',
])

export const BRANCH_LABELS = Object.freeze({
  individual: 'Individual',
  family: 'Family',
  student: 'Student',
  church: 'Church',
  ministry: 'Ministry',
  nonprofit: 'Nonprofit',
  school: 'School',
  volunteer_fire_department: 'Volunteer Fire Department / First Responder',
  small_business: 'Small business',
  other_organization: 'Other organization',
})

/**
 * Universal fields collected in every onboarding flow before branching.
 *
 * `required` is the minimum viable profile — onboarding cannot complete
 * without these. `recommended` improves matching but is never gated.
 */
export const UNIVERSAL_REQUIRED_FIELDS = Object.freeze([
  'profile_type',
  'profile_name',
  'location_state',
  'location_city',
  'who_needs_help',
  'what_they_need',
  'amount_or_unknown',
  'urgency',
  'preferred_help_types',
  'short_description',
  'pace_preference', // quick-start vs. keep-asking
])

export const UNIVERSAL_RECOMMENDED_FIELDS = Object.freeze([
  'location_zip',
  'deadline',
  'documents_available',
  'known_eligibility_facts',
  'prior_funding_attempts',
  'voluntary_demographics',
  'notes',
  'contact_preference',
])

/**
 * Per-branch required / recommended fields.
 *
 * Required = onboarding flow must elicit (or explicitly mark "skip")
 * before completion. Recommended = should be offered if relevant; never
 * a hard gate.
 *
 * The `sensitive_fields` set marks fields that must be (a) optional,
 * (b) accompanied by a plain-language explanation of why we're asking,
 * and (c) skippable. Sam's auditor enforces all three.
 */
export const BRANCH_CONTRACTS = Object.freeze({
  individual: {
    required_fields: ['location_state', 'primary_need', 'urgency', 'amount_or_unknown'],
    recommended_fields: [
      'employment_status',
      'disability_or_health_need',
      'veteran_status',
      'caregiver_status',
      'current_benefits',
      'household_income_range',
    ],
    sensitive_fields: [
      'household_income_range',
      'disability_or_health_need',
      'veteran_status',
    ],
  },
  family: {
    required_fields: [
      'household_location',
      'primary_family_need',
      'household_size',
      'has_dependents',
      'urgency',
    ],
    recommended_fields: [
      'need_category', // housing/utility/food/medical/education
      'household_income_range',
      'caregiver_status',
      'disability_or_health_need',
      'veteran_status',
      'student_in_household',
    ],
    sensitive_fields: ['household_income_range', 'disability_or_health_need'],
  },
  student: {
    required_fields: [
      'school_name_or_target',
      'education_level',
      'field_of_study',
      'location_state',
      'student_funding_need', // tuition/housing/books/transport/equipment/living/test_fees
      'urgency',
    ],
    recommended_fields: [
      'gpa_or_test_scores',
      'fafsa_status',
      'talents_activities',
      'voluntary_demographics',
    ],
    sensitive_fields: ['voluntary_demographics', 'gpa_or_test_scores'],
  },
  church: {
    required_fields: [
      'church_name',
      'location_state',
      'denomination', // optional content; the QUESTION is required (must be asked, may be skipped)
      'church_need_category', // building/roof/outreach/food_pantry/youth/transport/etc.
      'amount_or_unknown',
      'tax_status_known',
    ],
    recommended_fields: [
      'ein_if_known',
      'avg_attendance_or_community_served',
      'project_description',
      'community_impact',
      'documents_available',
      'deadline',
    ],
    sensitive_fields: ['denomination'],
  },
  ministry: {
    required_fields: [
      'ministry_name',
      'location_state',
      'ministry_focus',
      'need_category',
      'amount_or_unknown',
      'church_or_nonprofit_affiliation',
    ],
    recommended_fields: [
      'ein_or_501c3_status',
      'population_served',
      'project_description',
      'partner_organizations',
    ],
    sensitive_fields: [],
  },
  nonprofit: {
    required_fields: [
      'organization_name',
      'location_state',
      'mission',
      'population_served',
      'need_category',
      'amount_or_unknown',
      'tax_status_known',
    ],
    recommended_fields: [
      'ein_if_known',
      'annual_budget',
      'number_served',
      'program_description',
      'leadership_readiness',
      'documents_available',
      'deadline',
    ],
    sensitive_fields: ['annual_budget'],
  },
  school: {
    required_fields: [
      'school_name',
      'location_state',
      'school_type', // public/private/charter/homeschool/co-op
      'school_need_category', // supplies/STEM/band/athletics/field_trips/safety/tech/after_school/sped
      'amount_or_unknown',
    ],
    recommended_fields: [
      'grade_levels',
      'students_served',
      'low_income_or_rural_or_title',
      'pta_booster_foundation_involvement',
      'deadline',
    ],
    sensitive_fields: ['low_income_or_rural_or_title'],
  },
  volunteer_fire_department: {
    required_fields: [
      'department_name',
      'location_state',
      'vfd_need_category', // turnout/truck/radios/station/training/recruitment/ems/wildfire
      'amount_or_unknown',
      'service_area',
    ],
    recommended_fields: [
      'volunteer_paid_combination',
      'number_of_responders',
      'population_served',
      'call_volume',
      'fema_sam_uei_status',
      'deadline',
    ],
    sensitive_fields: [],
  },
  small_business: {
    required_fields: [
      'business_name',
      'location_state',
      'industry',
      'business_funding_need', // equipment/expansion/workforce/disaster/energy/rural/startup
      'amount_or_unknown',
    ],
    recommended_fields: [
      'employee_count',
      'annual_revenue_range',
      'minority_woman_veteran_ownership',
      'rural_or_urban',
      'naics_if_known',
      'project_description',
    ],
    sensitive_fields: [
      'annual_revenue_range',
      'minority_woman_veteran_ownership',
    ],
  },
  other_organization: {
    required_fields: [
      'organization_name',
      'location_state',
      'organization_kind',
      'need_category',
      'amount_or_unknown',
      'urgency',
    ],
    recommended_fields: [
      'mission',
      'population_served',
      'tax_or_legal_status',
      'documents_available',
    ],
    sensitive_fields: [],
  },
})

/**
 * Pace settings — the user must be able to choose between a quick start
 * (universal required only) and a fuller intake (universal + branch
 * required + recommended).
 */
export const PACE_OPTIONS = Object.freeze(['quick_start', 'keep_asking'])

/**
 * The full contract object that Sam introspects.
 */
export const ANYA_ONBOARDING_INTAKE_CONTRACT = Object.freeze({
  version: '1.0.0',
  supported_branches: SUPPORTED_BRANCHES,
  universal: {
    required_fields: UNIVERSAL_REQUIRED_FIELDS,
    recommended_fields: UNIVERSAL_RECOMMENDED_FIELDS,
  },
  branches: BRANCH_CONTRACTS,
  pace_options: PACE_OPTIONS,
  /** Every non-identity question must support these answer modes. */
  required_answer_modes: Object.freeze(['answer', 'skip', 'i_dont_know']),
})

/**
 * Helper: union of every required field for a given branch (universal +
 * branch).
 */
export function requiredFieldsForBranch(branch) {
  const branchContract = BRANCH_CONTRACTS[branch]
  if (!branchContract) return [...UNIVERSAL_REQUIRED_FIELDS]
  return [...UNIVERSAL_REQUIRED_FIELDS, ...branchContract.required_fields]
}

/**
 * Helper: union of every recommended field for a given branch (universal +
 * branch).
 */
export function recommendedFieldsForBranch(branch) {
  const branchContract = BRANCH_CONTRACTS[branch]
  if (!branchContract) return [...UNIVERSAL_RECOMMENDED_FIELDS]
  return [...UNIVERSAL_RECOMMENDED_FIELDS, ...branchContract.recommended_fields]
}

/**
 * Helper: every field considered sensitive for a given branch.
 */
export function sensitiveFieldsForBranch(branch) {
  const branchContract = BRANCH_CONTRACTS[branch]
  return branchContract?.sensitive_fields ? [...branchContract.sensitive_fields] : []
}
