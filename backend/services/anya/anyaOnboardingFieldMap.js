/**
 * ANYA_ONBOARDING_FIELD_MAP
 *
 * Maps every onboarding question to:
 *   - the intake field it satisfies
 *   - the profile fields it writes to
 *   - the readiness category it advances
 *   - matching impact (high/medium/low)
 *   - Robert search impact (high/medium/low)
 *
 * The map is independent of any concrete UI implementation — both Sam
 * and Anya read it. When a question phrasing changes, only its `prompt`
 * needs to update; the `intake_field` (and therefore everything Sam audits
 * against) stays stable.
 */

import { SUPPORTED_BRANCHES } from './anyaOnboardingIntakeContract.js'

/**
 * @typedef {Object} OnboardingFieldMapEntry
 * @property {string} question_id        Stable canonical id (e.g., "universal.profile_type")
 * @property {string|null} branch        null for universal, otherwise one of SUPPORTED_BRANCHES
 * @property {string} intake_field       Intake-contract field name this question satisfies
 * @property {string} prompt             Human-readable question text (default phrasing)
 * @property {boolean} required          Whether the contract treats this as required
 * @property {boolean} sensitive         Whether the question is sensitive (must be optional with rationale)
 * @property {string} readiness_category One of identity/location/funding_needs/amount/eligibility/org_status/documents/timeline/narrative/contact
 * @property {Array<{table: string, column: string, transform?: string}>} maps_to_profile_fields
 * @property {'high'|'medium'|'low'} matching_impact
 * @property {'high'|'medium'|'low'} robert_search_impact
 */

const u = (id, fields) => ({ branch: null, ...fields, question_id: `universal.${id}` })
const b = (branch, id, fields) => ({ branch, ...fields, question_id: `${branch}.${id}` })

/** @type {OnboardingFieldMapEntry[]} */
const UNIVERSAL_QUESTIONS = [
  u('profile_type', {
    intake_field: 'profile_type',
    prompt: 'What kind of profile are we building? Individual, family, school, ministry, business, fire department, nonprofit — or something else?',
    required: true,
    sensitive: false,
    readiness_category: 'identity',
    maps_to_profile_fields: [
      { table: 'profiles', column: 'primary_type' },
      { table: 'profile_sections.basic_information', column: 'profile_category' },
    ],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  u('profile_name', {
    intake_field: 'profile_name',
    prompt: 'What should we call this profile?',
    required: true,
    sensitive: false,
    readiness_category: 'identity',
    maps_to_profile_fields: [{ table: 'profiles', column: 'display_name' }],
    matching_impact: 'low',
    robert_search_impact: 'low',
  }),
  u('location_state', {
    intake_field: 'location_state',
    prompt: 'What state are you in?',
    required: true,
    sensitive: false,
    readiness_category: 'location',
    maps_to_profile_fields: [
      { table: 'profiles', column: 'state' },
      { table: 'profile_sections.basic_information', column: 'state' },
    ],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  u('location_city', {
    intake_field: 'location_city',
    prompt: 'What city or town?',
    required: true,
    sensitive: false,
    readiness_category: 'location',
    maps_to_profile_fields: [
      { table: 'profiles', column: 'city' },
      { table: 'profile_sections.basic_information', column: 'city' },
    ],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  u('location_zip', {
    intake_field: 'location_zip',
    prompt: 'What ZIP code? (optional, helps for very local funding)',
    required: false,
    sensitive: false,
    readiness_category: 'location',
    maps_to_profile_fields: [
      { table: 'profiles', column: 'postal_code' },
      { table: 'profile_sections.basic_information', column: 'zip' },
    ],
    matching_impact: 'medium',
    robert_search_impact: 'medium',
  }),
  u('who_needs_help', {
    intake_field: 'who_needs_help',
    prompt: 'Who is this funding for — yourself, your family, an organization?',
    required: true,
    sensitive: false,
    readiness_category: 'identity',
    maps_to_profile_fields: [
      { table: 'profile_sections.narrative', column: 'target_population' },
    ],
    matching_impact: 'medium',
    robert_search_impact: 'medium',
  }),
  u('what_they_need', {
    intake_field: 'what_they_need',
    prompt: 'What is this funding for?',
    required: true,
    sensitive: false,
    readiness_category: 'funding_needs',
    maps_to_profile_fields: [
      { table: 'profile_sections.programs_services', column: 'focus_areas', transform: 'split_to_array' },
      { table: 'profile_sections.narrative', column: 'primary_goal' },
    ],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  u('amount_or_unknown', {
    intake_field: 'amount_or_unknown',
    prompt: 'About how much funding do you need? "I don\'t know" is fine.',
    required: true,
    sensitive: false,
    readiness_category: 'amount',
    maps_to_profile_fields: [
      { table: 'profiles', column: 'amount_requested' },
      { table: 'profile_sections.narrative', column: 'amount_requested' },
    ],
    matching_impact: 'medium',
    robert_search_impact: 'medium',
  }),
  u('urgency', {
    intake_field: 'urgency',
    prompt: 'How soon do you need this — within 30 days, this quarter, this year, or no rush?',
    required: true,
    sensitive: false,
    readiness_category: 'timeline',
    maps_to_profile_fields: [
      { table: 'profile_sections.narrative', column: 'urgency' },
      { table: 'profile_sections.programs_services', column: 'urgency' },
    ],
    matching_impact: 'medium',
    robert_search_impact: 'medium',
  }),
  u('preferred_help_types', {
    intake_field: 'preferred_help_types',
    prompt: 'What kinds of help interest you — grants, scholarships, benefits, foundation funding, direct aid, rebates, in-kind support, application help? (any or all)',
    required: true,
    sensitive: false,
    readiness_category: 'funding_needs',
    maps_to_profile_fields: [
      { table: 'profile_sections.programs_services', column: 'interests', transform: 'array' },
    ],
    matching_impact: 'medium',
    robert_search_impact: 'medium',
  }),
  u('short_description', {
    intake_field: 'short_description',
    prompt: 'In a few sentences, what are you trying to do and why does it matter?',
    required: true,
    sensitive: false,
    readiness_category: 'narrative',
    maps_to_profile_fields: [
      { table: 'profile_sections.narrative', column: 'mission' },
      { table: 'profile_sections.narrative', column: 'project_description' },
    ],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  u('pace_preference', {
    intake_field: 'pace_preference',
    prompt: 'Want me to keep asking helpful questions to sharpen matches, or jump to the quick start?',
    required: true,
    sensitive: false,
    readiness_category: 'identity',
    maps_to_profile_fields: [],
    matching_impact: 'low',
    robert_search_impact: 'low',
  }),
  u('deadline', {
    intake_field: 'deadline',
    prompt: 'Any specific deadline you\'re working toward? (optional)',
    required: false,
    sensitive: false,
    readiness_category: 'timeline',
    maps_to_profile_fields: [{ table: 'profile_sections.narrative', column: 'timeline' }],
    matching_impact: 'medium',
    robert_search_impact: 'low',
  }),
  u('documents_available', {
    intake_field: 'documents_available',
    prompt: 'Do you have supporting documents we should keep on file (501(c)(3) letter, tax return, mission statement, etc.)? (optional)',
    required: false,
    sensitive: false,
    readiness_category: 'documents',
    maps_to_profile_fields: [{ table: 'profile_sections.programs_services', column: 'documents_available' }],
    matching_impact: 'low',
    robert_search_impact: 'low',
  }),
  u('known_eligibility_facts', {
    intake_field: 'known_eligibility_facts',
    prompt: 'Anything funders should know that might affect eligibility? (optional)',
    required: false,
    sensitive: false,
    readiness_category: 'eligibility',
    maps_to_profile_fields: [{ table: 'profile_sections.programs_services', column: 'eligibility_notes' }],
    matching_impact: 'medium',
    robert_search_impact: 'low',
  }),
  u('contact_preference', {
    intake_field: 'contact_preference',
    prompt: 'How should funders reach you — email, phone, or mail? (optional)',
    required: false,
    sensitive: false,
    readiness_category: 'contact',
    maps_to_profile_fields: [
      { table: 'profile_sections.basic_information', column: 'email' },
      { table: 'profile_sections.basic_information', column: 'phone' },
    ],
    matching_impact: 'low',
    robert_search_impact: 'low',
  }),
]

/** @type {OnboardingFieldMapEntry[]} */
const BRANCH_QUESTIONS = [
  // ── individual ────────────────────────────────────────────────────────────
  b('individual', 'primary_need', {
    intake_field: 'primary_need',
    prompt: 'What\'s the primary need we\'re trying to fund?',
    required: true,
    sensitive: false,
    readiness_category: 'funding_needs',
    maps_to_profile_fields: [{ table: 'profile_sections.narrative', column: 'primary_goal' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  b('individual', 'employment_status', {
    intake_field: 'employment_status',
    prompt: 'Are you currently working — full-time, part-time, between jobs, retired? (optional)',
    required: false,
    sensitive: false,
    readiness_category: 'eligibility',
    maps_to_profile_fields: [{ table: 'profile_sections.employment', column: 'status' }],
    matching_impact: 'medium',
    robert_search_impact: 'medium',
  }),
  b('individual', 'household_income_range', {
    intake_field: 'household_income_range',
    prompt: 'A rough income range helps us find programs you may qualify for. This stays private and you can skip it. (optional)',
    required: false,
    sensitive: true,
    readiness_category: 'eligibility',
    maps_to_profile_fields: [{ table: 'profile_sections.employment', column: 'income_range' }],
    matching_impact: 'medium',
    robert_search_impact: 'medium',
  }),
  b('individual', 'disability_or_health_need', {
    intake_field: 'disability_or_health_need',
    prompt: 'Do you have any disability- or health-related needs that affect funding eligibility? Only share what you\'re comfortable sharing. (optional)',
    required: false,
    sensitive: true,
    readiness_category: 'eligibility',
    maps_to_profile_fields: [{ table: 'profile_sections.health_medical', column: 'health_status' }],
    matching_impact: 'medium',
    robert_search_impact: 'medium',
  }),
  b('individual', 'veteran_status', {
    intake_field: 'veteran_status',
    prompt: 'Are you a veteran or active service member? Many funding sources are veteran-specific. (optional)',
    required: false,
    sensitive: true,
    readiness_category: 'eligibility',
    maps_to_profile_fields: [{ table: 'profile_sections.family', column: 'veteran_status' }],
    matching_impact: 'medium',
    robert_search_impact: 'medium',
  }),
  b('individual', 'caregiver_status', {
    intake_field: 'caregiver_status',
    prompt: 'Are you caring for a family member with significant needs? (optional)',
    required: false,
    sensitive: false,
    readiness_category: 'eligibility',
    maps_to_profile_fields: [{ table: 'profile_sections.family', column: 'caregiver_status' }],
    matching_impact: 'medium',
    robert_search_impact: 'low',
  }),
  b('individual', 'current_benefits', {
    intake_field: 'current_benefits',
    prompt: 'Are you currently receiving any benefits we should know about? (optional)',
    required: false,
    sensitive: false,
    readiness_category: 'eligibility',
    maps_to_profile_fields: [{ table: 'profile_sections.programs_services', column: 'eligibility_notes' }],
    matching_impact: 'low',
    robert_search_impact: 'low',
  }),

  // ── family ────────────────────────────────────────────────────────────────
  b('family', 'household_location', {
    intake_field: 'household_location',
    prompt: 'Where does your household live (city, state)?',
    required: true,
    sensitive: false,
    readiness_category: 'location',
    maps_to_profile_fields: [{ table: 'profiles', column: 'state' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  b('family', 'primary_family_need', {
    intake_field: 'primary_family_need',
    prompt: 'What\'s the family\'s primary need right now?',
    required: true,
    sensitive: false,
    readiness_category: 'funding_needs',
    maps_to_profile_fields: [{ table: 'profile_sections.narrative', column: 'primary_goal' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  b('family', 'household_size', {
    intake_field: 'household_size',
    prompt: 'How many people are in the household?',
    required: true,
    sensitive: false,
    readiness_category: 'eligibility',
    maps_to_profile_fields: [{ table: 'profile_sections.family', column: 'household_size' }],
    matching_impact: 'medium',
    robert_search_impact: 'low',
  }),
  b('family', 'has_dependents', {
    intake_field: 'has_dependents',
    prompt: 'Are there children or other dependents in the household?',
    required: true,
    sensitive: false,
    readiness_category: 'eligibility',
    maps_to_profile_fields: [{ table: 'profile_sections.family', column: 'has_dependents' }],
    matching_impact: 'medium',
    robert_search_impact: 'medium',
  }),
  b('family', 'need_category', {
    intake_field: 'need_category',
    prompt: 'Is this need housing, utilities, food, medical, or education? (optional)',
    required: false,
    sensitive: false,
    readiness_category: 'funding_needs',
    maps_to_profile_fields: [{ table: 'profile_sections.programs_services', column: 'focus_areas', transform: 'array' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  b('family', 'household_income_range', {
    intake_field: 'household_income_range',
    prompt: 'A rough household income range helps unlock programs you may qualify for. This stays private. (optional)',
    required: false,
    sensitive: true,
    readiness_category: 'eligibility',
    maps_to_profile_fields: [{ table: 'profile_sections.employment', column: 'income_range' }],
    matching_impact: 'medium',
    robert_search_impact: 'medium',
  }),

  // ── student ───────────────────────────────────────────────────────────────
  b('student', 'school_name_or_target', {
    intake_field: 'school_name_or_target',
    prompt: 'What school are you attending or applying to?',
    required: true,
    sensitive: false,
    readiness_category: 'identity',
    maps_to_profile_fields: [{ table: 'profile_sections.education', column: 'school_name' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  b('student', 'education_level', {
    intake_field: 'education_level',
    prompt: 'What level — high school, community college, undergrad, graduate, trade?',
    required: true,
    sensitive: false,
    readiness_category: 'identity',
    maps_to_profile_fields: [{ table: 'profile_sections.education', column: 'education_level' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  b('student', 'field_of_study', {
    intake_field: 'field_of_study',
    prompt: 'What field or area of study?',
    required: true,
    sensitive: false,
    readiness_category: 'funding_needs',
    maps_to_profile_fields: [{ table: 'profile_sections.education', column: 'field_of_study' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  b('student', 'student_funding_need', {
    intake_field: 'student_funding_need',
    prompt: 'Is this for tuition, housing, books, transportation, equipment, living expenses, or test fees?',
    required: true,
    sensitive: false,
    readiness_category: 'funding_needs',
    maps_to_profile_fields: [{ table: 'profile_sections.programs_services', column: 'focus_areas', transform: 'array' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  b('student', 'gpa_or_test_scores', {
    intake_field: 'gpa_or_test_scores',
    prompt: 'GPA or test scores you\'re comfortable sharing? Many scholarships have minimums. (optional)',
    required: false,
    sensitive: true,
    readiness_category: 'eligibility',
    maps_to_profile_fields: [{ table: 'profile_sections.education', column: 'gpa_or_scores' }],
    matching_impact: 'medium',
    robert_search_impact: 'medium',
  }),
  b('student', 'fafsa_status', {
    intake_field: 'fafsa_status',
    prompt: 'Have you completed FAFSA / financial aid? (optional)',
    required: false,
    sensitive: false,
    readiness_category: 'eligibility',
    maps_to_profile_fields: [{ table: 'profile_sections.education', column: 'fafsa_status' }],
    matching_impact: 'medium',
    robert_search_impact: 'low',
  }),
  b('student', 'talents_activities', {
    intake_field: 'talents_activities',
    prompt: 'Any sports, music, STEM, leadership, community service, or other activities? (optional)',
    required: false,
    sensitive: false,
    readiness_category: 'eligibility',
    maps_to_profile_fields: [{ table: 'profile_sections.education', column: 'activities', transform: 'array' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),

  // ── church ────────────────────────────────────────────────────────────────
  b('church', 'church_name', {
    intake_field: 'church_name',
    prompt: 'What\'s the church\'s name?',
    required: true,
    sensitive: false,
    readiness_category: 'identity',
    maps_to_profile_fields: [
      { table: 'profiles', column: 'display_name' },
      { table: 'profile_sections.organization_details', column: 'organization_name' },
    ],
    matching_impact: 'low',
    robert_search_impact: 'low',
  }),
  b('church', 'denomination', {
    intake_field: 'denomination',
    prompt: 'Denomination or faith tradition? (optional — some funders are denomination-specific)',
    required: true, // the QUESTION is required (must be asked once); the answer is optional
    sensitive: true,
    readiness_category: 'eligibility',
    maps_to_profile_fields: [{ table: 'profile_sections.organization_details', column: 'denomination' }],
    matching_impact: 'medium',
    robert_search_impact: 'medium',
  }),
  b('church', 'church_need_category', {
    intake_field: 'church_need_category',
    prompt: 'Is this for building repair, roof, outreach, food pantry, youth ministry, transportation, accessibility, disaster recovery, utilities, or a community program?',
    required: true,
    sensitive: false,
    readiness_category: 'funding_needs',
    maps_to_profile_fields: [{ table: 'profile_sections.programs_services', column: 'focus_areas', transform: 'array' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  b('church', 'tax_status_known', {
    intake_field: 'tax_status_known',
    prompt: 'Is the church recognized as 501(c)(3), under a group exemption, or do you not know?',
    required: true,
    sensitive: false,
    readiness_category: 'org_status',
    maps_to_profile_fields: [{ table: 'profile_sections.nonprofit_compliance', column: 'tax_exempt_status' }],
    matching_impact: 'high',
    robert_search_impact: 'medium',
  }),
  b('church', 'ein_if_known', {
    intake_field: 'ein_if_known',
    prompt: 'EIN if you have it handy? (optional)',
    required: false,
    sensitive: false,
    readiness_category: 'org_status',
    maps_to_profile_fields: [{ table: 'profile_sections.organization_details', column: 'ein' }],
    matching_impact: 'low',
    robert_search_impact: 'low',
  }),

  // ── ministry ──────────────────────────────────────────────────────────────
  b('ministry', 'ministry_name', {
    intake_field: 'ministry_name',
    prompt: 'What\'s the ministry\'s name?',
    required: true,
    sensitive: false,
    readiness_category: 'identity',
    maps_to_profile_fields: [{ table: 'profiles', column: 'display_name' }],
    matching_impact: 'low',
    robert_search_impact: 'low',
  }),
  b('ministry', 'ministry_focus', {
    intake_field: 'ministry_focus',
    prompt: 'What\'s the ministry\'s primary focus?',
    required: true,
    sensitive: false,
    readiness_category: 'funding_needs',
    maps_to_profile_fields: [{ table: 'profile_sections.narrative', column: 'mission' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  b('ministry', 'need_category', {
    intake_field: 'need_category',
    prompt: 'What kind of need is this funding for?',
    required: true,
    sensitive: false,
    readiness_category: 'funding_needs',
    maps_to_profile_fields: [{ table: 'profile_sections.programs_services', column: 'focus_areas', transform: 'array' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  b('ministry', 'church_or_nonprofit_affiliation', {
    intake_field: 'church_or_nonprofit_affiliation',
    prompt: 'Is the ministry affiliated with a specific church or nonprofit?',
    required: true,
    sensitive: false,
    readiness_category: 'org_status',
    maps_to_profile_fields: [{ table: 'profile_sections.organization_details', column: 'parent_organization' }],
    matching_impact: 'medium',
    robert_search_impact: 'medium',
  }),

  // ── nonprofit ─────────────────────────────────────────────────────────────
  b('nonprofit', 'organization_name', {
    intake_field: 'organization_name',
    prompt: 'What\'s the organization\'s name?',
    required: true,
    sensitive: false,
    readiness_category: 'identity',
    maps_to_profile_fields: [{ table: 'profiles', column: 'display_name' }],
    matching_impact: 'low',
    robert_search_impact: 'low',
  }),
  b('nonprofit', 'mission', {
    intake_field: 'mission',
    prompt: 'In one or two sentences, what is the mission?',
    required: true,
    sensitive: false,
    readiness_category: 'narrative',
    maps_to_profile_fields: [{ table: 'profile_sections.narrative', column: 'mission' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  b('nonprofit', 'population_served', {
    intake_field: 'population_served',
    prompt: 'Who do you serve?',
    required: true,
    sensitive: false,
    readiness_category: 'eligibility',
    maps_to_profile_fields: [{ table: 'profile_sections.narrative', column: 'target_population' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  b('nonprofit', 'need_category', {
    intake_field: 'need_category',
    prompt: 'What kind of need is this funding for?',
    required: true,
    sensitive: false,
    readiness_category: 'funding_needs',
    maps_to_profile_fields: [{ table: 'profile_sections.programs_services', column: 'focus_areas', transform: 'array' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  b('nonprofit', 'tax_status_known', {
    intake_field: 'tax_status_known',
    prompt: 'Is the organization 501(c)(3) — yes, applying, fiscally sponsored, or unknown?',
    required: true,
    sensitive: false,
    readiness_category: 'org_status',
    maps_to_profile_fields: [{ table: 'profile_sections.nonprofit_compliance', column: 'tax_exempt_status' }],
    matching_impact: 'high',
    robert_search_impact: 'medium',
  }),

  // ── school ────────────────────────────────────────────────────────────────
  b('school', 'school_name', {
    intake_field: 'school_name',
    prompt: 'What\'s the school\'s name?',
    required: true,
    sensitive: false,
    readiness_category: 'identity',
    maps_to_profile_fields: [{ table: 'profiles', column: 'display_name' }],
    matching_impact: 'low',
    robert_search_impact: 'low',
  }),
  b('school', 'school_type', {
    intake_field: 'school_type',
    prompt: 'Is this a public, private, charter, homeschool, or co-op setting?',
    required: true,
    sensitive: false,
    readiness_category: 'org_status',
    maps_to_profile_fields: [{ table: 'profile_sections.organization_details', column: 'school_type' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  b('school', 'school_need_category', {
    intake_field: 'school_need_category',
    prompt: 'Is this for classroom supplies, STEM, band/orchestra, athletics, field trips, safety, technology, after-school, or special education?',
    required: true,
    sensitive: false,
    readiness_category: 'funding_needs',
    maps_to_profile_fields: [{ table: 'profile_sections.programs_services', column: 'focus_areas', transform: 'array' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),

  // ── volunteer fire department ─────────────────────────────────────────────
  b('volunteer_fire_department', 'department_name', {
    intake_field: 'department_name',
    prompt: 'What\'s the department\'s official name?',
    required: true,
    sensitive: false,
    readiness_category: 'identity',
    maps_to_profile_fields: [{ table: 'profiles', column: 'display_name' }],
    matching_impact: 'low',
    robert_search_impact: 'low',
  }),
  b('volunteer_fire_department', 'vfd_need_category', {
    intake_field: 'vfd_need_category',
    prompt: 'Is this for turnout gear, a truck, radios, station repair, training, recruitment, EMS equipment, or wildfire/brush equipment?',
    required: true,
    sensitive: false,
    readiness_category: 'funding_needs',
    maps_to_profile_fields: [{ table: 'profile_sections.programs_services', column: 'focus_areas', transform: 'array' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  b('volunteer_fire_department', 'service_area', {
    intake_field: 'service_area',
    prompt: 'What\'s your service area (city/county)?',
    required: true,
    sensitive: false,
    readiness_category: 'location',
    maps_to_profile_fields: [{ table: 'profile_sections.location_focus', column: 'service_area' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),

  // ── small business ────────────────────────────────────────────────────────
  b('small_business', 'business_name', {
    intake_field: 'business_name',
    prompt: 'What\'s the business name?',
    required: true,
    sensitive: false,
    readiness_category: 'identity',
    maps_to_profile_fields: [{ table: 'profiles', column: 'display_name' }],
    matching_impact: 'low',
    robert_search_impact: 'low',
  }),
  b('small_business', 'industry', {
    intake_field: 'industry',
    prompt: 'What industry?',
    required: true,
    sensitive: false,
    readiness_category: 'identity',
    maps_to_profile_fields: [{ table: 'profile_sections.small_business_details', column: 'industry' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  b('small_business', 'business_funding_need', {
    intake_field: 'business_funding_need',
    prompt: 'Is this for equipment, expansion, workforce, disaster recovery, energy efficiency, rural development, or startup?',
    required: true,
    sensitive: false,
    readiness_category: 'funding_needs',
    maps_to_profile_fields: [{ table: 'profile_sections.programs_services', column: 'focus_areas', transform: 'array' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  b('small_business', 'annual_revenue_range', {
    intake_field: 'annual_revenue_range',
    prompt: 'A rough revenue range helps us find size-appropriate programs. Stays private; you can skip. (optional)',
    required: false,
    sensitive: true,
    readiness_category: 'eligibility',
    maps_to_profile_fields: [{ table: 'profile_sections.small_business_details', column: 'annual_revenue_range' }],
    matching_impact: 'medium',
    robert_search_impact: 'medium',
  }),
  b('small_business', 'minority_woman_veteran_ownership', {
    intake_field: 'minority_woman_veteran_ownership',
    prompt: 'Does your business qualify for any minority-, women-, or veteran-owned programs? Only share what you\'re comfortable sharing. (optional)',
    required: false,
    sensitive: true,
    readiness_category: 'eligibility',
    maps_to_profile_fields: [{ table: 'profile_sections.small_business_details', column: 'ownership_classifications' }],
    matching_impact: 'medium',
    robert_search_impact: 'medium',
  }),

  // ── other organization ────────────────────────────────────────────────────
  b('other_organization', 'organization_name', {
    intake_field: 'organization_name',
    prompt: 'What\'s the organization\'s name?',
    required: true,
    sensitive: false,
    readiness_category: 'identity',
    maps_to_profile_fields: [{ table: 'profiles', column: 'display_name' }],
    matching_impact: 'low',
    robert_search_impact: 'low',
  }),
  b('other_organization', 'organization_kind', {
    intake_field: 'organization_kind',
    prompt: 'In a few words, what kind of organization is this?',
    required: true,
    sensitive: false,
    readiness_category: 'identity',
    maps_to_profile_fields: [{ table: 'profile_sections.organization_details', column: 'organization_type' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
  b('other_organization', 'need_category', {
    intake_field: 'need_category',
    prompt: 'What kind of need is this funding for?',
    required: true,
    sensitive: false,
    readiness_category: 'funding_needs',
    maps_to_profile_fields: [{ table: 'profile_sections.programs_services', column: 'focus_areas', transform: 'array' }],
    matching_impact: 'high',
    robert_search_impact: 'high',
  }),
]

export const ANYA_ONBOARDING_FIELD_MAP = Object.freeze([...UNIVERSAL_QUESTIONS, ...BRANCH_QUESTIONS])

/**
 * Convenience: every entry indexed by question_id.
 */
export const FIELD_MAP_BY_ID = Object.freeze(
  ANYA_ONBOARDING_FIELD_MAP.reduce((acc, q) => {
    acc[q.question_id] = q
    return acc
  }, {}),
)

/**
 * Returns every question for a branch (universal + branch-specific).
 */
export function questionsForBranch(branch) {
  if (!SUPPORTED_BRANCHES.includes(branch)) return UNIVERSAL_QUESTIONS.slice()
  return ANYA_ONBOARDING_FIELD_MAP.filter((q) => q.branch === null || q.branch === branch)
}

/**
 * Returns every intake_field a branch's questions cover.
 */
export function intakeFieldsCoveredByBranch(branch) {
  return new Set(questionsForBranch(branch).map((q) => q.intake_field))
}
