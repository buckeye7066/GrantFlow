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
      { name: "full_name", label: "Full name / organization name", format: "text", help: "Applicant or primary contact's full legal name." },
      { name: "email", label: "Email address", format: "email", help: "Primary email address for the applicant or primary contact." },
      { name: "phone", label: "Phone number", format: "phone", help: "Primary phone number for the applicant or primary contact." },
      { name: "website", label: "Website", format: "url", help: "Website or online profile URL (org site, portfolio, etc.)." },
      { name: "address", label: "Address", format: "json", help: "Mailing address (street, city, state, ZIP)." },
      { name: "academic_status", label: "Academic Status", format: "json", help: "Structured academic details extracted from profile intake." },
      { name: "demographics", label: "Demographics", format: "json", help: "Structured demographic details extracted from profile intake." },
      { name: "city", label: "City", format: "text", help: "City of residence or primary organizational location." },
      { name: "state", label: "State", format: "text", help: "2-letter US state abbreviation (e.g., TN, CA) for eligibility filtering." },
      { name: "zip_code", label: "ZIP code", format: "text", help: "5-digit ZIP code for local/county/state eligibility and matching." },
      { name: "county", label: "County", format: "text", help: "County of residence or operations." },
      { name: "date_of_birth", label: "Date of birth", format: "date", help: "Date of birth (YYYY-MM-DD) for age-based eligibility programs." },
      { name: "gender", label: "Gender", format: "text", help: "Gender identity when explicitly provided; used for women/men-focused programs." },
      { name: "nationality", label: "Nationality", format: "text", help: "Nationality or country of origin." },
      { name: "notes", label: "Notes", format: "text", help: "Freeform notes relevant to intake, context, and matching." },
      { name: "contacts", label: "Profile Contacts", format: "json", help: "Additional contacts who have access to this profile." },
    ],
  },

  organization_details: {
    title: "Organization Details",
    description:
      "Entity registration, capacity indicators, and mission summary for Section 4 of the comprehensive application.",
    applies_to: ["organization", "nonprofit", "small_business", "government"],
    fields: [
      { name: "organization_type", label: "Organization type", format: "text", help: "Type of applicant organization (e.g., nonprofit, church, school, small business)." },
      { name: "ein", label: "EIN (Tax ID)", format: "text", help: "Employer Identification Number (EIN) if applicable." },
      { name: "uei", label: "UEI", format: "text", help: "Unique Entity Identifier (UEI) for SAM.gov / federal grants." },
      { name: "cage_code", label: "CAGE Code", format: "text", help: "CAGE code (federal contractor identifier) if applicable." },
      { name: "annual_budget", label: "Annual budget", format: "currency_usd", help: "Annual operating budget (USD) if known." },
      { name: "staff_count", label: "Staff count", format: "text", help: "Number of staff (FTE or headcount) if known." },
      { name: "mission", label: "Mission", format: "text", help: "Organization mission statement or concise purpose." },
      // Federal Compliance
      { name: "sam_gov_registered", label: "SAM.gov Registered", format: "text", help: "Required for all federal grants." },
      { name: "grants_gov_account", label: "Grants.gov Account Active", format: "text", help: "Increases eligibility for federal opportunities." },
      { name: "era_commons_account", label: "eRA Commons Account (NIH/Health Research)", format: "text", help: "NIH eRA Commons account for health research grants." },
      { name: "sam_exclusions_passed", label: "SAM Exclusions Check Passed", format: "text", help: "Not debarred from federal contracts." },
      { name: "audited_financials", label: "Audited Financials Available", format: "text", help: "Audited financial statements available." },
      { name: "nicra_rate", label: "NICRA Indirect Cost Rate (%)", format: "percent", help: "Federally Negotiated Indirect Cost Rate." },
      { name: "ntee_code", label: "NTEE Code", format: "text", help: "National Taxonomy of Exempt Entities (e.g., A01, B20)." },
      // General Qualifications
      { name: "is_faith_based", label: "Faith-Based Organization / Church / Ministry", format: "boolean_tri", help: "True if faith-based organization, church, or ministry." },
      { name: "is_rural_serving", label: "Serves Rural Area", format: "boolean_tri", help: "True if serving a rural area." },
      { name: "is_minority_serving", label: "Minority-Serving Organization", format: "boolean_tri", help: "True if minority-serving organization." },
      { name: "is_501c3_public_charity", label: "501(c)(3) Public Charity", format: "boolean_tri", help: "True if 501(c)(3) public charity." },
      { name: "is_501c3_private_foundation", label: "501(c)(3) Private Foundation", format: "boolean_tri", help: "True if 501(c)(3) private foundation." },
      // Business Certifications
      { name: "cert_8a", label: "8(a) Certified", format: "text", help: "SBA program for disadvantaged businesses." },
      { name: "cert_hubzone", label: "HUBZone Certified", format: "text", help: "True if HUBZone certified." },
      { name: "cert_sdvosb", label: "Service-Disabled Veteran-Owned Small Business (SDVOSB)", format: "text", help: "True if SDVOSB certified." },
      { name: "cert_mbe", label: "Minority Business Enterprise (MBE)", format: "text", help: "True if MBE certified." },
      { name: "cert_wbe", label: "Women Business Enterprise (WBE)", format: "text", help: "True if WBE certified." },
      { name: "cert_sbir_sttr", label: "SBIR/STTR Eligible", format: "text", help: "True if eligible for SBIR/STTR programs." },
      // Geographic & Special Designations
      { name: "in_opportunity_zone", label: "Opportunity Zone Location", format: "text", help: "Economically distressed community eligible for tax incentives." },
      { name: "in_qct", label: "Qualified Census Tract (QCT)", format: "text", help: "HUD-designated low-income area." },
      { name: "in_epa_ej_area", label: "EPA Environmental Justice Area", format: "text", help: "True if located in an EPA Environmental Justice area." },
      { name: "in_usda_persistent_poverty_county", label: "USDA Persistent-Poverty County", format: "text", help: "True if located in a USDA persistent-poverty county." },
      { name: "in_appalachian_region", label: "Appalachian Region", format: "text", help: "Served by Appalachian Regional Commission." },
      { name: "broadband_unserved", label: "Broadband-Unserved (FCC Map Block)", format: "text", help: "No high-speed internet — USDA ReConnect and NTIA grants." },
      { name: "in_fema_disaster_area", label: "FEMA Disaster Declaration Area", format: "text", help: "True if located in a FEMA disaster declaration area." },
      // Specialized Org Types
      { name: "is_tribal_government", label: "Tribal Government / Tribally Controlled Organization", format: "boolean_tri", help: "True if tribal government or tribally controlled organization." },
      { name: "is_community_action_agency", label: "Community Action Agency (CAA)", format: "boolean_tri", help: "CSBG eligible entity." },
      { name: "is_housing_authority", label: "Housing Authority", format: "boolean_tri", help: "True if housing authority." },
      { name: "is_workforce_dev_board", label: "Workforce Development Board", format: "boolean_tri", help: "True if workforce development board." },
      { name: "is_cdfi", label: "CDFI Partner", format: "boolean_tri", help: "Community Development Financial Institution." },
      { name: "is_msi_hbcu", label: "MSI/HBCU/HSI/TCU", format: "boolean_tri", help: "Minority-Serving Institution." },
      { name: "is_rural_health_clinic", label: "Rural Health Clinic (RHC)", format: "boolean_tri", help: "True if rural health clinic." },
      { name: "is_cooperative", label: "Cooperative (Ag/Electric/Housing/Worker)", format: "boolean_tri", help: "True if cooperative organization." },
    ],
  },

  financial_information: {
    title: "Financial Situation",
    description:
      "Document income, household size, and employment status to support need-based matching.",
    fields: [
      { name: "annual_income", label: "Annual income (USD)", format: "currency_usd", help: "Annual individual income (USD) if known." },
      { name: "household_income", label: "Household income (USD)", format: "currency_usd", help: "Annual household income (USD) if known." },
      { name: "household_size", label: "Household size", format: "text", help: "Number of people in the household (integer)." },
      { name: "financial_need_level", label: "Financial need level", format: "enum", help: "Short descriptor of need (e.g., high, moderate, unknown)." },
      { name: "low_income", label: "Low income household", format: "boolean_tri", help: "True if the applicant is explicitly low-income." },
      { name: "unemployed", label: "Employment status", format: "enum", options: ["student", "not_in_labor_force", "unemployed_seeking", "employed_full_time", "employed_part_time", "self_employed", "retired"], help: "Employment status aligned with Employment > Current status." },
      { name: "displaced_worker", label: "Displaced worker", format: "boolean_tri", help: "True if the applicant is a displaced worker (job loss/layoff)." },
      { name: "funding_needs", label: "Funding needs", format: "enum", help: "What the applicant needs funding for." },
      { name: "funding_purpose", label: "Funding purpose", format: "enum", help: "How funds will be used." },
      { name: "receives_assistance", label: "Receives assistance (list)", format: "boolean_tri", help: "Current benefits or assistance programs received." },
      { name: "assistance_notes", label: "Assistance notes", format: "text", help: "Any nuance about benefits or barriers." },
      { name: "notes", label: "Notes", format: "text", help: "Concise context about income or need (max ~2 sentences)." },
      { name: "underemployed", label: "Underemployed", format: "boolean_tri", help: "Working part-time or below skill level." },
      { name: "has_medical_debt", label: "Medical Debt", format: "boolean_tri", help: "Outstanding medical bills — debt relief programs available." },
      { name: "has_education_debt", label: "Education/Student Loan Debt", format: "boolean_tri", help: "Student loan forgiveness programs available." },
      { name: "bankruptcy_foreclosure", label: "Bankruptcy / Foreclosure", format: "boolean_tri", help: "Recent financial crisis — recovery assistance available." },
      { name: "first_time_homebuyer", label: "First-Time Homebuyer", format: "boolean_tri", help: "Down payment assistance programs available." },
    ],
  },

  government_assistance: {
    title: "Government Assistance",
    description:
      "Track public benefits to strengthen eligibility profiling for specific funds.",
    fields: [
      { name: "medicaid_recipient_self", label: "Medicaid recipient self", format: "boolean_tri", help: "True if the applicant personally receives Medicaid." },
      { name: "medicaid_recipient_household", label: "Medicaid recipient household", format: "boolean_tri", help: "True if someone in the applicant's household receives Medicaid." },
      { name: "medicaid_waiver_program", label: "Medicaid waiver program", format: "text", help: "Medicaid waiver program when applicable (e.g., ecf_choices)." },
      { name: "ecf_choices_role", label: "ECF CHOICES role", format: "enum", help: "ECF CHOICES role for unlocking the crawler: participant, caregiver, or provider." },
      { name: "medicare_recipient_self", label: "Medicare recipient self", format: "boolean_tri", help: "True if the applicant personally receives Medicare." },
      { name: "medicare_recipient_household", label: "Medicare recipient household", format: "boolean_tri", help: "True if someone in the applicant's household receives Medicare." },
      { name: "ssi_recipient_self", label: "SSI recipient self", format: "boolean_tri", help: "True if the applicant personally receives SSI." },
      { name: "ssi_recipient_household", label: "SSI recipient household", format: "boolean_tri", help: "True if someone in the applicant's household receives SSI." },
      { name: "ssdi_recipient_self", label: "SSDI recipient self", format: "boolean_tri", help: "True if the applicant personally receives SSDI." },
      { name: "ssdi_recipient_household", label: "SSDI recipient household", format: "boolean_tri", help: "True if someone in the applicant's household receives SSDI." },
      { name: "snap_recipient_self", label: "SNAP recipient self", format: "boolean_tri", help: "True if the applicant personally receives SNAP." },
      { name: "snap_recipient_household", label: "SNAP recipient household", format: "boolean_tri", help: "True if someone in the applicant's household receives SNAP." },
      { name: "tanf_recipient_self", label: "TANF recipient self", format: "boolean_tri", help: "True if the applicant personally receives TANF." },
      { name: "tanf_recipient_household", label: "TANF recipient household", format: "boolean_tri", help: "True if someone in the applicant's household receives TANF." },
      { name: "section8_recipient_self", label: "Section 8 recipient self", format: "boolean_tri", help: "True if the applicant personally receives Section 8 housing assistance." },
      { name: "section8_recipient_household", label: "Section 8 recipient household", format: "boolean_tri", help: "True if someone in the applicant's household receives Section 8 housing assistance." },
      { name: "other_programs", label: "Other programs", format: "text", help: "Comma-separated list of other benefits or programs." },
    ],
  },

  health_medical: {
    title: "Health & Medical",
    description:
      "Capture relevant health information to highlight eligibility for medical and disability-focused opportunities.",
    fields: [
      { name: "conditions", label: "Conditions (list)", format: "json", help: "List of health conditions. Minimum shape per entry: { name, icd10?, stage?, diagnosed_year? }." },
      { name: "chronic_illness", label: "Chronic illness", format: "boolean_tri", help: "True if chronic illness is explicitly stated." },
      { name: "chronic_illness_type", label: "Illness type", format: "text", help: "Type or name of chronic illness if provided." },
      { name: "disability_type", label: "Disability types", format: "text", help: "List of disability types when explicitly stated." },
      { name: "support_needs", label: "Support needs (list)", format: "text", help: "Support needs (e.g., transportation, copay_assistance, lodging, caregiver_support)." },
      { name: "support_needs_level", label: "Support needs level", format: "text", help: "Short descriptor of support needs (high/moderate/low/unknown)." },
      { name: "consent_for_studies", label: "Consent to view research studies/trials", format: "text", help: "True if the user opts in to seeing research studies or trials." },
      { name: "mobility_or_transport_notes", label: "Mobility / transportation notes", format: "text", help: "Optional notes about mobility or transportation needs for appointments." },
      { name: "dialysis_patient", label: "Dialysis patient", format: "text", help: "True if on dialysis." },
      { name: "organ_transplant", label: "Organ transplant recipient", format: "text", help: "True if transplant recipient or candidate." },
      { name: "hiv_aids", label: "Living with HIV/AIDS", format: "text", help: "True if HIV/AIDS is explicitly stated." },
      { name: "tbi_survivor", label: "Traumatic brain injury survivor", format: "boolean_tri", help: "True if traumatic brain injury survivor." },
      { name: "amputee", label: "Amputee", format: "text", help: "True if amputee." },
      { name: "neurodivergent", label: "Neurodivergent", format: "text", help: "True if neurodivergent (autism/ADHD/etc.) is stated." },
      { name: "visual_impairment", label: "Visual impairment", format: "boolean_tri", help: "True if visual impairment or blindness is stated." },
      { name: "hearing_impairment", label: "Hearing impairment", format: "boolean_tri", help: "True if hearing impairment or deafness is stated." },
      { name: "wheelchair_user", label: "Wheelchair user", format: "boolean_tri", help: "True if wheelchair user." },
      { name: "substance_recovery", label: "In substance recovery", format: "boolean_tri", help: "True if in recovery or substance use recovery is stated." },
      { name: "mental_health_condition", label: "Mental health condition", format: "boolean_tri", help: "True if a mental health condition is stated." },
      { name: "notes", label: "Medical notes", format: "text", help: "Brief medical context (up to ~3 sentences)." },
    ],
  },

  medical_insurance: {
    title: "Medical Insurance",
    description: "Store insurance details (provider/plan). Upload insurance cards or letters in the Files panel.",
    applies_to: ["medical_assistance", "medical_need", "individual_need", "family"],
    fields: [
      { name: "insurance_provider", label: "Insurance provider", format: "text", help: "Primary insurance provider name (e.g., BlueCross, Aetna, Medicaid managed-care plan)." },
      { name: "plan_name", label: "Plan name", format: "text", help: "Plan name (e.g., HMO/PPO plan name) if known." },
      { name: "plan_type", label: "Plan type", format: "enum", help: "Plan type (e.g., HMO, PPO, Medicaid, Medicare, Marketplace)." },
      { name: "member_id", label: "Member ID (optional)", format: "text", help: "Member/Subscriber ID if explicitly provided in documents; leave blank if unknown." },
      { name: "group_id", label: "Group ID (optional)", format: "text", help: "Group ID if explicitly provided in documents; leave blank if unknown." },
      { name: "policy_holder_name", label: "Policy holder name", format: "text", help: "Name of policy holder when relevant." },
      { name: "effective_date", label: "Effective date", format: "date", help: "Coverage effective date (YYYY-MM-DD) if known." },
      { name: "phone_for_claims", label: "Member services phone", format: "phone", help: "Member services or claims phone number if known." },
      { name: "notes", label: "Notes", format: "text", help: "High-level notes about coverage gaps, copays, prior auth needs, etc." },
    ],
  },

  medical_history: {
    title: "Medical History & Needs",
    description: "Capture medical context needed for assistance resources and support letters (keep concise).",
    applies_to: ["medical_assistance", "medical_need", "individual_need", "family"],
    fields: [
      { name: "primary_condition", label: "Primary condition", format: "boolean_tri", help: "Primary condition or diagnosis when explicitly stated." },
      { name: "secondary_conditions", label: "Secondary conditions", format: "text", help: "Other conditions or diagnoses explicitly stated." },
      { name: "mobility_needs", label: "Mobility needs", format: "text", help: "Mobility needs summary (e.g., wheelchair, walker, limited standing)." },
      { name: "dme_needed", label: "DME needed", format: "text", help: "Durable medical equipment needed (e.g., shower chair) when explicitly stated." },
      { name: "doctor_name", label: "Doctor / clinician", format: "text", help: "Primary clinician or doctor name if known." },
      { name: "clinic_name", label: "Clinic / hospital", format: "text", help: "Clinic or hospital name if known." },
      { name: "letter_support_needed", label: "Support letter needed", format: "text", help: "True if a letter of medical necessity or support letter is needed." },
      { name: "notes", label: "Notes", format: "text", help: "Concise medical history context (up to ~5 sentences)." },
    ],
  },

  nonprofit_compliance: {
    title: "Nonprofit Compliance",
    description: "Track core compliance readiness signals used by many grants.",
    applies_to: ["nonprofit", "organization"],
    fields: [
      { name: "is_501c3", label: "501(c)(3) status confirmed", format: "boolean_tri", help: "True if 501(c)(3) status is confirmed." },
      { name: "fiscal_sponsor", label: "Uses a fiscal sponsor", format: "text", help: "True if operating under a fiscal sponsor." },
      { name: "fiscal_sponsor_name", label: "Fiscal sponsor name", format: "text", help: "Fiscal sponsor name if applicable." },
      { name: "sam_registered", label: "SAM.gov registered", format: "text", help: "True if SAM.gov registration is confirmed." },
      { name: "insurance_coverage", label: "Insurance coverage", format: "text", help: "General insurance coverage (GL, D&O) if known." },
      { name: "compliance_notes", label: "Compliance notes", format: "text", help: "Notes about audits, policies, and compliance gaps." },
    ],
  },

  small_business_details: {
    title: "Small Business Details",
    description: "Track business details needed for small business programs and certifications.",
    applies_to: ["small_business"],
    fields: [
      { name: "business_name", label: "Business name", format: "text", help: "Legal business name if different from profile name." },
      { name: "naics_code", label: "NAICS code", format: "text", help: "NAICS code if known." },
      { name: "years_in_business", label: "Years in business", format: "text", help: "Years in business (integer) if known." },
      { name: "employee_count", label: "Employee count", format: "text", help: "Employee count if known." },
      { name: "annual_revenue", label: "Annual revenue (USD)", format: "currency_usd", help: "Annual revenue (USD) if known." },
      { name: "certifications", label: "Certifications", format: "text", help: "Certifications (e.g., WOSB, HUBZone, MBE) when explicitly stated." },
      { name: "notes", label: "Notes", format: "text", help: "Notes about products/services, capacity, and priorities." },
    ],
  },

  demographics: {
    title: "Demographics",
    description:
      "Document demographic information that influences funding eligibility and reporting requirements.",
    fields: [
      { name: "african_american", label: "African American / Black", format: "text", help: "True if Black/African American identity stated." },
      { name: "hispanic_latino", label: "Hispanic / Latino", format: "text", help: "True if Hispanic/Latino identity stated." },
      { name: "asian_american", label: "Asian American / Pacific Islander", format: "text", help: "True if Asian/AAPI identity stated." },
      { name: "native_american", label: "Native American / Alaska Native", format: "text", help: "True if Native American/Indigenous identity stated." },
      { name: "tribal_affiliation", label: "Tribal affiliation", format: "text", help: "Tribal affiliation if specified." },
      { name: "lgbtq", label: "Identifies as LGBTQ+", format: "text", help: "True if LGBTQ+ identity stated." },
      { name: "immigrant_status", label: "Immigration status", format: "enum", help: "One of: us_citizen, permanent_resident, refugee, undocumented, other, unknown." },
      { name: "ethnicity", label: "Ethnicity (free text)", format: "text", help: "Ethnicity (freeform)." },
      { name: "heritage", label: "Heritage / ancestry", format: "text", help: "Heritage or ancestry (freeform)." },
      { name: "languages", label: "Languages (list)", format: "text", help: "Languages spoken (comma-separated)." },
      { name: "religious_affiliation", label: "Religious affiliation", format: "text", help: "Religious affiliation if relevant." },
      { name: "citizenship", label: "Citizenship", format: "enum", help: "Citizenship status or country." },
      { name: "us_citizen", label: "US citizen", format: "text", help: "True if US citizen." },
      { name: "disability_status", label: "Disability status (high level)", format: "text", help: "High-level disability status descriptor." },
      { name: "veteran_status", label: "Veteran status (high level)", format: "text", help: "High-level veteran status descriptor." },
      { name: "age_group", label: "Age group", format: "text", help: "Age group (e.g., youth, young adult, senior)." },
      { name: "white_caucasian", label: "White / Caucasian", format: "text", help: "True if White/Caucasian identity stated." },
      { name: "notes", label: "Demographic notes", format: "text", help: "Additional demographic context or identities." },
      { name: "good_credit_score", label: "Good Credit Score (700+)", format: "text", help: "Qualifies for financial literacy programs and non-loan support." },
      { name: "religious_denomination", label: "Religious Denomination", format: "text", help: "e.g., Baptist, Methodist, Catholic, Lutheran — denominational scholarships available." },
      { name: "jewish_heritage", label: "Jewish Heritage", format: "text", help: "Extensive funding from Jewish federations, Hillel, and synagogues." },
      { name: "irish_heritage", label: "Irish Heritage", format: "text", help: "Hibernian societies, Irish cultural organizations." },
      { name: "italian_heritage", label: "Italian Heritage", format: "text", help: "True if Italian heritage." },
      { name: "greek_heritage", label: "Greek Heritage", format: "text", help: "AHEPA, Hellenic societies." },
      { name: "armenian_heritage", label: "Armenian Heritage", format: "text", help: "True if Armenian heritage." },
      { name: "appalachian_heritage", label: "Appalachian Heritage", format: "text", help: "True if Appalachian heritage." },
    ],
  },

  family_life: {
    title: "Family & Life Situation",
    description:
      "Capture household and life events that may trigger eligibility for supportive programs.",
    fields: [
      { name: "single_parent", label: "Single parent household", format: "boolean_tri", help: "True if single parent." },
      { name: "foster_youth", label: "Current/former foster youth", format: "boolean_tri", help: "True if current or former foster youth." },
      { name: "orphan", label: "Orphan", format: "boolean_tri", help: "True if orphan." },
      { name: "adopted", label: "Adopted", format: "boolean_tri", help: "True if adopted." },
      { name: "foster_parent", label: "Foster parent", format: "boolean_tri", help: "True if foster parent." },
      { name: "caregiver", label: "Primary caregiver (non-parent)", format: "boolean_tri", help: "True if caregiver for someone else." },
      { name: "widow_widower", label: "Widow / widower", format: "text", help: "True if widowed." },
      { name: "grandparent_raising_grandchildren", label: "Grandparent raising grandchildren", format: "text", help: "True if grandparent raising grandchildren." },
      { name: "first_time_parent", label: "First-time parent", format: "boolean_tri", help: "True if first-time parent." },
      { name: "homeless", label: "Experiencing homelessness", format: "boolean_tri", help: "True if homeless or housing insecure." },
      { name: "domestic_violence_survivor", label: "Domestic violence survivor", format: "boolean_tri", help: "True if domestic violence survivor." },
      { name: "trafficking_survivor", label: "Human trafficking survivor", format: "boolean_tri", help: "True if human trafficking survivor." },
      { name: "disaster_survivor", label: "Disaster survivor", format: "boolean_tri", help: "True if disaster survivor (fire/flood/storm/etc.)." },
      { name: "formerly_incarcerated", label: "Formerly incarcerated / returning citizen", format: "text", help: "True if formerly incarcerated." },
      { name: "notes", label: "Life circumstances notes", format: "text", help: "Brief life situation context (up to ~2 sentences)." },
    ],
  },

  military_service: {
    title: "Military Status",
    description:
      "Record any military service or affiliation to unlock veteran-focused resources.",
    fields: [
      { name: "veteran", label: "Veteran", format: "boolean_tri", help: "True if veteran." },
      { name: "active_duty_military", label: "Active duty military", format: "text", help: "True if active duty." },
      { name: "national_guard", label: "National Guard / Reserve", format: "text", help: "True if National Guard or Reserve." },
      { name: "disabled_veteran", label: "Disabled veteran", format: "text", help: "True if disabled veteran." },
      { name: "military_spouse", label: "Military spouse", format: "boolean_tri", help: "True if military spouse." },
      { name: "military_dependent", label: "Military dependent", format: "boolean_tri", help: "True if military dependent or child." },
      { name: "gold_star_family", label: "Gold Star family", format: "boolean_tri", help: "True if Gold Star family." },
      { name: "notes", label: "Service details", format: "text", help: "Branch, years of service, disability rating context when relevant." },
    ],
  },

  occupation: {
    title: "Occupation",
    description:
      "Track professional roles and designations relevant to workforce or training programs.",
    fields: [
      { name: "healthcare_worker", label: "Healthcare worker", format: "boolean_tri", help: "True if healthcare worker." },
      { name: "healthcare_worker_type", label: "Healthcare role", format: "text", help: "Healthcare role type (e.g., RN, CNA, EMT)." },
      { name: "ems_worker", label: "EMS/First responder", format: "boolean_tri", help: "True if EMS worker or first responder." },
      { name: "educator", label: "Educator / teacher", format: "boolean_tri", help: "True if educator or teacher." },
      { name: "firefighter", label: "Firefighter", format: "boolean_tri", help: "True if firefighter." },
      { name: "law_enforcement", label: "Law enforcement / corrections", format: "text", help: "True if law enforcement or corrections officer." },
      { name: "public_servant", label: "Public servant / government employee", format: "boolean_tri", help: "True if public servant or government worker." },
      { name: "clergy", label: "Clergy / religious worker", format: "boolean_tri", help: "True if clergy or religious worker." },
      { name: "missionary", label: "Missionary / evangelist", format: "boolean_tri", help: "True if missionary or evangelist." },
      { name: "nonprofit_employee", label: "Nonprofit employee", format: "boolean_tri", help: "True if nonprofit employee." },
      { name: "small_business_owner", label: "Small business owner", format: "boolean_tri", help: "True if small business owner." },
      { name: "minority_owned_business", label: "Minority-owned business", format: "text", help: "True if minority-owned business." },
      { name: "women_owned_business", label: "Women-owned business", format: "text", help: "True if women-owned business." },
      { name: "union_member", label: "Union member", format: "boolean_tri", help: "True if union member." },
      { name: "farmer", label: "Agricultural worker / farmer", format: "boolean_tri", help: "True if farmer or agricultural worker." },
      { name: "truck_driver", label: "Truck driver / transportation worker", format: "text", help: "True if truck driver or transportation worker." },
      { name: "notes", label: "Occupational notes", format: "text", help: "Additional occupations, certifications, or union local." },
    ],
  },

  location_focus: {
    title: "Location Focus",
    description:
      "Define where the applicant lives or delivers services to align with geographic funding criteria.",
    fields: [
      { name: "rural_resident", label: "Rural resident", format: "text", help: "True if rural resident or served area is rural." },
      { name: "appalachian_region", label: "Located in Appalachian region", format: "text", help: "True if located in or serving Appalachia." },
      { name: "urban_underserved", label: "Urban underserved community", format: "text", help: "True if located in or serving an underserved urban area." },
      { name: "geographic_focus", label: "Geographic focus", format: "text", help: "Primary geography served or targeted." },
      { name: "notes", label: "Location notes", format: "text", help: "County, census tract, or other location qualifiers." },
    ],
  },

  university_applications: {
    title: "University Applications",
    description: "Student college application tracking (for scholarship targeting).",
    fields: [
      { name: "applications", label: "Applications", format: "json", help: "Array of tracked college applications and their details." },
    ],
  },

  education: {
    title: "Education",
    description:
      "Academic history and student qualifiers (GPA, tests, service hours) for scholarship and education-focused matching.",
    applies_to: ["student", "college_student", "high_school_student", "graduate_student"],
    fields: [
      { name: "highest_level", label: "Highest level completed", format: "enum", help: "Highest education level attained (freeform string)." },
      { name: "current_institution", label: "Current institution", format: "text", help: "Current institution or school name." },
      { name: "target_colleges", label: "Target colleges (list)", format: "text", help: "Target colleges or universities (comma-separated)." },
      { name: "schools", label: "Schools", format: "json", help: "Structured list of schools attended or under consideration." },
      { name: "intended_major", label: "Intended major", format: "text", help: "Intended major or program." },
      { name: "gpa", label: "GPA", format: "text", help: "GPA when explicitly provided." },
      { name: "act_score", label: "ACT score", format: "text", help: "ACT score when explicitly provided." },
      { name: "sat_score", label: "SAT score", format: "text", help: "SAT score when explicitly provided." },
      { name: "community_service_hours", label: "Community service hours", format: "text", help: "Community service hours when known." },
      { name: "leadership_roles", label: "Leadership roles (list)", format: "text", help: "Leadership roles (comma-separated)." },
      { name: "valedictorian", label: "Valedictorian", format: "boolean_tri", help: "True if valedictorian (explicitly stated)." },
      { name: "notes", label: "Education notes", format: "text", help: "Additional education context." },
      { name: "pell_grant_eligible", label: "Pell Grant Eligible", format: "boolean_tri", help: "Federal grant for low-income students." },
      { name: "fafsa_completed", label: "FAFSA Completed", format: "boolean_tri", help: "Required for most federal financial aid." },
      { name: "first_generation_college_student", label: "First-Generation College Student", format: "text", help: "First in your family to attend college." },
      { name: "dual_enrollment", label: "Dual Enrollment / Early College", format: "text", help: "True if enrolled in dual enrollment or early college program." },
      { name: "rotc_jrotc", label: "ROTC / JROTC Participation", format: "text", help: "Military training — ROTC scholarships available." },
      { name: "cte_pathway", label: "CTE Pathway", format: "text", help: "Career/Technical Education (EMT, welding, cybersecurity, nursing, etc.)." },
      { name: "honor_societies", label: "Honor Societies", format: "text", help: "NHS, Phi Theta Kappa, etc." },
      { name: "efc_sai_band", label: "EFC/SAI Band", format: "text", help: "Expected Family Contribution / Student Aid Index." },
    ],
  },

  employment: {
    title: "Employment",
    description:
      "Employment status and experience used for workforce training and career-change programs.",
    fields: [
      { name: "current_status", label: "Current status", format: "enum", options: ["student", "not_in_labor_force", "unemployed_seeking", "employed_full_time", "employed_part_time", "self_employed", "retired"], help: "Current employment status." },
      { name: "career_goal", label: "Career goal", format: "text", help: "Career goal (freeform)." },
      { name: "experience", label: "Experience", format: "text", help: "Brief experience summary (freeform)." },
      { name: "notes", label: "Employment notes", format: "text", help: "Additional employment context." },
    ],
  },

  housing: {
    title: "Housing",
    description:
      "Housing stability and geographic designations relevant to assistance programs.",
    fields: [
      { name: "status", label: "Housing status", format: "enum", help: "Housing status (e.g., stable, at-risk, homeless, unknown)." },
      { name: "type", label: "Housing type", format: "enum", help: "Housing type (rent, own, shelter, transitional, etc.)." },
      { name: "address", label: "Housing address (if different)", format: "json", help: "Housing address when explicitly provided." },
      { name: "broadband_speed", label: "Broadband speed", format: "text", help: "Broadband speed or connectivity details if relevant." },
      { name: "geographic_designation", label: "Geographic designation (list)", format: "text", help: "Geographic designations (e.g., rural, urban, frontier)." },
      { name: "notes", label: "Housing notes", format: "text", help: "Additional housing context." },
    ],
  },

  family: {
    title: "Household Details",
    description:
      "Household structure and support system details (separate from eligibility flags).",
    fields: [
      { name: "household_size", label: "Household size", format: "text", help: "Household size when known." },
      { name: "responsibilities", label: "Responsibilities", format: "text", help: "Primary household responsibilities or caregiving context." },
      { name: "support_system", label: "Support system", format: "text", help: "Support system description." },
      { name: "notes", label: "Household notes", format: "text", help: "Additional household context." },
    ],
  },

  programs_services: {
    title: "Programs & Services",
    description:
      "Focus areas, services, and keywords used to match funding opportunities (high-signal for crawlers).",
    fields: [
      { name: "focus_areas", label: "Focus areas (list)", format: "text", help: "Focus areas (comma-separated)." },
      { name: "interests", label: "Interests (list)", format: "text", help: "Interests (comma-separated)." },
      { name: "keywords", label: "Keywords (list)", format: "text", help: "Keywords or tags (comma-separated)." },
      { name: "notes", label: "Programs/services notes", format: "text", help: "Additional program or service notes." },
    ],
  },

  narrative: {
    title: "Story & Goals",
    description:
      "Summarize the applicant's mission, goals, and unique narrative to feed proposals and AI tooling.",
    fields: [
      { name: "mission", label: "Mission", format: "text", help: "Mission statement or personal mission." },
      { name: "primary_goal", label: "Primary goal", format: "text", help: "Primary goal of the applicant or project." },
      { name: "target_population", label: "Target population", format: "text", help: "Who benefits from the work (population served)." },
      { name: "funding_amount_needed", label: "Funding amount needed", format: "currency_usd", help: "Requested or needed funding amount (numeric or descriptive)." },
      { name: "timeline", label: "Timeline", format: "text", help: "Timeline for the project or need." },
      { name: "past_experience", label: "Past experience", format: "text", help: "Relevant past experience or track record." },
      { name: "unique_qualities", label: "Unique qualities", format: "text", help: "What makes the applicant or project unique." },
      { name: "collaboration_partners", label: "Collaboration partners", format: "text", help: "Partner organizations or individuals." },
      { name: "sustainability_plan", label: "Sustainability plan", format: "text", help: "Plan for sustaining the work beyond this grant." },
      { name: "barriers_faced", label: "Barriers faced", format: "text", help: "Obstacles the applicant is navigating." },
      { name: "special_circumstances", label: "Special circumstances", format: "text", help: "Any special circumstances that should inform the application." },
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
