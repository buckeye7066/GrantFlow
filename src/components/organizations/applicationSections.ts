export type FieldType = "text" | "textarea" | "date" | "number" | "boolean" | "single-select" | "multi-select"

export type FieldOption = {
  value: string
  label: string
}

export interface ApplicationField {
  id: string
  label: string
  type: FieldType
  description?: string
  placeholder?: string
  options?: FieldOption[]
  width?: "full" | "half"
}

export interface ApplicationSection {
  id: string
  title: string
  description?: string
  layout?: "grid" | "stack"
  fields: ApplicationField[]
}

const PRIMARY_PROFILE_OPTIONS: FieldOption[] = [
  { value: "organization", label: "Organization (Nonprofit, Business, School)" },
  { value: "high_school_student", label: "High School Student" },
  { value: "college_student", label: "College Student" },
  { value: "graduate_student", label: "Graduate Student" },
  { value: "homeschool_family", label: "Homeschool Family" },
  { value: "individual_seeking_assistance", label: "Individual Seeking Assistance" },
  { value: "medical_healthcare_assistance", label: "Medical/Healthcare Assistance" },
  { value: "family_household", label: "Family/Household" },
  { value: "other", label: "Other" },
]

const FEDERAL_REGISTRATION_OPTIONS: FieldOption[] = [
  { value: "sam_registered", label: "SAM.gov Registered" },
  { value: "grants_gov_account", label: "Grants.gov Account Active" },
  { value: "era_commons_account", label: "eRA Commons Account (NIH/health research)" },
  { value: "state_vendor_registration", label: "State Vendor Registration" },
  { value: "charitable_solicitation_registration", label: "Charitable Solicitation Registration" },
  { value: "sam_exclusions_passed", label: "SAM Exclusions Check Passed" },
]

const GENERAL_QUALIFICATION_OPTIONS: FieldOption[] = [
  { value: "faith_based", label: "Faith-Based Organization / Church / Ministry" },
  { value: "serves_rural_area", label: "Serves Rural Area" },
  { value: "minority_serving", label: "Minority-Serving Organization" },
  { value: "public_charity", label: "501(c)(3) Public Charity" },
  { value: "private_foundation", label: "501(c)(3) Private Foundation" },
]

const DATA_PROTECTION_OPTIONS: FieldOption[] = [
  { value: "hipaa_compliant", label: "HIPAA Compliant" },
  { value: "ferpa_compliant", label: "FERPA Compliant" },
  { value: "cfr_part2_compliant", label: "42 CFR Part 2 Compliant" },
]

const PARTNERSHIP_OPTIONS: FieldOption[] = [
  { value: "schools", label: "Schools / School Districts" },
  { value: "hospitals", label: "Hospitals / Health Systems" },
  { value: "universities", label: "Universities / Colleges" },
  { value: "tribal_governments", label: "Tribal Governments" },
  { value: "other_partnerships", label: "Other Partnerships" },
]

const INSURANCE_OPTIONS: FieldOption[] = [
  { value: "workers_comp", label: "Workers’ Compensation Insurance" },
  { value: "cyber_insurance", label: "Cyber Insurance" },
]

const SPECIALIZED_ORG_OPTIONS: FieldOption[] = [
  { value: "school_district_charter", label: "School District / Charter School" },
  { value: "title_i_school", label: "Title I School/District" },
  { value: "csi_tsi_designation", label: "Comprehensive Support & Improvement (CSI/TSI)" },
  { value: "cte_pathways", label: "CTE (Career & Technical Education) Pathways Offered" },
  { value: "perkins_v_ready", label: "Perkins V Ready" },
  { value: "school_safety_team", label: "School Safety Team & SRO MOU" },
  { value: "university_college", label: "University / College" },
  { value: "hospital_clinic", label: "Hospital / Clinic / FQHC" },
  { value: "tribal_government", label: "Tribal Government / Tribally Controlled Organization" },
  { value: "community_action_agency", label: "Community Action Agency (CAA)" },
  { value: "community_development_corp", label: "Community Development Corporation (CDC)" },
  { value: "housing_authority", label: "Housing Authority" },
  { value: "workforce_development_board", label: "Workforce Development Board" },
  { value: "veterans_service_org", label: "Veterans Service Organization" },
  { value: "volunteer_fire_ems", label: "Volunteer Fire/EMS" },
  { value: "research_institute", label: "Research Institute / Lab" },
  { value: "cooperative", label: "Cooperative (Ag/Electric/Housing/Worker)" },
]

const HOUSEHOLD_STATUS_OPTIONS: FieldOption[] = [
  { value: "single_parent_household", label: "Single Parent Household" },
  { value: "guardian_caregiver", label: "Guardian / Caregiver" },
  { value: "foster_parent", label: "Foster Parent" },
  { value: "kinship_caregiver", label: "Kinship Caregiver / Relative Care" },
  { value: "grandparent_caregiver", label: "Grandparent Raising Grandchildren" },
  { value: "first_time_parent", label: "First-Time Parent" },
  { value: "homeless_insecure", label: "Homeless / Housing Insecure" },
  { value: "domestic_violence_survivor", label: "Domestic Violence Survivor" },
  { value: "human_trafficking_survivor", label: "Human Trafficking Survivor" },
  { value: "disaster_survivor", label: "Disaster Survivor" },
  { value: "returning_citizen", label: "Formerly Incarcerated / Returning Citizen" },
  { value: "minor_child", label: "Minor Child (Under 18)" },
  { value: "young_adult", label: "Young Adult (18-24)" },
]

const VULNERABLE_POPULATION_OPTIONS: FieldOption[] = [
  { value: "veteran", label: "Veteran" },
  { value: "active_duty", label: "Active Duty Military" },
  { value: "guard_reserve", label: "National Guard / Reserve" },
  { value: "disabled_veteran", label: "Disabled Veteran" },
  { value: "military_spouse", label: "Military Spouse" },
  { value: "military_dependent", label: "Military Dependent" },
  { value: "gold_star_family", label: "Gold Star Family Member" },
  { value: "gi_bill_recipient", label: "Post-9/11 GI Bill Recipient" },
  { value: "vre_participant", label: "VR&E Participant" },
  { value: "champva_recipient", label: "CHAMPVA Recipient" },
]

const OCCUPATION_OPTIONS: FieldOption[] = [
  { value: "healthcare_worker", label: "Healthcare Worker" },
  { value: "teacher_educator", label: "Teacher / Educator" },
  { value: "firefighter", label: "Firefighter" },
  { value: "law_enforcement", label: "Law Enforcement Officer" },
  { value: "public_servant", label: "Public Servant / Government Employee" },
  { value: "clergy_minister", label: "Clergy / Minister / Religious Worker" },
  { value: "missionary", label: "Missionary / Evangelist" },
  { value: "nonprofit_employee", label: "Nonprofit Employee" },
  { value: "small_business_owner", label: "Small Business Owner" },
  { value: "union_member", label: "Union Member" },
  { value: "farmer_ag_worker", label: "Farmer / Agricultural Worker" },
  { value: "transportation_worker", label: "Truck Driver / Transportation Worker" },
  { value: "trades_worker", label: "Construction / Trades Worker" },
  { value: "researcher_scientist", label: "Researcher / Scientist" },
  { value: "environmental_worker", label: "Environmental / Conservation Worker" },
  { value: "energy_sector_worker", label: "Energy Sector Worker" },
  { value: "artist_cultural_worker", label: "Artist / Musician / Cultural Worker" },
]

const FIREARMS_OPTIONS: FieldOption[] = [
  { value: "gun_owner", label: "Gun Owner / Firearm Owner" },
  { value: "concealed_carry_permit", label: "Has Concealed Carry Permit" },
  { value: "nra_member", label: "NRA Member" },
  { value: "nra_certified_instructor", label: "NRA Certified Instructor" },
  { value: "firearms_safety_instructor", label: "Firearms Safety Instructor" },
  { value: "second_amendment_advocate", label: "Second Amendment Rights Advocate" },
  { value: "firearms_industry_worker", label: "Works in Firearms Industry" },
  { value: "competitive_shooter", label: "Competitive Shooter" },
  { value: "hunter", label: "Hunter" },
]

const POLITICAL_ENGAGEMENT_OPTIONS: FieldOption[] = [
  { value: "voter", label: "Voter" },
  { value: "volunteer", label: "Volunteer" },
  { value: "activist", label: "Activist" },
  { value: "candidate", label: "Candidate" },
  { value: "elected_official", label: "Elected Official" },
]

export const APPLICATION_SECTIONS: ApplicationSection[] = [
  {
    id: "primary_profile",
    title: "1. Primary Profile Type",
    description: "Select the primary profile type and specify additional context.",
    fields: [
      {
        id: "primary_profile_type",
        label: "Primary Profile Type",
        type: "single-select",
        options: PRIMARY_PROFILE_OPTIONS,
      },
      {
        id: "primary_profile_type_other_detail",
        label: "If other, please describe",
        type: "text",
      },
    ],
  },
  {
    id: "basic_information",
    title: "2. Basic Information",
    layout: "grid",
    fields: [
      { id: "app_full_name", label: "Full Name / Organization Name", type: "text" },
      { id: "app_date_of_birth", label: "Date of Birth (Individuals)", type: "date" },
      { id: "app_age", label: "Age", type: "number" },
      { id: "app_social_security_number", label: "Social Security Number", type: "text" },
      { id: "app_green_card_number", label: "Green Card Number", type: "text" },
      { id: "app_email_addresses", label: "Email Address(es)", type: "textarea", placeholder: "Primary, secondary..." },
      { id: "app_phone_numbers", label: "Phone Number(s)", type: "textarea", placeholder: "Mobile, home, work..." },
      { id: "app_website", label: "Website", type: "text" },
    ],
  },
  {
    id: "address_information",
    title: "3. Address",
    layout: "grid",
    fields: [
      { id: "app_address_street", label: "Street Address", type: "text", width: "full" },
      { id: "app_address_city", label: "City", type: "text" },
      { id: "app_address_state", label: "State / Province", type: "text" },
      { id: "app_address_zip", label: "ZIP / Postal Code", type: "text" },
    ],
  },
  {
    id: "organization_details",
    title: "4. Organization Details",
    layout: "grid",
    fields: [
      { id: "app_org_ein", label: "EIN (Tax ID)", type: "text" },
      { id: "app_org_uei", label: "UEI", type: "text" },
      { id: "app_org_cage_code", label: "CAGE Code", type: "text" },
      { id: "app_org_type", label: "Organization Type", type: "text" },
      { id: "app_org_annual_budget", label: "Annual Budget (USD)", type: "number" },
      { id: "app_org_staff_count", label: "Staff Count", type: "number" },
      { id: "app_org_volunteer_count", label: "Volunteer Count", type: "number" },
      { id: "app_org_single_audit_year", label: "Single Audit (Most Recent Year)", type: "text" },
      { id: "app_org_nicra_rate", label: "NICRA Rate (%)", type: "number" },
      { id: "app_org_ntee_code", label: "NTEE Code", type: "text" },
      {
        id: "app_org_evidence_based_model",
        label: "Evidence-Based Program Model",
        type: "text",
        placeholder: "e.g., Home Visiting—NFP",
      },
    ],
  },
  {
    id: "federal_registration",
    title: "Federal Registration & Compliance",
    description: "Select all registrations and compliance items that apply.",
    fields: [
      {
        id: "app_federal_registrations",
        label: "Registrations",
        type: "multi-select",
        options: FEDERAL_REGISTRATION_OPTIONS,
      },
      { id: "app_charitable_registration_states", label: "States Registered for Solicitation", type: "textarea" },
    ],
  },
  {
    id: "financial_and_audit",
    title: "Financial & Audit Status",
    fields: [
      { id: "app_audited_financials_available", label: "Audited Financials Available", type: "boolean" },
      { id: "app_has_single_audit", label: "Subject to Single Audit (2 CFR 200)", type: "boolean" },
      { id: "app_has_nicra", label: "NICRA (Federally Negotiated Indirect Cost Rate)", type: "boolean" },
    ],
  },
  {
    id: "general_qualifications",
    title: "General Qualifications",
    description: "Select all that apply to your organization.",
    fields: [
      {
        id: "app_general_qualifications",
        label: "Qualifications",
        type: "multi-select",
        options: GENERAL_QUALIFICATION_OPTIONS,
      },
    ],
  },
  {
    id: "data_protections",
    title: "Data Protections",
    fields: [
      {
        id: "app_data_protections",
        label: "Compliance",
        type: "multi-select",
        options: DATA_PROTECTION_OPTIONS,
      },
    ],
  },
  {
    id: "partnerships",
    title: "Partnerships & MOUs",
    description: "Select partner categories where you have MOUs/LOIs.",
    fields: [
      {
        id: "app_partnerships",
        label: "Existing Partnerships",
        type: "multi-select",
        options: PARTNERSHIP_OPTIONS,
      },
      { id: "app_partnerships_other_detail", label: "Other Partnerships (detail)", type: "text" },
    ],
  },
  {
    id: "insurance_risk",
    title: "Insurance & Risk Management",
    layout: "grid",
    fields: [
      {
        id: "app_general_liability_limits",
        label: "General Liability Coverage Limits (USD)",
        type: "number",
      },
      {
        id: "app_insurance_coverages",
        label: "Additional Coverage",
        type: "multi-select",
        options: INSURANCE_OPTIONS,
      },
    ],
  },
  {
    id: "specialized_organization_types",
    title: "Specialized Organization Types",
    description: "Check all specialized classifications that apply.",
    fields: [
      {
        id: "app_specialized_organization_types",
        label: "Specialized Types",
        type: "multi-select",
        options: SPECIALIZED_ORG_OPTIONS,
      },
      { id: "app_free_reduced_lunch_percent", label: "Free/Reduced Lunch %", type: "number" },
      { id: "app_csi_tsi_designation_notes", label: "CSI/TSI Designation Notes", type: "textarea" },
      { id: "app_hpsa_score", label: "HPSA Score", type: "number" },
      { id: "app_hospital_ehr_vendor", label: "EHR Vendor (Hospital/Clinic)", type: "text" },
      { id: "app_tribal_resolution_process", label: "Tribal Resolution Process", type: "textarea" },
      { id: "app_wioa_metrics", label: "WIOA Performance Metrics", type: "textarea" },
      { id: "app_iso_rating", label: "ISO Rating (Fire/EMS)", type: "text" },
      { id: "app_research_prior_grants", label: "Prior Research Grant Numbers", type: "textarea" },
      { id: "app_cooperative_member_count", label: "Cooperative Member Count", type: "number" },
      { id: "app_service_territory", label: "Service Territory", type: "textarea" },
    ],
  },
  {
    id: "household_status",
    title: "Household & Caregiver Status",
    description: "Select all that describe the household or caregiver situation.",
    fields: [
      {
        id: "app_household_status",
        label: "Household Status",
        type: "multi-select",
        options: HOUSEHOLD_STATUS_OPTIONS,
      },
      { id: "app_caregiver_additional_notes", label: "Additional Household Notes", type: "textarea" },
    ],
  },
  {
    id: "veteran_and_military_service",
    title: "11. Military Service",
    description: "Select all that apply and provide details where requested.",
    fields: [
      {
        id: "app_military_service_status",
        label: "Military Service Status",
        type: "multi-select",
        options: VULNERABLE_POPULATION_OPTIONS,
      },
      { id: "app_military_branch_mos", label: "Branch & MOS", type: "text" },
      { id: "app_military_campaign_medals", label: "Campaign Medals", type: "text" },
      { id: "app_military_character_of_discharge", label: "Character of Discharge", type: "text" },
      { id: "app_military_recent_activation", label: "Recent Activation Date", type: "date" },
      { id: "app_va_disability_rating", label: "VA Disability Rating (%)", type: "number" },
      { id: "app_vso_representation", label: "VSO Representation (detail)", type: "text" },
      { id: "app_vr_e_status", label: "VR&E Participation Notes", type: "textarea" },
    ],
  },
  {
    id: "occupation_work",
    title: "12. Occupation & Work",
    description: "Select all occupational categories that apply.",
    fields: [
      {
        id: "app_occupation_categories",
        label: "Occupational Categories",
        type: "multi-select",
        options: OCCUPATION_OPTIONS,
      },
      { id: "app_union_local_number", label: "Union Local & Apprenticeship Registration #", type: "text" },
      { id: "app_shift_work", label: "Shift Work / Overtime Exposure", type: "boolean" },
      { id: "app_high_hazard_industry", label: "High-Hazard Industry", type: "boolean" },
      { id: "app_farm_acreage", label: "Farm Acreage (acres)", type: "number" },
      { id: "app_usda_programs", label: "USDA Programs", type: "textarea" },
    ],
  },
  {
    id: "firearms_second_amendment",
    title: "13. Firearms / Second Amendment",
    description: "Select all that apply.",
    fields: [
      {
        id: "app_firearms_affiliations",
        label: "Firearms & Shooting Sports",
        type: "multi-select",
        options: FIREARMS_OPTIONS,
      },
      { id: "app_hunter_states", label: "Hunter State Licenses", type: "textarea" },
    ],
  },
  {
    id: "political_civic_engagement",
    title: "14. Political / Civic Engagement",
    fields: [
      {
        id: "app_political_engagement_level",
        label: "Level of Engagement",
        type: "multi-select",
        options: POLITICAL_ENGAGEMENT_OPTIONS,
      },
      { id: "app_political_party_affiliation", label: "Political Party Affiliation", type: "text" },
      { id: "app_political_roles", label: "Political Roles / Offices Held", type: "textarea" },
      { id: "app_policy_expertise", label: "Policy Expertise Areas", type: "textarea" },
      { id: "app_supporting_organizations", label: "Organizations Providing Support", type: "textarea" },
    ],
  },
  {
    id: "story_and_goals",
    title: "15. Your Story & Goals",
    fields: [
      { id: "app_goals", label: "Goals", type: "textarea" },
      { id: "app_unique_story", label: "What makes you unique? Tell your story.", type: "textarea" },
      { id: "app_funding_needs", label: "Funding needs & intended use", type: "textarea" },
      { id: "app_challenges", label: "Challenges or barriers faced", type: "textarea" },
      { id: "app_support_network", label: "Support network (family, mentors, organizations)", type: "textarea" },
    ],
  },
  {
    id: "additional_information",
    title: "16. Additional Information",
    fields: [
      { id: "app_extracurriculars", label: "Extracurricular Activities / Interests", type: "textarea" },
      { id: "app_awards_achievements", label: "Awards & Achievements", type: "textarea" },
      { id: "app_keywords", label: "Keywords (topics relevant to your needs/interests)", type: "textarea" },
      { id: "app_signature", label: "Signature", type: "text" },
      { id: "app_signature_date", label: "Date", type: "date" },
    ],
  },
]


