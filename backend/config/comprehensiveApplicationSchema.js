/**
 * Comprehensive Application Schema (canonical)
 *
 * This mirrors the data points captured in the frontend
 * `src/components/organizations/ComprehensiveApplicationForm.jsx`.
 *
 * Goals:
 * - Every profile can carry every comprehensive application data point (even if empty).
 * - Crawlers/matching can treat any data point as a potential signal (with PII-safe filtering).
 * - The API can expose "what is this field?" explanations for UI/admin diagnostics.
 */

export const COMPREHENSIVE_APPLICATION_DEFAULTS = Object.freeze({
  // Basic Info
  name: '',
  date_of_birth: '',
  email: [],
  phone: [],
  address: '',
  city: '',
  state: '',
  zip: '',
  age: null,

  // Profile Type
  applicant_type: '',

  // Organization Fields
  nonprofit_type: '',
  organization_ein: '',
  organization_uei: '',
  organization_cage_code: '',
  annual_budget: null,
  staff_count: null,
  website: '',
  ntee_code: '',
  evidence_based_program: '',
  sam_gov_registered: false,
  grants_gov_active: false,
  hipaa_compliant: false,
  ferpa_compliant: false,
  faith_based_organization: false,
  serves_rural_area: false,
  liability_insurance: false,
  liability_coverage_limit: '',
  directors_officers_insurance: false,
  workers_comp_insurance: false,
  professional_liability_insurance: false,
  business_501c3_certified: false,
  business_501c4_certified: false,
  minority_owned_certification: false,
  women_owned_certification: false,
  veteran_owned_business: false,
  promise_zone_designation: false,
  opportunity_zone_designation: false,

  // Student Fields
  student_grade_levels: [],
  current_college: '',
  target_colleges: [],
  gpa: null,
  act_score: null,
  sat_score: null,
  intended_major: '',
  first_generation: false,
  stem_student: false,
  extracurricular_activities: [],
  achievements: [],
  community_service_hours: null,

  // Financial
  household_income: null,
  household_size: null,
  financial_need_level: '',
  low_income: false,
  unemployed: false,
  displaced_worker: false,

  // Government Assistance
  medicaid_enrolled: false,
  medicaid_waiver_program: 'none',
  medicare_recipient: false,
  ssi_recipient: false,
  ssdi_recipient: false,
  snap_recipient: false,
  tanf_recipient: false,
  section8_housing: false,
  tenncare_id: '',

  // Immigration & Citizenship
  immigration_status: 'us_citizen',
  permanent_resident: false,
  refugee: false,
  new_immigrant: false,

  // Demographics
  african_american: false,
  hispanic_latino: false,
  asian_american: false,
  native_american: false,
  tribal_affiliation: '',
  lgbtq: false,

  // Health & Medical
  cancer_survivor: false,
  cancer_type: '',
  cancer_diagnosis_year: null,
  chronic_illness: false,
  chronic_illness_type: '',
  disability_type: [],
  support_needs_level: '',
  dialysis_patient: false,
  organ_transplant: false,
  hiv_aids: false,
  tbi_survivor: false,
  amputee: false,
  neurodivergent: false,
  visual_impairment: false,
  hearing_impairment: false,
  wheelchair_user: false,
  substance_recovery: false,
  mental_health_condition: false,

  // Family & Life Situation
  single_parent: false,
  foster_youth: false,
  orphan: false,
  adopted: false,
  foster_parent: false,
  caregiver: false,
  widow_widower: false,
  grandparent_raising_grandchildren: false,
  first_time_parent: false,
  homeless: false,

  // Trauma & Recovery
  domestic_violence_survivor: false,
  trafficking_survivor: false,
  disaster_survivor: false,
  formerly_incarcerated: false,

  // Military
  veteran: false,
  active_duty_military: false,
  national_guard: false,
  disabled_veteran: false,
  military_spouse: false,
  military_dependent: false,
  gold_star_family: false,

  // Occupation
  healthcare_worker: false,
  healthcare_worker_type: '',
  ems_worker: false,
  educator: false,
  firefighter: false,
  law_enforcement: false,
  public_servant: false,
  clergy: false,
  missionary: false,
  nonprofit_employee: false,
  small_business_owner: false,
  is_minority_owned_business_owner: false,
  is_women_owned_business_owner: false,
  union_member: false,
  farmer: false,
  truck_driver: false,

  // Education Level
  ged_graduate: false,
  returning_adult_student: false,
  recent_graduate: false,
  job_retraining: false,

  // Geographic
  rural_resident: false,
  appalachian_region: false,
  urban_underserved: false,

  // Other
  minor_child: false,
  young_adult: false,
  business_affected_covid: false,

  // Firearms / Second Amendment
  second_amendment_supporter: false,
  gun_owner: false,
  concealed_carry_permit: false,
  nra_member: false,
  firearm_instructor: false,
  competitive_shooter: false,
  hunting_license: false,

  // Political / Civic Engagement
  registered_voter: false,
  political_party: '',
  politically_active: false,
  community_organizer: false,
  advocacy_work: false,
  civic_volunteer: false,
  election_worker: false,

  // Profile Narrative
  mission: '',
  primary_goal: '',
  target_population: '',
  geographic_focus: '',
  funding_amount_needed: '',
  timeline: '',
  past_experience: '',
  unique_qualities: '',
  collaboration_partners: '',
  sustainability_plan: '',
  barriers_faced: '',
  special_circumstances: '',
  keywords: [],
  focus_areas: [],
})

const GROUP_RULES = [
  { group: 'basic', match: /^(name|date_of_birth|email|phone|address|city|state|zip|age|applicant_type)$/ },
  { group: 'organization', match: /^(nonprofit_type|nonprofit_type$|organization_ein|organization_uei|organization_cage_code|annual_budget|staff_count|website|ntee_code|evidence_based_program|sam_gov_registered|grants_gov_active|hipaa_compliant|ferpa_compliant|faith_based_organization|serves_rural_area|liability_insurance|liability_coverage_limit|directors_officers_insurance|workers_comp_insurance|professional_liability_insurance|business_501c3_certified|business_501c4_certified|minority_owned_certification|women_owned_certification|veteran_owned_business|promise_zone_designation|opportunity_zone_designation)$/ },
  { group: 'student', match: /^(student_|current_college|target_colleges|gpa|act_score|sat_score|intended_major|first_generation|stem_student|extracurricular_activities|achievements|community_service_hours)$/ },
  { group: 'financial', match: /^(household_|financial_need_level|low_income|unemployed|displaced_worker)$/ },
  { group: 'assistance', match: /^(medicaid_|medicare_recipient|ssi_recipient|ssdi_recipient|snap_recipient|tanf_recipient|section8_housing|tenncare_id)$/ },
  { group: 'immigration', match: /^(immigration_status|permanent_resident|refugee|new_immigrant)$/ },
  { group: 'demographics', match: /^(african_american|hispanic_latino|asian_american|native_american|tribal_affiliation|lgbtq)$/ },
  { group: 'health', match: /^(cancer_survivor|cancer_type|cancer_diagnosis_year|chronic_illness|chronic_illness_type|disability_type|support_needs_level|dialysis_patient|organ_transplant|hiv_aids|tbi_survivor|amputee|neurodivergent|visual_impairment|hearing_impairment|wheelchair_user|substance_recovery|mental_health_condition)$/ },
  { group: 'family', match: /^(single_parent|foster_youth|orphan|adopted|foster_parent|caregiver|widow_widower|grandparent_raising_grandchildren|first_time_parent|homeless)$/ },
  { group: 'trauma', match: /^(domestic_violence_survivor|trafficking_survivor|disaster_survivor|formerly_incarcerated)$/ },
  { group: 'military', match: /^(veteran|active_duty_military|national_guard|disabled_veteran|military_spouse|military_dependent|gold_star_family)$/ },
  { group: 'occupation', match: /^(healthcare_worker|healthcare_worker_type|ems_worker|educator|firefighter|law_enforcement|public_servant|clergy|missionary|nonprofit_employee|small_business_owner|is_minority_owned_business_owner|is_women_owned_business_owner|union_member|farmer|truck_driver)$/ },
  { group: 'education_level', match: /^(ged_graduate|returning_adult_student|recent_graduate|job_retraining)$/ },
  { group: 'geographic', match: /^(rural_resident|appalachian_region|urban_underserved)$/ },
  { group: 'firearms', match: /^(second_amendment_supporter|gun_owner|concealed_carry_permit|nra_member|firearm_instructor|competitive_shooter|hunting_license)$/ },
  { group: 'political', match: /^(registered_voter|political_party|politically_active|community_organizer|advocacy_work|civic_volunteer|election_worker)$/ },
  { group: 'narrative', match: /^(mission|primary_goal|target_population|geographic_focus|funding_amount_needed|timeline|past_experience|unique_qualities|collaboration_partners|sustainability_plan|barriers_faced|special_circumstances|keywords|focus_areas)$/ },
]

function titleizeKey(key) {
  return String(key)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

const KNOWN_OTHER_KEYS = new Set([
  'minor_child', 'young_adult', 'business_affected_covid',
]);

function inferGroup(key) {
  for (const rule of GROUP_RULES) {
    if (rule.match.test(key)) return rule.group
  }
  if (!KNOWN_OTHER_KEYS.has(key)) {
    // Warn at module load time so CI / startup logs surface schema drift immediately.
    console.warn(
      `[comprehensiveApplicationSchema] inferGroup: unmapped key "${key}" fell through to "other". ` +
      'Add it to GROUP_RULES or KNOWN_OTHER_KEYS to ensure correct profile-section mapping.'
    );
  }
  return 'other'
}

export function getComprehensiveApplicationSchema() {
  const defaults = COMPREHENSIVE_APPLICATION_DEFAULTS
  const fields = Object.entries(defaults).map(([key, defaultValue]) => {
    const type = Array.isArray(defaultValue) ? 'array' : defaultValue === null ? 'number|null' : typeof defaultValue
    const label = titleizeKey(key)
    // Minimal, deterministic explanations (safe default). Can be overridden later with PDF-derived wording.
    const description = `Comprehensive application field: ${label}.`
    return { key, label, type, group: inferGroup(key), description }
  })
  return { defaults, fields }
}

