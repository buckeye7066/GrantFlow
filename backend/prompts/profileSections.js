import { COMPREHENSIVE_APPLICATION_DEFAULTS } from '../config/comprehensiveApplicationSchema.js'

// AI-enabled section prompts (used by document ingestion + "AI fill" endpoints).
const SECTION_PROMPTS = {
  basic_information: {
    title: 'Basic Information',
    instructions: `
Using the data below, fill out the primary contact fields for this profile. 
Return a JSON object containing the keys: name, date_of_birth, age, email, phone, website, address, city, state, zip, notes.

Rules:
- Pull from existing section data when available.
- Prefer information extracted from uploaded documents when it appears reliable (e.g. applications, IDs).
- Never fabricate personal data; if a field is unknown return an empty string.
- Preserve readable formatting for addresses and notes.
    `.trim(),
    keys: ['name', 'date_of_birth', 'age', 'email', 'phone', 'website', 'address', 'city', 'state', 'zip', 'notes'],
  },
  organization_details: {
    title: 'Organization Details',
    instructions: `
Using the context below, complete the organization details for this profile.
Return a JSON object with: applicant_type, nonprofit_type, organization_ein, organization_uei, organization_cage_code, annual_budget, staff_count, ntee_code, evidence_based_program, sam_gov_registered, grants_gov_active, hipaa_compliant, ferpa_compliant, faith_based_organization, serves_rural_area, liability_insurance, liability_coverage_limit, directors_officers_insurance, workers_comp_insurance, professional_liability_insurance, business_501c3_certified, business_501c4_certified, minority_owned_certification, women_owned_certification, veteran_owned_business, promise_zone_designation, opportunity_zone_designation, business_affected_covid, mission.

Rules:
- Pull official identifiers (EIN, UEI, CAGE) from documents or existing data if present. Do NOT invent them.
- annual_budget and staff_count must be numeric. Use null when unknown.
- Summarise the mission in two concise sentences when possible.
- Never invent identifiers or financial values; leave them blank / null if unavailable.
    `.trim(),
    keys: [
      'applicant_type',
      'nonprofit_type',
      'organization_ein',
      'organization_uei',
      'organization_cage_code',
      'annual_budget',
      'staff_count',
      'ntee_code',
      'evidence_based_program',
      'sam_gov_registered',
      'grants_gov_active',
      'hipaa_compliant',
      'ferpa_compliant',
      'faith_based_organization',
      'serves_rural_area',
      'liability_insurance',
      'liability_coverage_limit',
      'directors_officers_insurance',
      'workers_comp_insurance',
      'professional_liability_insurance',
      'business_501c3_certified',
      'business_501c4_certified',
      'minority_owned_certification',
      'women_owned_certification',
      'veteran_owned_business',
      'promise_zone_designation',
      'opportunity_zone_designation',
      'business_affected_covid',
      'mission',
    ],
  },
  financial_information: {
    title: 'Financial Information',
    instructions: `
Analyse the data and summarise the applicant's financial situation.
Return JSON with: household_income, household_size, financial_need_level, low_income, unemployed, displaced_worker, notes.

Rules:
- household_income should be a number (USD) when known, otherwise null.
- household_size must be an integer when known.
- financial_need_level should be a short descriptor (e.g. "high", "moderate", "unknown").
- low_income, unemployed, displaced_worker must be booleans.
- Use notes for concise explanations (max 2 sentences).
    `.trim(),
    keys: ['household_income', 'household_size', 'financial_need_level', 'low_income', 'unemployed', 'displaced_worker', 'notes'],
  },
  government_assistance: {
    title: 'Government Assistance',
    instructions: `
Determine which public benefits the applicant receives.
Return JSON with boolean flags for: medicaid_enrolled, medicare_recipient, ssi_recipient, ssdi_recipient, snap_recipient, tanf_recipient, section8_housing, plus: medicaid_waiver_program (string), tenncare_id (string), other_programs (string).

Rules:
- Use the source documents to confirm enrollment when possible.
- When unsure, leave flags false and mention ambiguous evidence in other_programs.
- other_programs should be a short comma-separated list or an empty string.
    `.trim(),
    keys: [
      'medicaid_enrolled',
      'medicaid_waiver_program',
      'medicare_recipient',
      'ssi_recipient',
      'ssdi_recipient',
      'snap_recipient',
      'tanf_recipient',
      'section8_housing',
      'tenncare_id',
      'other_programs',
    ],
  },
  health_medical: {
    title: 'Health & Medical',
    instructions: `
Review the profile and documents to capture relevant health information.
Return JSON with keys: cancer_survivor, cancer_type, cancer_diagnosis_year, chronic_illness, chronic_illness_type, disability_type, support_needs_level, dialysis_patient, organ_transplant, hiv_aids, tbi_survivor, amputee, neurodivergent, visual_impairment, hearing_impairment, wheelchair_user, substance_recovery, mental_health_condition, notes.

Rules:
- Flags must be booleans. If condition is not confirmed, leave false.
- disability_type should be an array of distinct values (strings).
- support_needs_level should be short (e.g. "high", "moderate", "low", "unknown").
- notes should summarise important medical context in <= 3 sentences.
    `.trim(),
    keys: [
      'cancer_survivor',
      'cancer_type',
      'cancer_diagnosis_year',
      'chronic_illness',
      'chronic_illness_type',
      'disability_type',
      'support_needs_level',
      'dialysis_patient',
      'organ_transplant',
      'hiv_aids',
      'tbi_survivor',
      'amputee',
      'neurodivergent',
      'visual_impairment',
      'hearing_impairment',
      'wheelchair_user',
      'substance_recovery',
      'mental_health_condition',
      'notes',
    ],
  },
  demographics: {
    title: 'Demographics',
    instructions: `
Summarise demographic details relevant for grant eligibility.
Return JSON with keys: immigration_status, permanent_resident, refugee, new_immigrant, african_american, hispanic_latino, asian_american, native_american, tribal_affiliation, lgbtq, immigrant_status, notes.

Rules:
- Booleans must reflect confirmed identities; do not infer from names alone.
- immigrant_status should be one of: "us_citizen", "permanent_resident", "refugee", "undocumented", "other", or "unknown".
- Use notes for additional context when relevant (<= 2 sentences).
    `.trim(),
    keys: [
      'immigration_status',
      'permanent_resident',
      'refugee',
      'new_immigrant',
      'african_american',
      'hispanic_latino',
      'asian_american',
      'native_american',
      'tribal_affiliation',
      'lgbtq',
      'immigrant_status',
      'notes',
    ],
  },
  family_life: {
    title: 'Family & Life Situation',
    instructions: `
Highlight family circumstances and life events that can unlock program eligibility.
Return JSON with the following boolean keys plus a notes field: single_parent, foster_youth, orphan, adopted, foster_parent, caregiver, widow_widower, grandparent_raising_grandchildren, first_time_parent, homeless, domestic_violence_survivor, trafficking_survivor, disaster_survivor, formerly_incarcerated, notes.

Rules:
- Only mark flags true when information is explicit.
- notes should call out time-sensitive situations (<= 2 sentences).
    `.trim(),
    keys: [
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
      'notes',
    ],
  },
  military_service: {
    title: 'Military Status',
    instructions: `
Determine the applicant's military affiliation.
Return JSON with: veteran, active_duty_military, national_guard, disabled_veteran, military_spouse, military_dependent, gold_star_family, notes.

Rules:
- Use documents (DD-214, service letters) when available.
- notes should mention branch, service years, or disability rating when relevant.
    `.trim(),
    keys: [
      'veteran',
      'active_duty_military',
      'national_guard',
      'disabled_veteran',
      'military_spouse',
      'military_dependent',
      'gold_star_family',
      'notes',
    ],
  },
  occupation: {
    title: 'Occupation',
    instructions: `
Capture occupational indicators that influence program fit.
Return JSON with booleans for the following keys and a notes field: healthcare_worker, healthcare_worker_type, ems_worker, educator, firefighter, law_enforcement, public_servant, clergy, missionary, nonprofit_employee, small_business_owner, is_minority_owned_business_owner, is_women_owned_business_owner, minority_owned_business, women_owned_business, union_member, farmer, truck_driver, notes.

Rules:
- For healthcare_worker_type supply a short description (e.g. "RN", "CNA") or empty string.
- notes may list additional roles or certifications.
    `.trim(),
    keys: [
      'healthcare_worker',
      'healthcare_worker_type',
      'ems_worker',
      'educator',
      'firefighter',
      'law_enforcement',
      'public_servant',
      'clergy',
      'missionary',
      'nonprofit_employee',
      'small_business_owner',
      'is_minority_owned_business_owner',
      'is_women_owned_business_owner',
      'minority_owned_business',
      'women_owned_business',
      'union_member',
      'farmer',
      'truck_driver',
      'notes',
    ],
  },
  location_focus: {
    title: 'Location Focus',
    instructions: `
Record geographic context that impacts eligibility.
Return JSON with: rural_resident, appalachian_region, urban_underserved, geographic_focus, notes.

Rules:
- geographic_focus should describe primary service area or hometown if known.
- notes may include county, census tract, or other location qualifiers.
    `.trim(),
    keys: ['rural_resident', 'appalachian_region', 'urban_underserved', 'geographic_focus', 'notes'],
  },
  university_applications: {
    title: 'University Applications',
    instructions: `
Compile a detailed list of every college/university the student is tracking.
Return JSON with a single key "applications" containing an array of application objects.

Each application object must include:
- name (string)
- status (one of: planning, interested, in_progress, submitted, accepted, deferred, waitlisted, denied)
- application_type (e.g. regular_decision, early_action, rolling, transfer)
- institution_type (e.g. public, private, community_college, technical)
- acceptance_rate (number 0-100 when known, otherwise null)
- avg_gpa (number when known, otherwise null)
- sat_range (string, e.g. "950-1170" or empty string)
- tuition (number USD, top-of-range if a range is provided, otherwise null)
- fafsa_code (string)
- application_fee (number USD, 0 if none)
- test_optional (boolean)
- essay_required (boolean)
- rec_letters_required (integer count, default 0)
- application_deadline (ISO date string or null)
- financial_aid_deadline (ISO date string or null)
- decision_release_date (ISO date string or null)
- interests (array of strings describing programs/teams the student cares about)
- actions (object with apply_url, pay_fee_url, visit_url strings or null)
- contacts (object with admissions, financial_aid, general keys; each value is an object { name, title, email, phone, url } with empty strings when unknown)
- department_contacts (array of objects with { area, name, title, email, phone, notes } for targeted majors or extracurricular departments)
- financial_aid_pipeline (array of objects { id, label, status, due_date, completed_at, notes }; status must be one of planned, in_progress, completed, blocked)
- notes (string with summary context)

Rules:
- Use evidence from uploaded letters, transcripts, or prior sections before guessing.
- Leave fields empty or null when data cannot be confirmed—do NOT fabricate.
- Convert acceptance rates to percentages (0-100). Tuition and fees in USD numbers.
- Include at least one general contact (admissions or switchboard) and financial aid contact when available.
- Align interests and department_contacts with documented activities (e.g. band, volleyball, nursing).
    `.trim(),
    keys: ['applications'],
  },
  narrative: {
    title: 'Story & Goals',
    instructions: `
Craft a concise narrative of the applicant's goals, challenges, and impact.
Return JSON with: mission, primary_goal, target_population, geographic_focus, funding_amount_needed, timeline, past_experience, unique_qualities, collaboration_partners, sustainability_plan, barriers_faced, special_circumstances, keywords, focus_areas.

Rules:
- Use clear, persuasive sentences. Each field should be 1-3 sentences.
- funding_amount_needed should be a numeric estimate if available, otherwise descriptive text.
- If information is unavailable, return an empty string.
    `.trim(),
    keys: [
      'mission',
      'primary_goal',
      'target_population',
      'geographic_focus',
      'funding_amount_needed',
      'timeline',
      'past_experience',
      'unique_qualities',
      'collaboration_partners',
      'sustainability_plan',
      'barriers_faced',
      'special_circumstances',
      'keywords',
      'focus_areas',
    ],
  },

  student_details: {
    title: 'Student & Education Details',
    instructions: `
Capture student status and academic signals needed for scholarship matching.
Return JSON with: student_grade_levels, current_college, target_colleges, gpa, act_score, sat_score, intended_major, first_generation, stem_student, extracurricular_activities, achievements, community_service_hours, ged_graduate, returning_adult_student, recent_graduate, job_retraining, minor_child, young_adult.

Rules:
- Use arrays for list fields (student_grade_levels, target_colleges, extracurricular_activities, achievements).
- Numeric fields should be numbers or null when unknown.
- Do NOT fabricate test scores or GPA.
    `.trim(),
    keys: [
      'student_grade_levels',
      'current_college',
      'target_colleges',
      'gpa',
      'act_score',
      'sat_score',
      'intended_major',
      'first_generation',
      'stem_student',
      'extracurricular_activities',
      'achievements',
      'community_service_hours',
      'ged_graduate',
      'returning_adult_student',
      'recent_graduate',
      'job_retraining',
      'minor_child',
      'young_adult',
    ],
  },

  firearms: {
    title: 'Firearms / Second Amendment',
    instructions: `
Capture optional firearms-related qualifiers (only if explicitly provided).
Return JSON with booleans: second_amendment_supporter, gun_owner, concealed_carry_permit, nra_member, firearm_instructor, competitive_shooter, hunting_license.
    `.trim(),
    keys: [
      'second_amendment_supporter',
      'gun_owner',
      'concealed_carry_permit',
      'nra_member',
      'firearm_instructor',
      'competitive_shooter',
      'hunting_license',
    ],
  },

  political_civic: {
    title: 'Political / Civic Engagement',
    instructions: `
Capture optional civic engagement qualifiers (only if explicitly provided).
Return JSON with: registered_voter, political_party, politically_active, community_organizer, advocacy_work, civic_volunteer, election_worker.
    `.trim(),
    keys: [
      'registered_voter',
      'political_party',
      'politically_active',
      'community_organizer',
      'advocacy_work',
      'civic_volunteer',
      'election_worker',
    ],
  },
}

/**
 * Canonical profile section defaults
 *
 * This is the *schema contract* for what data points exist on a profile.
 * Repair/seed operations should ensure every profile has every canonical section
 * with the keys present (even if values are empty).
 *
 * NOTE: These defaults are not limited to AI prompt keys. We include extra
 * location fields so crawlers/matching can rely on them being present.
 */
export const CANONICAL_SECTION_DEFAULTS = Object.freeze({
  basic_information: {
    full_name: '',
    email: '',
    phone: '',
    website: '',
    address: '',
    city: '',
    state: '',
    zip: '',
    date_of_birth: '',
    age: null,
    gender: '',
    notes: '',
  },
  organization_details: {
    organization_type: '',
    ein: '',
    uei: '',
    cage_code: '',
    annual_budget: null,
    staff_count: null,
    mission: '',
    city: '',
    state: '',
    zip: '',
  },
  financial_information: {
    household_income: null,
    household_size: null,
    financial_need_level: '',
    low_income: false,
    unemployed: false,
    displaced_worker: false,
    notes: '',
  },
  government_assistance: {
    medicaid_enrolled: false,
    medicare_recipient: false,
    ssi_recipient: false,
    ssdi_recipient: false,
    snap_recipient: false,
    tanf_recipient: false,
    section8_housing: false,
    other_programs: '',
  },
  health_medical: {
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
    // Extra common health qualifiers used by matching/crawlers
    cancer_survivor: false,
    cancer_type: '',
    cancer_diagnosis_year: null,
    rare_disease: false,
    terminal_illness: false,
    notes: '',
  },
  demographics: {
    african_american: false,
    hispanic_latino: false,
    asian_american: false,
    native_american: false,
    tribal_affiliation: '',
    lgbtq: false,
    immigrant_status: 'unknown',
    notes: '',
  },
  family_life: {
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
    domestic_violence_survivor: false,
    trafficking_survivor: false,
    disaster_survivor: false,
    formerly_incarcerated: false,
    notes: '',
  },
  military_service: {
    veteran: false,
    active_duty_military: false,
    national_guard: false,
    disabled_veteran: false,
    military_spouse: false,
    military_dependent: false,
    gold_star_family: false,
    military_branch: '',
    service_era: '',
    discharge_status: '',
    va_disability_rating: null,
    notes: '',
  },
  occupation: {
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
    minority_owned_business: false,
    women_owned_business: false,
    union_member: false,
    farmer: false,
    truck_driver: false,
    job_title: '',
    employer: '',
    industry: '',
    notes: '',
  },
  location_focus: {
    rural_resident: false,
    appalachian_region: false,
    urban_underserved: false,
    geographic_focus: '',
    state: '',
    primary_zip: '',
    counties_served: [],
    notes: '',
  },
  university_applications: {
    applications: [],
  },
  narrative: {
    mission: '',
    primary_goal: '',
    target_population: '',
    funding_amount_needed: '',
    timeline: '',
    past_experience: '',
    unique_qualities: '',
    collaboration_partners: '',
    sustainability_plan: '',
    barriers_faced: '',
    special_circumstances: '',
  },
  // Raw canonical payload captured by the comprehensive application wizard.
  comprehensive_application: {
    ...COMPREHENSIVE_APPLICATION_DEFAULTS,
  },
})

export function buildProfileSectionPrompt(sectionKey, { profile, sections, documents }) {
  const config = SECTION_PROMPTS[sectionKey]
  if (!config) return null

  const currentSection = sections[sectionKey] ?? {}
  const relatedSections = Object.fromEntries(
    Object.entries(sections)
      .filter(([key]) => key !== sectionKey)
      .map(([key, value]) => [key, value]),
  )

  const documentSummaries = documents.slice(0, 8).map((doc) => ({
    id: doc.id,
    name: doc.name,
    type: doc.type,
    status: doc.status,
    notes: doc.notes ?? '',
  }))

  const context = {
    profile,
    section: currentSection,
    other_sections: relatedSections,
    documents: documentSummaries,
  }

  const prompt = `
You are an expert grant-preparation assistant. Your task is to suggest updated values for the "${config.title}" section in a comprehensive profile application.

Context:
${JSON.stringify(context, null, 2)}

Instructions:
${config.instructions}

Respond ONLY with valid JSON matching the following shape:
{
${config.keys.map((key) => `  "${key}": value`).join(',\n')}
}
  `.trim()

  return { prompt, config }
}

export const supportedSectionKeys = Object.keys(SECTION_PROMPTS)
export { SECTION_PROMPTS }

// Canonical schema keys (used for completeness/repair, not necessarily AI-enabled).
export const canonicalSectionKeys = Object.keys(CANONICAL_SECTION_DEFAULTS)