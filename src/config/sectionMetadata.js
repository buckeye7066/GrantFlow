/**
 * Canonical section metadata — single source of truth for section and field meaning.
 *
 * Consumed by: ProfileSectionEditor (UI), Automation (page), helpRegistry, and backend prompts.
 * Pure JS (no React) — importable by both frontend and backend code.
 *
 * Addresses audit findings GF-AUDIT-021 (onboarding/help drift) and GF-AUDIT-022 (UI/domain coupling).
 *
 * @module sectionMetadata
 */

/**
 * SECTION_METADATA — keyed by canonical section key.
 *
 * Each entry contains:
 *   title       {string}   Human-readable section name shown in the UI and help system.
 *   description {string}   Short description of what the section captures and why it matters.
 *   applies_to  {string[]} (optional) Profile types this section is most relevant to.
 *   fields      {Array}    Field-level metadata: { name, label, help? }
 */
export const SECTION_METADATA = {
  basic_information: {
    title: "Basic Information",
    description:
      "Primary contact details for this profile. This maps to Section 2 of the comprehensive application.",
    fields: [
      { name: "full_name", label: "Full name / organization name", help: "Applicant or primary contact's full legal name." },
      { name: "email", label: "Email address", help: "Primary email address for the applicant or primary contact." },
      { name: "phone", label: "Phone number", help: "Primary phone number for the applicant or primary contact." },
      { name: "website", label: "Website", help: "Website or online profile URL (org site, portfolio, etc.)." },
      { name: "address", label: "Address", help: "Mailing address (street, city, state, ZIP)." },
      { name: "city", label: "City", help: "City of residence or primary organizational location." },
      { name: "state", label: "State", help: "2-letter US state abbreviation (e.g., TN, CA) for eligibility filtering." },
      { name: "zip_code", label: "ZIP code", help: "5-digit ZIP code for local/county/state eligibility and matching." },
      { name: "county", label: "County", help: "County of residence or operations." },
      { name: "date_of_birth", label: "Date of birth", help: "Date of birth (YYYY-MM-DD) for age-based eligibility programs." },
      { name: "gender", label: "Gender", help: "Gender identity when explicitly provided; used for women/men-focused programs." },
      { name: "nationality", label: "Nationality", help: "Nationality or country of origin." },
      { name: "notes", label: "Notes", help: "Freeform notes relevant to intake, context, and matching." },
      { name: "contacts", label: "Profile Contacts", help: "Additional contacts who have access to this profile." },
    ],
  },

  organization_details: {
    title: "Organization Details",
    description:
      "Entity registration, capacity indicators, and mission summary for Section 4 of the comprehensive application.",
    applies_to: ["organization", "nonprofit", "small_business", "government"],
    fields: [
      { name: "organization_type", label: "Organization type", help: "Type of applicant organization (e.g., nonprofit, church, school, small business)." },
      { name: "ein", label: "EIN (Tax ID)", help: "Employer Identification Number (EIN) if applicable." },
      { name: "uei", label: "UEI", help: "Unique Entity Identifier (UEI) for SAM.gov / federal grants." },
      { name: "cage_code", label: "CAGE Code", help: "CAGE code (federal contractor identifier) if applicable." },
      { name: "annual_budget", label: "Annual budget", help: "Annual operating budget (USD) if known." },
      { name: "staff_count", label: "Staff count", help: "Number of staff (FTE or headcount) if known." },
      { name: "mission", label: "Mission", help: "Organization mission statement or concise purpose." },
    ],
  },

  financial_information: {
    title: "Financial Situation",
    description:
      "Document income, household size, and employment status to support need-based matching.",
    fields: [
      { name: "annual_income", label: "Annual income (USD)", help: "Annual individual income (USD) if known." },
      { name: "household_income", label: "Household income (USD)", help: "Annual household income (USD) if known." },
      { name: "household_size", label: "Household size", help: "Number of people in the household (integer)." },
      { name: "financial_need_level", label: "Financial need level", help: "Short descriptor of need (e.g., high, moderate, unknown)." },
      { name: "low_income", label: "Low income household", help: "True if the applicant is explicitly low-income." },
      { name: "unemployed", label: "Currently unemployed", help: "True if the applicant is explicitly unemployed." },
      { name: "displaced_worker", label: "Displaced worker", help: "True if the applicant is a displaced worker (job loss/layoff)." },
      { name: "funding_needs", label: "Funding needs", help: "What the applicant needs funding for." },
      { name: "funding_purpose", label: "Funding purpose", help: "How funds will be used." },
      { name: "receives_assistance", label: "Receives assistance (list)", help: "Current benefits or assistance programs received." },
      { name: "assistance_notes", label: "Assistance notes", help: "Any nuance about benefits or barriers." },
      { name: "notes", label: "Notes", help: "Concise context about income or need (max ~2 sentences)." },
    ],
  },

  government_assistance: {
    title: "Government Assistance",
    description:
      "Track public benefits to strengthen eligibility profiling for specific funds.",
    fields: [
      { name: "medicaid_enrolled", label: "Medicaid enrolled", help: "True if enrolled in Medicaid." },
      { name: "medicaid_waiver_program", label: "Medicaid waiver program", help: "Medicaid waiver program when applicable (e.g., ecf_choices)." },
      { name: "ecf_choices_role", label: "ECF CHOICES role", help: "ECF CHOICES role for unlocking the crawler: participant, caregiver, or provider." },
      { name: "medicare_recipient", label: "Medicare recipient", help: "True if receiving Medicare." },
      { name: "ssi_recipient", label: "SSI recipient", help: "True if receiving SSI." },
      { name: "ssdi_recipient", label: "SSDI recipient", help: "True if receiving SSDI." },
      { name: "snap_recipient", label: "SNAP recipient", help: "True if receiving SNAP (food stamps)." },
      { name: "tanf_recipient", label: "TANF recipient", help: "True if receiving TANF." },
      { name: "section8_housing", label: "Section 8 housing", help: "True if receiving Section 8 housing voucher." },
      { name: "other_programs", label: "Other programs", help: "Comma-separated list of other benefits or programs." },
    ],
  },

  health_medical: {
    title: "Health & Medical",
    description:
      "Capture relevant health information to highlight eligibility for medical and disability-focused opportunities.",
    fields: [
      { name: "conditions", label: "Conditions (list)", help: "List of health conditions. Minimum shape per entry: { name, icd10?, stage?, diagnosed_year? }." },
      { name: "chronic_illness", label: "Chronic illness", help: "True if chronic illness is explicitly stated." },
      { name: "chronic_illness_type", label: "Illness type", help: "Type or name of chronic illness if provided." },
      { name: "disability_type", label: "Disability types", help: "List of disability types when explicitly stated." },
      { name: "support_needs", label: "Support needs (list)", help: "Support needs (e.g., transportation, copay_assistance, lodging, caregiver_support)." },
      { name: "support_needs_level", label: "Support needs level", help: "Short descriptor of support needs (high/moderate/low/unknown)." },
      { name: "consent_for_studies", label: "Consent to view research studies/trials", help: "True if the user opts in to seeing research studies or trials." },
      { name: "mobility_or_transport_notes", label: "Mobility / transportation notes", help: "Optional notes about mobility or transportation needs for appointments." },
      { name: "dialysis_patient", label: "Dialysis patient", help: "True if on dialysis." },
      { name: "organ_transplant", label: "Organ transplant recipient", help: "True if transplant recipient or candidate." },
      { name: "hiv_aids", label: "Living with HIV/AIDS", help: "True if HIV/AIDS is explicitly stated." },
      { name: "tbi_survivor", label: "Traumatic brain injury survivor", help: "True if traumatic brain injury survivor." },
      { name: "amputee", label: "Amputee", help: "True if amputee." },
      { name: "neurodivergent", label: "Neurodivergent", help: "True if neurodivergent (autism/ADHD/etc.) is stated." },
      { name: "visual_impairment", label: "Visual impairment", help: "True if visual impairment or blindness is stated." },
      { name: "hearing_impairment", label: "Hearing impairment", help: "True if hearing impairment or deafness is stated." },
      { name: "wheelchair_user", label: "Wheelchair user", help: "True if wheelchair user." },
      { name: "substance_recovery", label: "In substance recovery", help: "True if in recovery or substance use recovery is stated." },
      { name: "mental_health_condition", label: "Mental health condition", help: "True if a mental health condition is stated." },
      { name: "notes", label: "Medical notes", help: "Brief medical context (up to ~3 sentences)." },
    ],
  },

  medical_insurance: {
    title: "Medical Insurance",
    description: "Store insurance details (provider/plan). Upload insurance cards or letters in the Files panel.",
    applies_to: ["medical_assistance", "medical_need", "individual_need", "family"],
    fields: [
      { name: "insurance_provider", label: "Insurance provider", help: "Primary insurance provider name (e.g., BlueCross, Aetna, Medicaid managed-care plan)." },
      { name: "plan_name", label: "Plan name", help: "Plan name (e.g., HMO/PPO plan name) if known." },
      { name: "plan_type", label: "Plan type", help: "Plan type (e.g., HMO, PPO, Medicaid, Medicare, Marketplace)." },
      { name: "member_id", label: "Member ID (optional)", help: "Member/Subscriber ID if explicitly provided in documents; leave blank if unknown." },
      { name: "group_id", label: "Group ID (optional)", help: "Group ID if explicitly provided in documents; leave blank if unknown." },
      { name: "policy_holder_name", label: "Policy holder name", help: "Name of policy holder when relevant." },
      { name: "effective_date", label: "Effective date", help: "Coverage effective date (YYYY-MM-DD) if known." },
      { name: "phone_for_claims", label: "Member services phone", help: "Member services or claims phone number if known." },
      { name: "notes", label: "Notes", help: "High-level notes about coverage gaps, copays, prior auth needs, etc." },
    ],
  },

  medical_history: {
    title: "Medical History & Needs",
    description: "Capture medical context needed for assistance resources and support letters (keep concise).",
    applies_to: ["medical_assistance", "medical_need", "individual_need", "family"],
    fields: [
      { name: "primary_condition", label: "Primary condition", help: "Primary condition or diagnosis when explicitly stated." },
      { name: "secondary_conditions", label: "Secondary conditions", help: "Other conditions or diagnoses explicitly stated." },
      { name: "mobility_needs", label: "Mobility needs", help: "Mobility needs summary (e.g., wheelchair, walker, limited standing)." },
      { name: "dme_needed", label: "DME needed", help: "Durable medical equipment needed (e.g., shower chair) when explicitly stated." },
      { name: "doctor_name", label: "Doctor / clinician", help: "Primary clinician or doctor name if known." },
      { name: "clinic_name", label: "Clinic / hospital", help: "Clinic or hospital name if known." },
      { name: "letter_support_needed", label: "Support letter needed", help: "True if a letter of medical necessity or support letter is needed." },
      { name: "notes", label: "Notes", help: "Concise medical history context (up to ~5 sentences)." },
    ],
  },

  nonprofit_compliance: {
    title: "Nonprofit Compliance",
    description: "Track core compliance readiness signals used by many grants.",
    applies_to: ["nonprofit", "organization"],
    fields: [
      { name: "is_501c3", label: "501(c)(3) status confirmed", help: "True if 501(c)(3) status is confirmed." },
      { name: "fiscal_sponsor", label: "Uses a fiscal sponsor", help: "True if operating under a fiscal sponsor." },
      { name: "fiscal_sponsor_name", label: "Fiscal sponsor name", help: "Fiscal sponsor name if applicable." },
      { name: "sam_registered", label: "SAM.gov registered", help: "True if SAM.gov registration is confirmed." },
      { name: "insurance_coverage", label: "Insurance coverage", help: "General insurance coverage (GL, D&O) if known." },
      { name: "compliance_notes", label: "Compliance notes", help: "Notes about audits, policies, and compliance gaps." },
    ],
  },

  small_business_details: {
    title: "Small Business Details",
    description: "Track business details needed for small business programs and certifications.",
    applies_to: ["small_business"],
    fields: [
      { name: "business_name", label: "Business name", help: "Legal business name if different from profile name." },
      { name: "naics_code", label: "NAICS code", help: "NAICS code if known." },
      { name: "years_in_business", label: "Years in business", help: "Years in business (integer) if known." },
      { name: "employee_count", label: "Employee count", help: "Employee count if known." },
      { name: "annual_revenue", label: "Annual revenue (USD)", help: "Annual revenue (USD) if known." },
      { name: "certifications", label: "Certifications", help: "Certifications (e.g., WOSB, HUBZone, MBE) when explicitly stated." },
      { name: "notes", label: "Notes", help: "Notes about products/services, capacity, and priorities." },
    ],
  },

  demographics: {
    title: "Demographics",
    description:
      "Document demographic information that influences funding eligibility and reporting requirements.",
    fields: [
      { name: "african_american", label: "African American / Black", help: "True if Black/African American identity stated." },
      { name: "hispanic_latino", label: "Hispanic / Latino", help: "True if Hispanic/Latino identity stated." },
      { name: "asian_american", label: "Asian American / Pacific Islander", help: "True if Asian/AAPI identity stated." },
      { name: "native_american", label: "Native American / Alaska Native", help: "True if Native American/Indigenous identity stated." },
      { name: "tribal_affiliation", label: "Tribal affiliation", help: "Tribal affiliation if specified." },
      { name: "lgbtq", label: "Identifies as LGBTQ+", help: "True if LGBTQ+ identity stated." },
      { name: "immigrant_status", label: "Immigration status", help: "One of: us_citizen, permanent_resident, refugee, undocumented, other, unknown." },
      { name: "ethnicity", label: "Ethnicity (free text)", help: "Ethnicity (freeform)." },
      { name: "heritage", label: "Heritage / ancestry", help: "Heritage or ancestry (freeform)." },
      { name: "languages", label: "Languages (list)", help: "Languages spoken (comma-separated)." },
      { name: "religious_affiliation", label: "Religious affiliation", help: "Religious affiliation if relevant." },
      { name: "citizenship", label: "Citizenship", help: "Citizenship status or country." },
      { name: "us_citizen", label: "US citizen", help: "True if US citizen." },
      { name: "disability_status", label: "Disability status (high level)", help: "High-level disability status descriptor." },
      { name: "veteran_status", label: "Veteran status (high level)", help: "High-level veteran status descriptor." },
      { name: "age_group", label: "Age group", help: "Age group (e.g., youth, young adult, senior)." },
      { name: "white_caucasian", label: "White / Caucasian", help: "True if White/Caucasian identity stated." },
      { name: "notes", label: "Demographic notes", help: "Additional demographic context or identities." },
    ],
  },

  family_life: {
    title: "Family & Life Situation",
    description:
      "Capture household and life events that may trigger eligibility for supportive programs.",
    fields: [
      { name: "single_parent", label: "Single parent household", help: "True if single parent." },
      { name: "foster_youth", label: "Current/former foster youth", help: "True if current or former foster youth." },
      { name: "orphan", label: "Orphan", help: "True if orphan." },
      { name: "adopted", label: "Adopted", help: "True if adopted." },
      { name: "foster_parent", label: "Foster parent", help: "True if foster parent." },
      { name: "caregiver", label: "Primary caregiver (non-parent)", help: "True if caregiver for someone else." },
      { name: "widow_widower", label: "Widow / widower", help: "True if widowed." },
      { name: "grandparent_raising_grandchildren", label: "Grandparent raising grandchildren", help: "True if grandparent raising grandchildren." },
      { name: "first_time_parent", label: "First-time parent", help: "True if first-time parent." },
      { name: "homeless", label: "Experiencing homelessness", help: "True if homeless or housing insecure." },
      { name: "domestic_violence_survivor", label: "Domestic violence survivor", help: "True if domestic violence survivor." },
      { name: "trafficking_survivor", label: "Human trafficking survivor", help: "True if human trafficking survivor." },
      { name: "disaster_survivor", label: "Disaster survivor", help: "True if disaster survivor (fire/flood/storm/etc.)." },
      { name: "formerly_incarcerated", label: "Formerly incarcerated / returning citizen", help: "True if formerly incarcerated." },
      { name: "notes", label: "Life circumstances notes", help: "Brief life situation context (up to ~2 sentences)." },
    ],
  },

  military_service: {
    title: "Military Status",
    description:
      "Record any military service or affiliation to unlock veteran-focused resources.",
    fields: [
      { name: "veteran", label: "Veteran", help: "True if veteran." },
      { name: "active_duty_military", label: "Active duty military", help: "True if active duty." },
      { name: "national_guard", label: "National Guard / Reserve", help: "True if National Guard or Reserve." },
      { name: "disabled_veteran", label: "Disabled veteran", help: "True if disabled veteran." },
      { name: "military_spouse", label: "Military spouse", help: "True if military spouse." },
      { name: "military_dependent", label: "Military dependent", help: "True if military dependent or child." },
      { name: "gold_star_family", label: "Gold Star family", help: "True if Gold Star family." },
      { name: "notes", label: "Service details", help: "Branch, years of service, disability rating context when relevant." },
    ],
  },

  occupation: {
    title: "Occupation",
    description:
      "Track professional roles and designations relevant to workforce or training programs.",
    fields: [
      { name: "healthcare_worker", label: "Healthcare worker", help: "True if healthcare worker." },
      { name: "healthcare_worker_type", label: "Healthcare role", help: "Healthcare role type (e.g., RN, CNA, EMT)." },
      { name: "ems_worker", label: "EMS/First responder", help: "True if EMS worker or first responder." },
      { name: "educator", label: "Educator / teacher", help: "True if educator or teacher." },
      { name: "firefighter", label: "Firefighter", help: "True if firefighter." },
      { name: "law_enforcement", label: "Law enforcement / corrections", help: "True if law enforcement or corrections officer." },
      { name: "public_servant", label: "Public servant / government employee", help: "True if public servant or government worker." },
      { name: "clergy", label: "Clergy / religious worker", help: "True if clergy or religious worker." },
      { name: "missionary", label: "Missionary / evangelist", help: "True if missionary or evangelist." },
      { name: "nonprofit_employee", label: "Nonprofit employee", help: "True if nonprofit employee." },
      { name: "small_business_owner", label: "Small business owner", help: "True if small business owner." },
      { name: "minority_owned_business", label: "Minority-owned business", help: "True if minority-owned business." },
      { name: "women_owned_business", label: "Women-owned business", help: "True if women-owned business." },
      { name: "union_member", label: "Union member", help: "True if union member." },
      { name: "farmer", label: "Agricultural worker / farmer", help: "True if farmer or agricultural worker." },
      { name: "truck_driver", label: "Truck driver / transportation worker", help: "True if truck driver or transportation worker." },
      { name: "notes", label: "Occupational notes", help: "Additional occupations, certifications, or union local." },
    ],
  },

  location_focus: {
    title: "Location Focus",
    description:
      "Define where the applicant lives or delivers services to align with geographic funding criteria.",
    fields: [
      { name: "rural_resident", label: "Rural resident", help: "True if rural resident or served area is rural." },
      { name: "appalachian_region", label: "Located in Appalachian region", help: "True if located in or serving Appalachia." },
      { name: "urban_underserved", label: "Urban underserved community", help: "True if located in or serving an underserved urban area." },
      { name: "geographic_focus", label: "Geographic focus", help: "Primary geography served or targeted." },
      { name: "notes", label: "Location notes", help: "County, census tract, or other location qualifiers." },
    ],
  },

  university_applications: {
    title: "University Applications",
    description: "Student college application tracking (for scholarship targeting).",
    fields: [
      { name: "applications", label: "Applications", help: "Array of tracked college applications and their details." },
    ],
  },

  education: {
    title: "Education",
    description:
      "Academic history and student qualifiers (GPA, tests, service hours) for scholarship and education-focused matching.",
    applies_to: ["student", "college_student", "high_school_student", "graduate_student"],
    fields: [
      { name: "highest_level", label: "Highest level completed", help: "Highest education level attained (freeform string)." },
      { name: "current_institution", label: "Current institution", help: "Current institution or school name." },
      { name: "target_colleges", label: "Target colleges (list)", help: "Target colleges or universities (comma-separated)." },
      { name: "intended_major", label: "Intended major", help: "Intended major or program." },
      { name: "gpa", label: "GPA", help: "GPA when explicitly provided." },
      { name: "act_score", label: "ACT score", help: "ACT score when explicitly provided." },
      { name: "sat_score", label: "SAT score", help: "SAT score when explicitly provided." },
      { name: "community_service_hours", label: "Community service hours", help: "Community service hours when known." },
      { name: "leadership_roles", label: "Leadership roles (list)", help: "Leadership roles (comma-separated)." },
      { name: "valedictorian", label: "Valedictorian", help: "True if valedictorian (explicitly stated)." },
      { name: "notes", label: "Education notes", help: "Additional education context." },
    ],
  },

  employment: {
    title: "Employment",
    description:
      "Employment status and experience used for workforce training and career-change programs.",
    fields: [
      { name: "current_status", label: "Current status", help: "Current employment status (e.g., employed, unemployed, student, retired)." },
      { name: "career_goal", label: "Career goal", help: "Career goal (freeform)." },
      { name: "experience", label: "Experience", help: "Brief experience summary (freeform)." },
      { name: "notes", label: "Employment notes", help: "Additional employment context." },
    ],
  },

  housing: {
    title: "Housing",
    description:
      "Housing stability and geographic designations relevant to assistance programs.",
    fields: [
      { name: "status", label: "Housing status", help: "Housing status (e.g., stable, at-risk, homeless, unknown)." },
      { name: "type", label: "Housing type", help: "Housing type (rent, own, shelter, transitional, etc.)." },
      { name: "address", label: "Housing address (if different)", help: "Housing address when explicitly provided." },
      { name: "broadband_speed", label: "Broadband speed", help: "Broadband speed or connectivity details if relevant." },
      { name: "geographic_designation", label: "Geographic designation (list)", help: "Geographic designations (e.g., rural, urban, frontier)." },
      { name: "notes", label: "Housing notes", help: "Additional housing context." },
    ],
  },

  family: {
    title: "Household Details",
    description:
      "Household structure and support system details (separate from eligibility flags).",
    fields: [
      { name: "household_size", label: "Household size", help: "Household size when known." },
      { name: "responsibilities", label: "Responsibilities", help: "Primary household responsibilities or caregiving context." },
      { name: "support_system", label: "Support system", help: "Support system description." },
      { name: "notes", label: "Household notes", help: "Additional household context." },
    ],
  },

  programs_services: {
    title: "Programs & Services",
    description:
      "Focus areas, services, and keywords used to match funding opportunities (high-signal for crawlers).",
    fields: [
      { name: "focus_areas", label: "Focus areas (list)", help: "Focus areas (comma-separated)." },
      { name: "interests", label: "Interests (list)", help: "Interests (comma-separated)." },
      { name: "keywords", label: "Keywords (list)", help: "Keywords or tags (comma-separated)." },
      { name: "notes", label: "Programs/services notes", help: "Additional program or service notes." },
    ],
  },

  narrative: {
    title: "Story & Goals",
    description:
      "Summarize the applicant's mission, goals, and unique narrative to feed proposals and AI tooling.",
    fields: [
      { name: "mission", label: "Mission", help: "Mission statement or personal mission." },
      { name: "primary_goal", label: "Primary goal", help: "Primary goal of the applicant or project." },
      { name: "target_population", label: "Target population", help: "Who benefits from the work (population served)." },
      { name: "funding_amount_needed", label: "Funding amount needed", help: "Requested or needed funding amount (numeric or descriptive)." },
      { name: "timeline", label: "Timeline", help: "Timeline for the project or need." },
      { name: "past_experience", label: "Past experience", help: "Relevant past experience or track record." },
      { name: "unique_qualities", label: "Unique qualities", help: "What makes the applicant or project unique." },
      { name: "collaboration_partners", label: "Collaboration partners", help: "Partner organizations or individuals." },
      { name: "sustainability_plan", label: "Sustainability plan", help: "Plan for sustaining the work beyond this grant." },
      { name: "barriers_faced", label: "Barriers faced", help: "Obstacles the applicant is navigating." },
      { name: "special_circumstances", label: "Special circumstances", help: "Any special circumstances that should inform the application." },
    ],
  },
}

// ── Helper functions ──────────────────────────────────────────────────────────

/**
 * Get the display title for a section.
 * @param {string} key
 * @returns {string}
 */
export function getSectionTitle(key) {
  return SECTION_METADATA[key]?.title ?? key.replace(/_/g, ' ')
}

/**
 * Get the human-readable description for a section.
 * @param {string} key
 * @returns {string}
 */
export function getSectionDescription(key) {
  return SECTION_METADATA[key]?.description ?? ''
}

/**
 * Get the field metadata array for a section.
 * @param {string} key
 * @returns {Array<{ name: string, label: string, help?: string }>}
 */
export function getSectionFields(key) {
  return SECTION_METADATA[key]?.fields ?? []
}

/**
 * Get the help text for a specific field within a section.
 * @param {string} sectionKey
 * @param {string} fieldName
 * @returns {string}
 */
export function getFieldHelp(sectionKey, fieldName) {
  return getSectionFields(sectionKey).find((f) => f.name === fieldName)?.help ?? ''
}

/**
 * Canonical list of all section keys defined in SECTION_METADATA.
 */
export const SECTION_KEYS = Object.keys(SECTION_METADATA)
