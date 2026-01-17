import { PROFILE_SCHEMA, supportedSectionKeys as schemaSectionKeys } from '../config/profileSchema.js'

const SECTION_PROMPTS = {
  basic_information: {
    title: PROFILE_SCHEMA.basic_information.title,
    instructions: `
Using the data below, fill out the primary contact fields for this profile. 
Return a JSON object containing the keys: ${Object.keys(PROFILE_SCHEMA.basic_information.fields).join(', ')}.

Rules:
- Pull from existing section data when available.
- Prefer information extracted from uploaded documents when it appears reliable (e.g. applications, IDs).
- Never fabricate personal data; if a field is unknown return an empty string.
- Preserve readable formatting for addresses and notes.
    `.trim(),
    keys: Object.keys(PROFILE_SCHEMA.basic_information.fields),
  },
  organization_details: {
    title: PROFILE_SCHEMA.organization_details.title,
    instructions: `
Using the context below, complete the organization details for this profile.
Return a JSON object with: ${Object.keys(PROFILE_SCHEMA.organization_details.fields).join(', ')}.

Rules:
- Pull official identifiers (EIN, UEI, CAGE) from documents or existing data if present.
- annual_budget and staff_count must be numeric. Use null when unknown.
- Summarise the mission in two concise sentences when possible.
- Never invent identifiers or financial values; leave them blank / null if unavailable.
    `.trim(),
    keys: Object.keys(PROFILE_SCHEMA.organization_details.fields),
  },
  financial_information: {
    title: PROFILE_SCHEMA.financial_information.title,
    instructions: `
Analyse the data and summarise the applicant's financial situation.
Return JSON with: ${Object.keys(PROFILE_SCHEMA.financial_information.fields).join(', ')}.

Rules:
- household_income should be a number (USD) when known, otherwise null.
- household_size must be an integer when known.
- financial_need_level should be a short descriptor (e.g. "high", "moderate", "unknown").
- low_income, unemployed, displaced_worker must be booleans.
- Use notes for concise explanations (max 2 sentences).
    `.trim(),
    keys: Object.keys(PROFILE_SCHEMA.financial_information.fields),
  },
  government_assistance: {
    title: PROFILE_SCHEMA.government_assistance.title,
    instructions: `
Determine which public benefits the applicant receives.
Return JSON with boolean flags for: medicaid_enrolled, medicare_recipient, ssi_recipient, ssdi_recipient, snap_recipient, tanf_recipient, section8_housing, other_programs (string).

Rules:
- Use the source documents to confirm enrollment when possible.
- When unsure, leave flags false and mention ambiguous evidence in other_programs.
- other_programs should be a short comma-separated list or an empty string.
    `.trim(),
    keys: Object.keys(PROFILE_SCHEMA.government_assistance.fields),
  },
  health_medical: {
    title: PROFILE_SCHEMA.health_medical.title,
    instructions: `
Review the profile and documents to capture relevant health information.
Return JSON with keys: ${Object.keys(PROFILE_SCHEMA.health_medical.fields).join(', ')}.

Rules:
- Flags must be booleans. If condition is not confirmed, leave false.
- disability_type should be an array of distinct values (strings).
- support_needs_level should be short (e.g. "high", "moderate", "low", "unknown").
- notes should summarise important medical context in <= 3 sentences.
    `.trim(),
    keys: Object.keys(PROFILE_SCHEMA.health_medical.fields),
  },
  demographics: {
    title: PROFILE_SCHEMA.demographics.title,
    instructions: `
Summarise demographic details relevant for grant eligibility.
Return JSON with keys: ${Object.keys(PROFILE_SCHEMA.demographics.fields).join(', ')}.

Rules:
- Booleans must reflect confirmed identities; do not infer from names alone.
- immigrant_status should be one of: "us_citizen", "permanent_resident", "refugee", "undocumented", "other", or "unknown".
- Use notes for additional context when relevant (<= 2 sentences).
    `.trim(),
    keys: Object.keys(PROFILE_SCHEMA.demographics.fields),
  },
  family_life: {
    title: PROFILE_SCHEMA.family_life.title,
    instructions: `
Highlight family circumstances and life events that can unlock program eligibility.
Return JSON with the following keys: ${Object.keys(PROFILE_SCHEMA.family_life.fields).join(', ')}.

Rules:
- Only mark flags true when information is explicit.
- notes should call out time-sensitive situations (<= 2 sentences).
    `.trim(),
    keys: Object.keys(PROFILE_SCHEMA.family_life.fields),
  },
  military_service: {
    title: PROFILE_SCHEMA.military_service.title,
    instructions: `
Determine the applicant's military affiliation.
Return JSON with: veteran, active_duty_military, national_guard, disabled_veteran, military_spouse, military_dependent, gold_star_family, notes.

Rules:
- Use documents (DD-214, service letters) when available.
- notes should mention branch, service years, or disability rating when relevant.
    `.trim(),
    keys: Object.keys(PROFILE_SCHEMA.military_service.fields),
  },
  occupation: {
    title: PROFILE_SCHEMA.occupation.title,
    instructions: `
Capture occupational indicators that influence program fit.
Return JSON with booleans for the following keys and a notes field: healthcare_worker, healthcare_worker_type, ems_worker, educator, firefighter, law_enforcement, public_servant, clergy, missionary, nonprofit_employee, small_business_owner, minority_owned_business, women_owned_business, union_member, farmer, truck_driver, notes.

Rules:
- For healthcare_worker_type supply a short description (e.g. "RN", "CNA") or empty string.
- notes may list additional roles or certifications.
    `.trim(),
    keys: Object.keys(PROFILE_SCHEMA.occupation.fields),
  },
  location_focus: {
    title: PROFILE_SCHEMA.location_focus.title,
    instructions: `
Record geographic context that impacts eligibility.
Return JSON with: ${Object.keys(PROFILE_SCHEMA.location_focus.fields).join(', ')}.

Rules:
- geographic_focus should describe primary service area or hometown if known.
- notes may include county, census tract, or other location qualifiers.
    `.trim(),
    keys: Object.keys(PROFILE_SCHEMA.location_focus.fields),
  },
  university_applications: {
    title: PROFILE_SCHEMA.university_applications.title,
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
    keys: Object.keys(PROFILE_SCHEMA.university_applications.fields),
  },
  narrative: {
    title: PROFILE_SCHEMA.narrative.title,
    instructions: `
Craft a concise narrative of the applicant's goals, challenges, and impact.
Return JSON with: mission, primary_goal, target_population, funding_amount_needed, timeline, past_experience, unique_qualities, collaboration_partners, sustainability_plan, barriers_faced, special_circumstances.

Rules:
- Use clear, persuasive sentences. Each field should be 1-3 sentences.
- funding_amount_needed should be a numeric estimate if available, otherwise descriptive text.
- If information is unavailable, return an empty string.
    `.trim(),
    keys: Object.keys(PROFILE_SCHEMA.narrative.fields),
  },
}

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

export const supportedSectionKeys = schemaSectionKeys
