/**
 * Canonical section metadata - single source of truth for profile section and field meaning.
 *
 * Labels use sentence case. Every persisted profile section key must be declared
 * here with a label, format, and help text before it can be rendered or saved.
 */
import {
  ORGANIZATION_DETAILS_TYPES,
  NONPROFIT_COMPLIANCE_TYPES,
  SMALL_BUSINESS_DETAILS_TYPES,
  STUDENT_TYPES,
  MEDICAL_PROFILE_TYPES,
  ALL_PERSON_TYPES,
  ALL_ORG_TYPES,
} from '../../shared/profileSectionApplicability.js'

export const SECTION_METADATA = {
  "basic_information": {
    "title": "Basic Information",
    "description": "Primary contact details for this profile. This maps to Section 2 of the comprehensive application.",
    "fields": [
      {
        "name": "full_name",
        "label": "Full name / organization name",
        "format": "text",
        "help": "Applicant or primary contact's full legal name."
      },
      {
        "name": "first_name",
        "label": "First name",
        "format": "text",
        "help": "Applicant's legal first/given name. Auto-derived from the full name when left blank."
      },
      {
        "name": "middle_name",
        "label": "Middle name",
        "format": "text",
        "help": "Applicant's middle name(s), if any. Auto-derived from the full name when left blank."
      },
      {
        "name": "last_name",
        "label": "Last name",
        "format": "text",
        "help": "Applicant's legal last/family name. Auto-derived from the full name when left blank."
      },
      {
        "name": "email",
        "label": "Email address",
        "format": "email",
        "help": "Primary email address for the applicant or primary contact."
      },
      {
        "name": "phone",
        "label": "Phone number",
        "format": "phone",
        "help": "Primary phone number for the applicant or primary contact."
      },
      {
        "name": "website",
        "label": "Website",
        "format": "url",
        "help": "Website or online profile URL (org site, portfolio, etc.)."
      },
      {
        "name": "address",
        "label": "Address",
        "format": "json",
        "help": "Primary mailing address (street, city, state, ZIP)."
      },
      {
        "name": "secondary_address",
        "label": "Secondary address",
        "format": "json",
        "help": "Optional second address (e.g. home vs. school/campus, deployed/duty station, second residence). Shape: { line1, city, state, zip, type }. Its state/ZIP are included in geo matching and local crawls alongside the primary address."
      },
      {
        "name": "academic_status",
        "label": "Academic status",
        "format": "json",
        "applies_to": STUDENT_TYPES,
        "help": "Structured academic details extracted from profile intake."
      },
      {
        "name": "demographics",
        "label": "Demographics",
        "format": "json",
        "applies_to": ALL_PERSON_TYPES,
        "help": "Structured demographic details extracted from profile intake."
      },
      {
        "name": "city",
        "label": "City",
        "format": "text",
        "help": "City of residence or primary organizational location."
      },
      {
        "name": "state",
        "label": "State",
        "format": "text",
        "help": "2-letter US state abbreviation (e.g., TN, CA) for eligibility filtering."
      },
      {
        "name": "zip_code",
        "label": "ZIP code",
        "format": "text",
        "help": "5-digit ZIP code for local/county/state eligibility and matching."
      },
      {
        "name": "county",
        "label": "County",
        "format": "text",
        "help": "County of residence or operations."
      },
      {
        "name": "date_of_birth",
        "label": "Date of birth",
        "format": "date",
        "help": "Date of birth (YYYY-MM-DD) for age-based eligibility programs."
      },
      {
        "name": "age",
        "label": "Age",
        "format": "text",
        "help": "Age in years when captured directly (intake/quick-fill). date_of_birth is preferred for age-based eligibility; this is accepted so directly-entered age is never silently dropped."
      },
      {
        "name": "gender",
        "label": "Gender",
        "format": "text",
        "help": "Gender identity when explicitly provided; used for women/men-focused programs."
      },
      {
        "name": "nationality",
        "label": "Nationality",
        "format": "text",
        "help": "Nationality or country of origin."
      },
      {
        "name": "notes",
        "label": "Notes",
        "format": "prose",
        "scored": false,
        "help": "Freeform notes relevant to intake, context, and matching."
      },
      {
        "name": "contacts",
        "label": "Profile contacts",
        "format": "json",
        "help": "Additional contacts who have access to this profile."
      },
      {
        "name": "profile_type",
        "label": "Profile type",
        "format": "enum",
        "options": [
          "individual",
          "family",
          "student",
          "high_school_student",
          "college_student",
          "graduate_student",
          "teacher",
          "classroom_teacher",
          "school_district",
          "public_school",
          "library",
          "nonprofit",
          "church",
          "ministry",
          "food_pantry",
          "homeless_shelter",
          "animal_rescue",
          "volunteer_fire_department",
          "county_government",
          "municipality",
          "public_agency",
          "tribal_government",
          "public_health_department",
          "business",
          "medium_corporation",
          "large_corporation",
          "minority_owned_business",
          "women_owned_business",
          "senior",
          "veteran",
          "disabled_adult",
          "pta_pto",
          "school_food_service",
          "school_transportation",
          "special_education_program",
          "museum",
          "parks_department",
          "community_center",
          "reentry_program",
          "substance_recovery_org",
          "mental_health_nonprofit",
          "local_housing_authority",
          "regional_planning_agency",
          "economic_development_agency",
          "medical_need",
          "homeschool_family",
          "organization",
          "small_business",
          "government",
          "medical_assistance",
          "individual_need",
          "other"
        ],
        "help": "Profile type used to drive profile-specific matching, section applicability, crawler planning, and eligibility context. Canonical ids match shared/profileTypeOptions.js; legacy values (organization, small_business, individual_need, medical_assistance, government) are preserved for backwards compatibility."
      },
      {
        "name": "current_school",
        "label": "Current school",
        "format": "text",
        "help": "Quick-intake school name when captured before the education section is completed; education.current_institution remains the canonical education field."
      },
      {
        "name": "location",
        "label": "Location",
        "format": "json",
        "deprecated": true,
        "help": "Legacy or quick-intake location value. Prefer city, state, ZIP, county, address, and Location focus > Geographic focus when structured data is available. Deprecated: hidden from intake/edit; any stored value is preserved on save."
      },
      {
        "name": "keywords",
        "label": "Keywords (intake)",
        "format": "string_array",
        "deprecated": true,
        "help": "Keyword tags lifted from quick intake or onboarding text. Canonical keywords live in programs_services.keywords; this legacy/intake mirror is deprecated (hidden from intake/edit; stored value preserved on save)."
      },
      {
        "name": "interests",
        "label": "Interests (intake)",
        "format": "string_array",
        "deprecated": true,
        "help": "Interest tags lifted from quick intake or onboarding text. Canonical interests live in programs_services.interests; this legacy/intake mirror is deprecated (hidden from intake/edit; stored value preserved on save)."
      },
      {
        "name": "tags",
        "label": "Tags",
        "format": "string_array",
        "help": "Free-form tags applied to this profile during intake."
      }
    ]
  },
  "organization_details": {
    "title": "Organization Details",
    "description": "Entity registration, capacity indicators, and mission summary for Section 4 of the comprehensive application.",
    "applies_to": ORGANIZATION_DETAILS_TYPES,
    "fields": [
      {
        "name": "organization_type",
        "label": "Organization type",
        "format": "text",
        "help": "Type of applicant organization (e.g., nonprofit, church, school, small business)."
      },
      {
        "name": "ein",
        "label": "EIN (Tax ID)",
        "format": "text",
        "help": "Employer Identification Number (EIN) if applicable."
      },
      {
        "name": "uei",
        "label": "UEI",
        "format": "text",
        "help": "Unique Entity Identifier (UEI) for SAM.gov / federal grants."
      },
      {
        "name": "cage_code",
        "label": "CAGE code",
        "format": "text",
        "help": "CAGE code (federal contractor identifier) if applicable."
      },
      {
        "name": "annual_budget",
        "label": "Annual budget",
        "format": "currency_usd",
        "help": "Annual operating budget (USD) if known."
      },
      {
        "name": "staff_count",
        "label": "Staff count",
        "format": "text",
        "help": "Number of staff (FTE or headcount) if known."
      },
      {
        "name": "mission",
        "label": "Mission",
        "format": "text",
        "help": "Organization mission statement or concise purpose."
      },
      {
        "name": "sam_gov_registered",
        "label": "SAM.gov registered",
        "format": "text",
        "help": "Required for all federal grants."
      },
      {
        "name": "grants_gov_account",
        "label": "Grants.gov account active",
        "format": "text",
        "help": "Increases eligibility for federal opportunities."
      },
      {
        "name": "era_commons_account",
        "label": "eRA Commons account (NIH/health research)",
        "format": "text",
        "help": "NIH eRA Commons account for health research grants."
      },
      {
        "name": "sam_exclusions_passed",
        "label": "SAM exclusions check passed",
        "format": "text",
        "help": "Not debarred from federal contracts."
      },
      {
        "name": "audited_financials",
        "label": "Audited financials available",
        "format": "text",
        "help": "Audited financial statements available."
      },
      {
        "name": "nicra_rate",
        "label": "NICRA indirect cost rate (%)",
        "format": "percent",
        "help": "Federally Negotiated Indirect Cost Rate."
      },
      {
        "name": "ntee_code",
        "label": "NTEE code",
        "format": "text",
        "help": "National Taxonomy of Exempt Entities (e.g., A01, B20)."
      },
      {
        "name": "is_faith_based",
        "label": "Faith-Based organization / church / ministry",
        "format": "boolean_tri",
        "help": "True if faith-based organization, church, or ministry."
      },
      {
        "name": "is_rural_serving",
        "label": "Serves rural area",
        "format": "boolean_tri",
        "help": "True if serving a rural area."
      },
      {
        "name": "is_minority_serving",
        "label": "Minority-Serving organization",
        "format": "boolean_tri",
        "help": "True if minority-serving organization."
      },
      {
        "name": "is_501c3_public_charity",
        "label": "501(c)(3) public charity",
        "format": "boolean_tri",
        "help": "True if 501(c)(3) public charity."
      },
      {
        "name": "is_501c3_private_foundation",
        "label": "501(c)(3) private foundation",
        "format": "boolean_tri",
        "help": "True if 501(c)(3) private foundation."
      },
      {
        "name": "cert_8a",
        "label": "8(a) certified",
        "format": "text",
        "help": "SBA program for disadvantaged businesses."
      },
      {
        "name": "cert_hubzone",
        "label": "Hubzone certified",
        "format": "text",
        "help": "True if HUBZone certified."
      },
      {
        "name": "cert_sdvosb",
        "label": "Service-Disabled veteran-owned small business (SDVOSB)",
        "format": "text",
        "help": "True if SDVOSB certified."
      },
      {
        "name": "cert_mbe",
        "label": "Minority business enterprise (MBE)",
        "format": "text",
        "help": "True if MBE certified."
      },
      {
        "name": "cert_wbe",
        "label": "Women business enterprise (WBE)",
        "format": "text",
        "help": "True if WBE certified."
      },
      {
        "name": "cert_sbir_sttr",
        "label": "SBIR/STTR eligible",
        "format": "text",
        "help": "True if eligible for SBIR/STTR programs."
      },
      {
        "name": "in_opportunity_zone",
        "label": "Opportunity zone location",
        "format": "text",
        "help": "Economically distressed community eligible for tax incentives."
      },
      {
        "name": "in_qct",
        "label": "Qualified census tract (QCT)",
        "format": "text",
        "help": "HUD-designated low-income area."
      },
      {
        "name": "in_epa_ej_area",
        "label": "EPA environmental justice area",
        "format": "text",
        "help": "True if located in an EPA Environmental Justice area."
      },
      {
        "name": "in_usda_persistent_poverty_county",
        "label": "USDA persistent-poverty county",
        "format": "text",
        "help": "True if located in a USDA persistent-poverty county."
      },
      {
        "name": "in_appalachian_region",
        "label": "Appalachian region",
        "format": "text",
        "help": "Served by Appalachian Regional Commission."
      },
      {
        "name": "broadband_unserved",
        "label": "Broadband-Unserved (fcc map block)",
        "format": "text",
        "help": "No high-speed internet — USDA ReConnect and NTIA grants."
      },
      {
        "name": "in_fema_disaster_area",
        "label": "FEMA disaster declaration area",
        "format": "text",
        "help": "True if located in a FEMA disaster declaration area."
      },
      {
        "name": "is_tribal_government",
        "label": "Tribal government / tribally controlled organization",
        "format": "boolean_tri",
        "help": "True if tribal government or tribally controlled organization."
      },
      {
        "name": "is_community_action_agency",
        "label": "Community action agency (CAA)",
        "format": "boolean_tri",
        "help": "CSBG eligible entity."
      },
      {
        "name": "is_housing_authority",
        "label": "Housing authority",
        "format": "boolean_tri",
        "help": "True if housing authority."
      },
      {
        "name": "is_workforce_dev_board",
        "label": "Workforce development board",
        "format": "boolean_tri",
        "help": "True if workforce development board."
      },
      {
        "name": "is_cdfi",
        "label": "CDFI partner",
        "format": "boolean_tri",
        "help": "Community Development Financial Institution."
      },
      {
        "name": "is_msi_hbcu",
        "label": "MSI/HBCU/HSI/TCU",
        "format": "boolean_tri",
        "help": "Minority-Serving Institution."
      },
      {
        "name": "is_rural_health_clinic",
        "label": "Rural health clinic (RHC)",
        "format": "boolean_tri",
        "help": "True if rural health clinic."
      },
      {
        "name": "is_cooperative",
        "label": "Cooperative (ag/electric/housing/worker)",
        "format": "boolean_tri",
        "help": "True if cooperative organization."
      },
      {
        "name": "notes",
        "label": "Notes",
        "format": "long_text",
        "help": "Additional organization context not captured by the structured fields."
      }
    ]
  },
  "financial_information": {
    "title": "Financial Situation",
    "description": "Document income, household size, and employment status to support need-based matching.",
    "fields": [
      {
        "name": "annual_income",
        "label": "Annual income (USD)",
        "format": "currency_usd",
        "min": 0,
        "max": 100000000,
        "help": "Annual individual income (USD) if known."
      },
      {
        "name": "household_income",
        "label": "Household income (USD)",
        "format": "currency_usd",
        "min": 0,
        "max": 100000000,
        "help": "Annual household income (USD) if known."
      },
      {
        "name": "household_size",
        "label": "Household size",
        "format": "text",
        "integer": true,
        "min": 1,
        "max": 30,
        "help": "Number of people in the household (whole number)."
      },
      {
        "name": "financial_need_level",
        "label": "Financial need level",
        "format": "enum",
        "help": "Short descriptor of need (e.g., high, moderate, unknown).",
        "options": [
          "low",
          "moderate",
          "high",
          "urgent",
          "unknown"
        ]
      },
      {
        "name": "low_income",
        "label": "Low income household",
        "format": "boolean_tri",
        "help": "True if the applicant is explicitly low-income."
      },
      {
        "name": "employment_status",
        "label": "Employment status",
        "format": "enum",
        "legacy_aliases": ["unemployed"],
        "options": [
          "student",
          "not_in_labor_force",
          "unemployed_seeking",
          "employed_full_time",
          "employed_part_time",
          "self_employed",
          "retired"
        ],
        "help": "Employment status aligned with Employment > Current status. Legacy field 'unemployed' is mapped to this canonical key during save."
      },
      {
        "name": "unemployed",
        "label": "Currently unemployed",
        "format": "boolean_tri",
        "help": "Legacy/current intake flag indicating the applicant is unemployed. Prefer Employment status / Employment > Current status when a specific status is known."
      },
      {
        "name": "displaced_worker",
        "label": "Displaced worker",
        "format": "boolean_tri",
        "help": "True if the applicant is a displaced worker (job loss/layoff)."
      },
      {
        "name": "funding_needs",
        "label": "Funding need range (estimate)",
        "format": "text",
        "help": "A working estimate or range of the funding this profile needs (e.g. $15,000–$250,000). This is a planning range, not the single target goal (see Story & Goals > Funding goal) and not the currently-matched Pipeline Potential."
      },
      {
        "name": "funding_purpose",
        "label": "Funding purpose",
        "format": "text",
        "help": "How funds will be used."
      },
      {
        "name": "item_needs",
        "label": "Items you need funding for",
        "format": "string_array",
        "scored": false,
        "help": "List specific things you need — equipment, a vehicle, a class, a certification, supplies — in your own words (e.g. \"PROBE ethics class for nursing licensure\", \"15 passenger van\"). GrantFlow searches for each one on demand. Not used for match scoring: this is what you want, not what you qualify for."
      },
      {
        "name": "receives_assistance",
        "label": "Receives assistance (list)",
        "format": "boolean_tri",
        "help": "Current benefits or assistance programs received."
      },
      {
        "name": "assistance_notes",
        "label": "Assistance notes",
        "format": "prose",
        "scored": false,
        "help": "Any nuance about benefits or barriers."
      },
      {
        "name": "notes",
        "label": "Notes",
        "format": "prose",
        "scored": false,
        "help": "Concise context about income or need (max ~2 sentences)."
      },
      {
        "name": "underemployed",
        "label": "Underemployed",
        "format": "boolean_tri",
        "help": "Working part-time or below skill level."
      },
      {
        "name": "has_medical_debt",
        "label": "Medical debt",
        "format": "boolean_tri",
        "help": "Outstanding medical bills — debt relief programs available."
      },
      {
        "name": "has_education_debt",
        "label": "Education/Student loan debt",
        "format": "boolean_tri",
        "help": "Student loan forgiveness programs available."
      },
      {
        "name": "bankruptcy_foreclosure",
        "label": "Bankruptcy / foreclosure",
        "format": "boolean_tri",
        "help": "Recent financial crisis — recovery assistance available."
      },
      {
        "name": "first_time_homebuyer",
        "label": "First-Time homebuyer",
        "format": "boolean_tri",
        "help": "Down payment assistance programs available."
      }
    ]
  },
  "government_assistance": {
    "applies_to": ALL_PERSON_TYPES,
    "title": "Government Assistance",
    "description": "Track public benefits to strengthen eligibility profiling for specific funds.",
    "fields": [
      {
        "name": "medicaid_recipient_self",
        "label": "Medicaid recipient self",
        "format": "boolean_tri",
        "help": "True if the applicant personally receives Medicaid."
      },
      {
        "name": "medicaid_recipient_household",
        "label": "Medicaid recipient household",
        "format": "boolean_tri",
        "help": "True if someone in the applicant's household receives Medicaid."
      },
      {
        "name": "medicaid_waiver_program",
        "label": "Medicaid waiver program",
        "format": "text",
        "help": "Medicaid waiver program when applicable (e.g., ecf_choices)."
      },
      {
        "name": "ecf_choices_role",
        "label": "ECF choices role",
        "format": "enum",
        "help": "ECF CHOICES role for unlocking the crawler: participant, caregiver, or provider.",
        "options": [
          "participant",
          "caregiver",
          "provider",
          "unknown"
        ]
      },
      {
        "name": "medicare_recipient_self",
        "label": "Medicare recipient self",
        "format": "boolean_tri",
        "help": "True if the applicant personally receives Medicare."
      },
      {
        "name": "medicare_recipient_household",
        "label": "Medicare recipient household",
        "format": "boolean_tri",
        "help": "True if someone in the applicant's household receives Medicare."
      },
      {
        "name": "ssi_recipient_self",
        "label": "SSI recipient self",
        "format": "boolean_tri",
        "help": "True if the applicant personally receives SSI."
      },
      {
        "name": "ssi_recipient_household",
        "label": "SSI recipient household",
        "format": "boolean_tri",
        "help": "True if someone in the applicant's household receives SSI."
      },
      {
        "name": "ssdi_recipient_self",
        "label": "SSDI recipient self",
        "format": "boolean_tri",
        "help": "True if the applicant personally receives SSDI."
      },
      {
        "name": "ssdi_recipient_household",
        "label": "SSDI recipient household",
        "format": "boolean_tri",
        "help": "True if someone in the applicant's household receives SSDI."
      },
      {
        "name": "snap_recipient_self",
        "label": "SNAP recipient self",
        "format": "boolean_tri",
        "help": "True if the applicant personally receives SNAP."
      },
      {
        "name": "snap_recipient_household",
        "label": "SNAP recipient household",
        "format": "boolean_tri",
        "help": "True if someone in the applicant's household receives SNAP."
      },
      {
        "name": "tanf_recipient_self",
        "label": "TANF recipient self",
        "format": "boolean_tri",
        "help": "True if the applicant personally receives TANF."
      },
      {
        "name": "tanf_recipient_household",
        "label": "TANF recipient household",
        "format": "boolean_tri",
        "help": "True if someone in the applicant's household receives TANF."
      },
      {
        "name": "section8_recipient_self",
        "label": "Section 8 recipient self",
        "format": "boolean_tri",
        "help": "True if the applicant personally receives Section 8 housing assistance."
      },
      {
        "name": "section8_recipient_household",
        "label": "Section 8 recipient household",
        "format": "boolean_tri",
        "help": "True if someone in the applicant's household receives Section 8 housing assistance."
      },
      {
        "name": "other_programs",
        "label": "Other programs",
        "format": "text",
        "help": "Comma-separated list of other benefits or programs."
      },
      {
        "name": "medicaid_enrolled",
        "label": "Medicaid enrolled",
        "format": "boolean_tri",
        "help": "Legacy field mapped to Medicaid recipient self/household during save."
      },
      {
        "name": "medicare_recipient",
        "label": "Medicare recipient",
        "format": "boolean_tri",
        "help": "Legacy field mapped to Medicare recipient self/household during save."
      },
      {
        "name": "ssi_recipient",
        "label": "SSI recipient",
        "format": "boolean_tri",
        "help": "Legacy field mapped to SSI recipient self/household during save."
      },
      {
        "name": "ssdi_recipient",
        "label": "SSDI recipient",
        "format": "boolean_tri",
        "help": "Legacy field mapped to SSDI recipient self/household during save."
      },
      {
        "name": "snap_recipient",
        "label": "SNAP recipient",
        "format": "boolean_tri",
        "help": "Legacy field mapped to SNAP recipient self/household during save."
      },
      {
        "name": "tanf_recipient",
        "label": "TANF recipient",
        "format": "boolean_tri",
        "help": "Legacy field mapped to TANF recipient self/household during save."
      },
      {
        "name": "section8_housing",
        "label": "Section 8 housing",
        "format": "boolean_tri",
        "help": "Legacy field mapped to Section 8 recipient self/household during save."
      }
    ]
  },
  "health_medical": {
    "applies_to": ALL_PERSON_TYPES,
    "title": "Health & Medical",
    "description": "Capture relevant health information to highlight eligibility for medical and disability-focused opportunities.",
    "fields": [
      {
        "name": "conditions",
        "label": "Conditions (list)",
        "format": "json",
        "help": "List of health conditions. Minimum shape per entry: { name, icd10?, stage?, diagnosed_year? }."
      },
      {
        "name": "chronic_illness",
        "label": "Chronic illness",
        "format": "boolean_tri",
        "help": "True if chronic illness is explicitly stated."
      },
      {
        "name": "chronic_illness_type",
        "label": "Illness type",
        "format": "text",
        "help": "Type or name of chronic illness if provided."
      },
      {
        "name": "disability_type",
        "label": "Disability types",
        "format": "string_array",
        "help": "List of disability types when explicitly stated."
      },
      {
        "name": "support_needs",
        "label": "Support needs (list)",
        "format": "string_array",
        "help": "Support needs (e.g., transportation, copay_assistance, lodging, caregiver_support). Enter items separated by commas or new lines."
      },
      {
        "name": "support_needs_level",
        "label": "Support needs level",
        "format": "text",
        "help": "Short descriptor of support needs (high/moderate/low/unknown)."
      },
      {
        "name": "consent_for_studies",
        "label": "Consent to view research studies/trials",
        "format": "text",
        "help": "True if the user opts in to seeing research studies or trials."
      },
      {
        "name": "mobility_or_transport_notes",
        "label": "Mobility / transportation notes",
        "format": "prose",
        "scored": false,
        "help": "Optional notes about mobility or transportation needs for appointments."
      },
      {
        "name": "dialysis_patient",
        "label": "Dialysis patient",
        "format": "text",
        "help": "True if on dialysis."
      },
      {
        "name": "organ_transplant",
        "label": "Organ transplant recipient",
        "format": "text",
        "help": "True if transplant recipient or candidate."
      },
      {
        "name": "hiv_aids",
        "label": "Living with HIV/AIDS",
        "format": "text",
        "help": "True if HIV/AIDS is explicitly stated."
      },
      {
        "name": "tbi_survivor",
        "label": "Traumatic brain injury survivor",
        "format": "boolean_tri",
        "help": "True if traumatic brain injury survivor."
      },
      {
        "name": "amputee",
        "label": "Amputee",
        "format": "text",
        "help": "True if amputee."
      },
      {
        "name": "neurodivergent",
        "label": "Neurodivergent",
        "format": "text",
        "help": "True if neurodivergent (autism/ADHD/etc.) is stated."
      },
      {
        "name": "visual_impairment",
        "label": "Visual impairment",
        "format": "boolean_tri",
        "help": "True if visual impairment or blindness is stated."
      },
      {
        "name": "hearing_impairment",
        "label": "Hearing impairment",
        "format": "boolean_tri",
        "help": "True if hearing impairment or deafness is stated."
      },
      {
        "name": "wheelchair_user",
        "label": "Wheelchair user",
        "format": "boolean_tri",
        "help": "True if wheelchair user."
      },
      {
        "name": "substance_recovery",
        "label": "In substance recovery",
        "format": "boolean_tri",
        "help": "True if in recovery or substance use recovery is stated."
      },
      {
        "name": "mental_health_condition",
        "label": "Mental health condition",
        "format": "boolean_tri",
        "help": "True if a mental health condition is stated."
      },
      {
        "name": "notes",
        "label": "Medical notes",
        "format": "prose",
        "scored": false,
        "help": "Brief medical context (up to ~3 sentences)."
      }
    ]
  },
  "medical_insurance": {
    "title": "Medical Insurance",
    "description": "Store insurance details (provider/plan). Upload insurance cards or letters in the Files panel.",
    "applies_to": MEDICAL_PROFILE_TYPES,
    "fields": [
      {
        "name": "insurance_provider",
        "label": "Insurance provider",
        "format": "text",
        "help": "Primary insurance provider name (e.g., BlueCross, Aetna, Medicaid managed-care plan)."
      },
      {
        "name": "plan_name",
        "label": "Plan name",
        "format": "text",
        "help": "Plan name (e.g., HMO/PPO plan name) if known."
      },
      {
        "name": "plan_type",
        "label": "Plan type",
        "format": "enum",
        "help": "Plan type (e.g., HMO, PPO, Medicaid, Medicare, Marketplace).",
        "options": [
          "HMO",
          "PPO",
          "Medicaid",
          "Medicare",
          "Marketplace",
          "other",
          "unknown"
        ]
      },
      {
        "name": "member_id",
        "label": "Member id (optional)",
        "format": "text",
        "help": "Member/Subscriber ID if explicitly provided in documents; leave blank if unknown."
      },
      {
        "name": "group_id",
        "label": "Group id (optional)",
        "format": "text",
        "help": "Group ID if explicitly provided in documents; leave blank if unknown."
      },
      {
        "name": "policy_holder_name",
        "label": "Policy holder name",
        "format": "text",
        "help": "Name of policy holder when relevant."
      },
      {
        "name": "effective_date",
        "label": "Effective date",
        "format": "date",
        "help": "Coverage effective date (YYYY-MM-DD) if known."
      },
      {
        "name": "phone_for_claims",
        "label": "Member services phone",
        "format": "phone",
        "help": "Member services or claims phone number if known."
      },
      {
        "name": "notes",
        "label": "Notes",
        "format": "prose",
        "scored": false,
        "help": "High-level notes about coverage gaps, copays, prior auth needs, etc."
      }
    ]
  },
  "medical_history": {
    "title": "Medical History & Needs",
    "description": "Capture medical context needed for assistance resources and support letters (keep concise).",
    "applies_to": MEDICAL_PROFILE_TYPES,
    "fields": [
      {
        "name": "primary_condition",
        "label": "Primary condition",
        "format": "text",
        "help": "Primary condition or diagnosis when explicitly stated."
      },
      {
        "name": "secondary_conditions",
        "label": "Secondary conditions",
        "format": "string_array",
        "help": "Other conditions or diagnoses explicitly stated. Enter items separated by commas or new lines."
      },
      {
        "name": "mobility_needs",
        "label": "Mobility needs",
        "format": "text",
        "help": "Mobility needs summary (e.g., wheelchair, walker, limited standing)."
      },
      {
        "name": "dme_needed",
        "label": "Durable medical equipment needed",
        "format": "string_array",
        "help": "Durable medical equipment needed (e.g., shower chair). Enter items separated by commas or new lines."
      },
      {
        "name": "doctor_name",
        "label": "Doctor / clinician",
        "format": "text",
        "help": "Primary clinician or doctor name if known."
      },
      {
        "name": "clinic_name",
        "label": "Clinic / hospital",
        "format": "text",
        "help": "Clinic or hospital name if known."
      },
      {
        "name": "letter_support_needed",
        "label": "Support letter needed",
        "format": "text",
        "help": "True if a letter of medical necessity or support letter is needed."
      },
      {
        "name": "notes",
        "label": "Notes",
        "format": "prose",
        "scored": false,
        "help": "Concise medical history context (up to ~5 sentences)."
      }
    ]
  },
  "nonprofit_compliance": {
    "title": "Nonprofit Compliance",
    "description": "Track core compliance readiness signals used by many grants.",
    "applies_to": NONPROFIT_COMPLIANCE_TYPES,
    "fields": [
      {
        "name": "is_501c3",
        "label": "501(c)(3) status confirmed",
        "format": "boolean_tri",
        "help": "True if 501(c)(3) status is confirmed."
      },
      {
        "name": "fiscal_sponsor",
        "label": "Uses a fiscal sponsor",
        "format": "text",
        "help": "True if operating under a fiscal sponsor."
      },
      {
        "name": "fiscal_sponsor_name",
        "label": "Fiscal sponsor name",
        "format": "text",
        "help": "Fiscal sponsor name if applicable."
      },
      {
        "name": "sam_registered",
        "label": "SAM.gov registered",
        "format": "text",
        "help": "True if SAM.gov registration is confirmed."
      },
      {
        "name": "insurance_coverage",
        "label": "Insurance coverage",
        "format": "text",
        "help": "General insurance coverage (GL, D&O) if known."
      },
      {
        "name": "compliance_notes",
        "label": "Compliance notes",
        "format": "prose",
        "scored": false,
        "help": "Notes about audits, policies, and compliance gaps."
      }
    ]
  },
  "small_business_details": {
    "title": "Small Business Details",
    "description": "Track business details needed for small business programs and certifications.",
    "applies_to": SMALL_BUSINESS_DETAILS_TYPES,
    "fields": [
      {
        "name": "business_name",
        "label": "Business name",
        "format": "text",
        "help": "Legal business name if different from profile name."
      },
      {
        "name": "naics_code",
        "label": "Naics code",
        "format": "text",
        "help": "NAICS code if known."
      },
      {
        "name": "years_in_business",
        "label": "Years in business",
        "format": "text",
        "help": "Years in business (integer) if known."
      },
      {
        "name": "employee_count",
        "label": "Employee count",
        "format": "text",
        "help": "Employee count if known."
      },
      {
        "name": "annual_revenue",
        "label": "Annual revenue (USD)",
        "format": "currency_usd",
        "help": "Annual revenue (USD) if known."
      },
      {
        "name": "certifications",
        "label": "Certifications",
        "format": "string_array",
        "help": "Certifications (e.g., WOSB, HUBZone, MBE) when explicitly stated. Enter items separated by commas or new lines."
      },
      {
        "name": "notes",
        "label": "Notes",
        "format": "prose",
        "scored": false,
        "help": "Notes about products/services, capacity, and priorities."
      }
    ]
  },
  "demographics": {
    "applies_to": ALL_PERSON_TYPES,
    "title": "Demographics",
    "description": "Document demographic information that influences funding eligibility and reporting requirements.",
    "fields": [
      {
        "name": "african_american",
        "label": "African american / black",
        "format": "text",
        "help": "True if Black/African American identity stated."
      },
      {
        "name": "hispanic_latino",
        "label": "Hispanic / latino",
        "format": "text",
        "help": "True if Hispanic/Latino identity stated."
      },
      {
        "name": "asian_american",
        "label": "Asian american / pacific islander",
        "format": "text",
        "help": "True if Asian/AAPI identity stated."
      },
      {
        "name": "native_american",
        "label": "Native american / alaska native",
        "format": "text",
        "help": "True if Native American/Indigenous identity stated."
      },
      {
        "name": "tribal_affiliation",
        "label": "Tribal affiliation",
        "format": "text",
        "help": "Tribal affiliation if specified."
      },
      {
        "name": "lgbtq",
        "label": "Identifies as LGBTQ+",
        "format": "text",
        "help": "True if LGBTQ+ identity stated."
      },
      {
        "name": "immigration_status",
        "label": "Immigration status",
        "format": "enum",
        "legacy_aliases": ["immigrant_status"],
        "help": "Canonical immigration status: us_citizen, permanent_resident, refugee, undocumented, other, unknown. Legacy field 'immigrant_status' is mapped to this canonical key during save.",
        "options": [
          "us_citizen",
          "permanent_resident",
          "refugee",
          "undocumented",
          "other",
          "unknown"
        ]
      },
      {
        "name": "immigrant_status",
        "label": "Immigration status (legacy)",
        "format": "text",
        "help": "Legacy/current intake immigration-status field. Canonical matching also reads Demographics > Immigration status, and this key is preserved so imported or seeded profiles render without hiding evidence."
      },
      {
        "name": "ethnicity",
        "label": "Ethnicity (free text)",
        "format": "text",
        "help": "Ethnicity (freeform)."
      },
      {
        "name": "heritage",
        "label": "Heritage / ancestry",
        "format": "text",
        "help": "Heritage or ancestry (freeform)."
      },
      {
        "name": "languages",
        "label": "Languages",
        "format": "string_array",
        "help": "Languages spoken or language-access needs. Accepts string, array, or structured imported language values normalized for matching."
      },
      {
        "name": "religious_affiliation",
        "label": "Religious affiliation",
        "format": "text",
        "help": "Religious affiliation if relevant."
      },
      {
        "name": "citizenship",
        "label": "Citizenship",
        "format": "text",
        "help": "Citizenship status or country."
      },
      {
        "name": "us_citizen",
        "label": "Us citizen",
        "format": "text",
        "help": "True if US citizen."
      },
      {
        "name": "disability_status",
        "label": "Disability status (high level)",
        "format": "text",
        "help": "High-level disability status descriptor."
      },
      {
        "name": "veteran_status",
        "label": "Veteran status (high level)",
        "format": "text",
        "help": "High-level veteran status descriptor."
      },
      {
        "name": "age_group",
        "label": "Age group",
        "format": "text",
        "help": "Age group (e.g., youth, young adult, senior)."
      },
      {
        "name": "white_caucasian",
        "label": "White / caucasian",
        "format": "text",
        "help": "True if White/Caucasian identity stated."
      },
      {
        "name": "notes",
        "label": "Demographic notes",
        "format": "prose",
        "scored": false,
        "help": "Additional demographic context or identities."
      },
      {
        "name": "good_credit_score",
        "label": "Good credit score (700+)",
        "format": "text",
        "help": "Qualifies for financial literacy programs and non-loan support."
      },
      {
        "name": "religious_denomination",
        "label": "Religious denomination",
        "format": "text",
        "help": "e.g., Baptist, Methodist, Catholic, Lutheran — denominational scholarships available."
      },
      {
        "name": "jewish_heritage",
        "label": "Jewish heritage",
        "format": "text",
        "help": "Extensive funding from Jewish federations, Hillel, and synagogues."
      },
      {
        "name": "irish_heritage",
        "label": "Irish heritage",
        "format": "text",
        "help": "Hibernian societies, Irish cultural organizations."
      },
      {
        "name": "italian_heritage",
        "label": "Italian heritage",
        "format": "text",
        "help": "True if Italian heritage."
      },
      {
        "name": "greek_heritage",
        "label": "Greek heritage",
        "format": "text",
        "help": "AHEPA, Hellenic societies."
      },
      {
        "name": "armenian_heritage",
        "label": "Armenian heritage",
        "format": "text",
        "help": "True if Armenian heritage."
      },
      {
        "name": "appalachian_heritage",
        "label": "Appalachian heritage",
        "format": "text",
        "help": "True if Appalachian heritage."
      },
      {
        "name": "gender",
        "label": "Gender",
        "format": "text",
        "help": "High-level demographic gender value when live or imported data stores it in demographics; Basic information > Gender remains supported for contact/intake display."
      },
      {
        "name": "geographic_qualifiers",
        "label": "Geographic qualifiers",
        "format": "string_array",
        "help": "Geographic eligibility qualifiers such as rural, Appalachian, underserved, disaster area, or other location-based funding signals."
      }
    ]
  },
  "family_life": {
    "applies_to": ALL_PERSON_TYPES,
    "title": "Family & Life Situation",
    "description": "Capture household and life events that may trigger eligibility for supportive programs.",
    "fields": [
      {
        "name": "single_parent",
        "label": "Single parent household",
        "format": "boolean_tri",
        "help": "True if single parent."
      },
      {
        "name": "foster_youth",
        "label": "Current/Former foster youth",
        "format": "boolean_tri",
        "help": "True if current or former foster youth."
      },
      {
        "name": "orphan",
        "label": "Orphan",
        "format": "boolean_tri",
        "help": "True if orphan."
      },
      {
        "name": "adopted",
        "label": "Adopted",
        "format": "boolean_tri",
        "help": "True if adopted."
      },
      {
        "name": "foster_parent",
        "label": "Foster parent",
        "format": "boolean_tri",
        "help": "True if foster parent."
      },
      {
        "name": "caregiver",
        "label": "Primary caregiver (non-parent)",
        "format": "boolean_tri",
        "help": "True if caregiver for someone else."
      },
      {
        "name": "widow_widower",
        "label": "Widow / widower",
        "format": "text",
        "help": "True if widowed."
      },
      {
        "name": "grandparent_raising_grandchildren",
        "label": "Grandparent raising grandchildren",
        "format": "text",
        "help": "True if grandparent raising grandchildren."
      },
      {
        "name": "first_time_parent",
        "label": "First-Time parent",
        "format": "boolean_tri",
        "help": "True if first-time parent."
      },
      {
        "name": "homeless",
        "label": "Experiencing homelessness",
        "format": "boolean_tri",
        "help": "True if homeless or housing insecure."
      },
      {
        "name": "domestic_violence_survivor",
        "label": "Domestic violence survivor",
        "format": "boolean_tri",
        "help": "True if domestic violence survivor."
      },
      {
        "name": "trafficking_survivor",
        "label": "Human trafficking survivor",
        "format": "boolean_tri",
        "help": "True if human trafficking survivor."
      },
      {
        "name": "disaster_survivor",
        "label": "Disaster survivor",
        "format": "boolean_tri",
        "help": "True if disaster survivor (fire/flood/storm/etc.)."
      },
      {
        "name": "formerly_incarcerated",
        "label": "Formerly incarcerated / returning citizen",
        "format": "text",
        "help": "True if formerly incarcerated."
      },
      {
        "name": "notes",
        "label": "Life circumstances notes",
        "format": "prose",
        "scored": false,
        "help": "Brief life situation context (up to ~2 sentences)."
      },
      {
        "name": "family_caregiver",
        "label": "Family caregiver",
        "format": "boolean_tri",
        "help": "True if the applicant provides regular care for family members."
      },
      {
        "name": "household_size",
        "label": "Household size",
        "format": "text",
        "help": "Number of people in the household when captured in family context."
      }
    ]
  },
  "military_service": {
    "applies_to": ALL_PERSON_TYPES,
    "title": "Military Status",
    "description": "Record any military service or affiliation to unlock veteran-focused resources.",
    "fields": [
      {
        "name": "veteran",
        "label": "Veteran",
        "format": "boolean_tri",
        "help": "True if veteran."
      },
      {
        "name": "active_duty_military",
        "label": "Active duty military",
        "format": "text",
        "help": "True if active duty."
      },
      {
        "name": "national_guard",
        "label": "National guard / reserve",
        "format": "text",
        "help": "True if National Guard or Reserve."
      },
      {
        "name": "disabled_veteran",
        "label": "Disabled veteran",
        "format": "text",
        "help": "True if disabled veteran."
      },
      {
        "name": "military_spouse",
        "label": "Military spouse",
        "format": "boolean_tri",
        "help": "True if military spouse."
      },
      {
        "name": "military_dependent",
        "label": "Military dependent",
        "format": "boolean_tri",
        "help": "True if military dependent or child."
      },
      {
        "name": "gold_star_family",
        "label": "Gold Star family",
        "format": "boolean_tri",
        "help": "True if Gold Star family."
      },
      {
        "name": "notes",
        "label": "Service details",
        "format": "prose",
        "scored": false,
        "help": "Branch, years of service, disability rating context when relevant."
      }
    ]
  },
  "occupation": {
    "applies_to": ALL_PERSON_TYPES,
    "title": "Occupation",
    "description": "Track professional roles and designations relevant to workforce or training programs.",
    "fields": [
      {
        "name": "healthcare_worker",
        "label": "Healthcare worker",
        "format": "boolean_tri",
        "help": "True if healthcare worker."
      },
      {
        "name": "healthcare_worker_type",
        "label": "Healthcare role",
        "format": "text",
        "help": "Healthcare role type (e.g., RN, CNA, EMT)."
      },
      {
        "name": "ems_worker",
        "label": "EMS/First responder",
        "format": "boolean_tri",
        "help": "True if EMS worker or first responder."
      },
      {
        "name": "educator",
        "label": "Educator / teacher",
        "format": "boolean_tri",
        "help": "True if educator or teacher."
      },
      {
        "name": "firefighter",
        "label": "Firefighter",
        "format": "boolean_tri",
        "help": "True if firefighter."
      },
      {
        "name": "law_enforcement",
        "label": "Law enforcement / corrections",
        "format": "text",
        "help": "True if law enforcement or corrections officer."
      },
      {
        "name": "public_servant",
        "label": "Public servant / government employee",
        "format": "boolean_tri",
        "help": "True if public servant or government worker."
      },
      {
        "name": "clergy",
        "label": "Clergy / religious worker",
        "format": "boolean_tri",
        "help": "True if clergy or religious worker."
      },
      {
        "name": "missionary",
        "label": "Missionary / evangelist",
        "format": "boolean_tri",
        "help": "True if missionary or evangelist."
      },
      {
        "name": "nonprofit_employee",
        "label": "Nonprofit employee",
        "format": "boolean_tri",
        "help": "True if nonprofit employee."
      },
      {
        "name": "small_business_owner",
        "label": "Small business owner",
        "format": "boolean_tri",
        "help": "True if small business owner."
      },
      {
        "name": "minority_owned_business",
        "label": "Minority-Owned business",
        "format": "text",
        "help": "True if minority-owned business."
      },
      {
        "name": "women_owned_business",
        "label": "Women-Owned business",
        "format": "text",
        "help": "True if women-owned business."
      },
      {
        "name": "union_member",
        "label": "Union member",
        "format": "boolean_tri",
        "help": "True if union member."
      },
      {
        "name": "farmer",
        "label": "Agricultural worker / farmer",
        "format": "boolean_tri",
        "help": "True if farmer or agricultural worker."
      },
      {
        "name": "truck_driver",
        "label": "Truck driver / transportation worker",
        "format": "text",
        "help": "True if truck driver or transportation worker."
      },
      {
        "name": "notes",
        "label": "Occupational notes",
        "format": "prose",
        "scored": false,
        "help": "Additional occupations, certifications, or union local."
      }
    ]
  },
  "location_focus": {
    "title": "Location Focus",
    "description": "Define where the applicant lives or delivers services to align with geographic funding criteria.",
    "fields": [
      {
        "name": "rural_resident",
        "label": "Rural resident",
        "format": "text",
        "help": "True if rural resident or served area is rural."
      },
      {
        "name": "appalachian_region",
        "label": "Located in Appalachian region",
        "format": "text",
        "help": "True if located in or serving Appalachia."
      },
      {
        "name": "urban_underserved",
        "label": "Urban underserved community",
        "format": "text",
        "help": "True if located in or serving an underserved urban area."
      },
      {
        "name": "geographic_focus",
        "label": "Geographic focus",
        "format": "text",
        "help": "Primary geography served or targeted."
      },
      {
        "name": "notes",
        "label": "Location notes",
        "format": "prose",
        "scored": false,
        "help": "County, census tract, or other location qualifiers."
      }
    ]
  },
  "university_applications": {
    "title": "University Applications",
    "description": "Student college application tracking (for scholarship targeting).",
    "applies_to": STUDENT_TYPES,
    "fields": [
      {
        "name": "applications",
        "label": "Applications",
        "format": "json",
        "help": "Array of tracked college applications and their details."
      },
      {
        "name": "school_portal_imports",
        "label": "School portal imports",
        "format": "json",
        "help": "Stored school-portal connections, provider metadata, and importable award records."
      }
    ]
  },
  "education": {
    "title": "Education",
    "description": "Academic history and student qualifiers (GPA, tests, service hours) for scholarship and education-focused matching.",
    "applies_to": STUDENT_TYPES,
    "fields": [
      {
        "name": "highest_level",
        "label": "Highest level completed",
        "format": "text",
        "help": "Highest education level attained (freeform string)."
      },
      {
        "name": "current_institution",
        "label": "Current institution",
        "format": "text",
        "help": "Current institution or school name."
      },
      {
        "name": "target_colleges",
        "label": "Target colleges (list)",
        "format": "string_array",
        "help": "Target colleges or universities (comma-separated)."
      },
      {
        "name": "schools",
        "label": "Schools",
        "format": "json",
        "help": "Structured list of schools attended or under consideration."
      },
      {
        "name": "intended_major",
        "label": "Intended major",
        "format": "text",
        "help": "Intended major or program."
      },
      {
        "name": "gpa",
        "label": "GPA",
        "format": "text",
        "help": "GPA when explicitly provided."
      },
      {
        "name": "act_score",
        "label": "ACT score",
        "format": "text",
        "help": "ACT score when explicitly provided."
      },
      {
        "name": "sat_score",
        "label": "SAT score",
        "format": "text",
        "help": "SAT score when explicitly provided."
      },
      {
        "name": "community_service_hours",
        "label": "Community service hours",
        "format": "text",
        "help": "Community service hours when known."
      },
      {
        "name": "leadership_roles",
        "label": "Leadership roles (list)",
        "format": "string_array",
        "help": "Leadership roles (comma-separated)."
      },
      {
        "name": "valedictorian",
        "label": "Valedictorian",
        "format": "boolean_tri",
        "help": "True if valedictorian (explicitly stated)."
      },
      {
        "name": "notes",
        "label": "Education notes",
        "format": "prose",
        "scored": false,
        "help": "Additional education context."
      },
      {
        "name": "aid_types_accepted",
        "label": "Aid types you will accept",
        "format": "string_array",
        "scored": false,
        "help": "Which kinds of financial aid this profile wants: grant, scholarship, endowment, work_study, loan. Leave blank to accept everything except loans (the default). A declined type is never added to the pipeline — you will still see it on the school's own portal."
      },
      {
        "name": "pell_grant_eligible",
        "label": "Pell grant eligible",
        "format": "boolean_tri",
        "help": "Federal grant for low-income students."
      },
      {
        "name": "fafsa_completed",
        "label": "FAFSA completed",
        "format": "boolean_tri",
        "help": "Required for most federal financial aid."
      },
      {
        "name": "first_generation_college_student",
        "label": "First-Generation college student",
        "format": "text",
        "help": "First in your family to attend college."
      },
      {
        "name": "dual_enrollment",
        "label": "Dual enrollment / early college",
        "format": "text",
        "help": "True if enrolled in dual enrollment or early college program."
      },
      {
        "name": "rotc_jrotc",
        "label": "ROTC / JROTC participation",
        "format": "text",
        "help": "Military training — ROTC scholarships available."
      },
      {
        "name": "cte_pathway",
        "label": "Cte pathway",
        "format": "text",
        "help": "Career/Technical Education (EMT, welding, cybersecurity, nursing, etc.)."
      },
      {
        "name": "honor_societies",
        "label": "Honor societies",
        "format": "text",
        "help": "NHS, Phi Theta Kappa, etc."
      },
      {
        "name": "efc_sai_band",
        "label": "EFC/SAI band",
        "format": "text",
        "help": "Expected Family Contribution / Student Aid Index."
      },
      {
        "name": "high_school_gpa",
        "label": "High school GPA",
        "format": "text",
        "help": "High school GPA when explicitly provided."
      },
      {
        "name": "interests",
        "label": "Interests",
        "format": "string_array",
        "help": "Academic or extracurricular interests."
      }
    ]
  },
  "employment": {
    "applies_to": ALL_PERSON_TYPES,
    "title": "Employment",
    "description": "Employment status and experience used for workforce training and career-change programs.",
    "fields": [
      {
        "name": "current_status",
        "label": "Current status",
        "format": "enum",
        "options": [
          "student",
          "not_in_labor_force",
          "unemployed_seeking",
          "employed_full_time",
          "employed_part_time",
          "self_employed",
          "retired"
        ],
        "help": "Current employment status."
      },
      {
        "name": "career_goal",
        "label": "Career goal",
        "format": "text",
        "help": "Career goal (freeform)."
      },
      {
        "name": "experience",
        "label": "Experience",
        "format": "text",
        "help": "Brief experience summary (freeform)."
      },
      {
        "name": "notes",
        "label": "Employment notes",
        "format": "prose",
        "scored": false,
        "help": "Additional employment context."
      }
    ]
  },
  "housing": {
    "applies_to": ALL_PERSON_TYPES,
    "title": "Housing",
    "description": "Housing stability and geographic designations relevant to assistance programs.",
    "fields": [
      {
        "name": "status",
        "label": "Housing status",
        "format": "enum",
        "help": "Housing status (e.g., stable, at-risk, homeless, unknown).",
        "options": [
          "stable",
          "at_risk",
          "homeless",
          "temporary",
          "unknown"
        ]
      },
      {
        "name": "type",
        "label": "Housing type",
        "format": "enum",
        "help": "Housing type (rent, own, shelter, transitional, etc.).",
        "options": [
          "rent",
          "own",
          "shelter",
          "transitional",
          "temporary",
          "unknown"
        ]
      },
      {
        "name": "address",
        "label": "Housing address (if different)",
        "format": "json",
        "help": "Housing address when explicitly provided."
      },
      {
        "name": "broadband_speed",
        "label": "Broadband speed",
        "format": "text",
        "help": "Broadband speed or connectivity details if relevant."
      },
      {
        "name": "geographic_designation",
        "label": "Geographic designation (list)",
        "format": "string_array",
        "help": "Geographic designations (e.g., rural, urban, frontier). Enter items separated by commas or new lines."
      },
      {
        "name": "notes",
        "label": "Housing notes",
        "format": "prose",
        "scored": false,
        "help": "Additional housing context."
      }
    ]
  },
  "family": {
    "applies_to": ALL_PERSON_TYPES,
    "title": "Household Details",
    "description": "Household structure and support system details (separate from eligibility flags).",
    "fields": [
      {
        "name": "household_size",
        "label": "Household size",
        "format": "text",
        "help": "Household size when known."
      },
      {
        "name": "responsibilities",
        "label": "Responsibilities",
        "format": "text",
        "help": "Primary household responsibilities or caregiving context."
      },
      {
        "name": "support_system",
        "label": "Support system",
        "format": "text",
        "help": "Support system description."
      },
      {
        "name": "notes",
        "label": "Household notes",
        "format": "prose",
        "scored": false,
        "help": "Additional household context."
      }
    ]
  },
  "programs_services": {
    "applies_to": ALL_ORG_TYPES,
    "title": "Programs & Services",
    "description": "Focus areas, services, and keywords used to match funding opportunities (high-signal for crawlers).",
    "fields": [
      {
        "name": "focus_areas",
        "label": "Focus areas",
        "format": "tags",
        "vocabulary": "focus",
        "allow_custom": true,
        "help": "Pick the focus areas the matcher should use for this profile. Choose from the suggested list; add a custom value only if none fit."
      },
      {
        "name": "interests",
        "label": "Interests",
        "format": "tags",
        "vocabulary": "focus",
        "allow_custom": true,
        "help": "Pick interests that help match opportunities. Choose from the suggested list; add a custom value only if none fit."
      },
      {
        "name": "keywords",
        "label": "Keywords",
        "format": "tags",
        "vocabulary": "focus",
        "allow_custom": true,
        "help": "Keywords used by funding matchers. Choose from the suggested list; add a custom value only if none fit."
      },
      {
        "name": "notes",
        "label": "Programs/Services notes",
        "format": "prose",
        "scored": false,
        "help": "Additional program or service notes. Used to draft applications — not used for match scoring."
      }
    ]
  },
  "narrative": {
    "title": "Story & Goals",
    "description": "Summarize the applicant's mission, goals, and unique narrative to feed proposals and AI tooling.",
    "fields": [
      {
        "name": "mission",
        "label": "Mission",
        "format": "prose",
        "scored": false,
        "help": "Mission statement or personal mission. Used to draft applications — not used for match scoring."
      },
      {
        "name": "primary_goal",
        "label": "Primary goal",
        "format": "prose",
        "scored": false,
        "help": "Primary goal of the applicant or project. Used to draft applications — not used for match scoring."
      },
      {
        "name": "target_population",
        "label": "Target population",
        "format": "prose",
        "scored": false,
        "help": "Who benefits from the work (population served). Used to draft applications — not used for match scoring."
      },
      {
        "name": "funding_amount_needed",
        "label": "Funding goal (target amount)",
        "format": "currency_usd",
        "help": "The single target / headline funding goal for this profile or project. Distinct from Financial Situation > Funding need range (a planning estimate) and from Pipeline Potential (the dollars currently matched in the pipeline)."
      },
      {
        "name": "timeline",
        "label": "Timeline",
        "format": "prose",
        "scored": false,
        "help": "Timeline for the project or need. Used to draft applications — not used for match scoring."
      },
      {
        "name": "past_experience",
        "label": "Past experience",
        "format": "prose",
        "scored": false,
        "help": "Relevant past experience or track record. Used to draft applications — not used for match scoring."
      },
      {
        "name": "unique_qualities",
        "label": "Unique qualities",
        "format": "prose",
        "scored": false,
        "help": "What makes the applicant or project unique. Used to draft applications — not used for match scoring."
      },
      {
        "name": "collaboration_partners",
        "label": "Collaboration partners",
        "format": "prose",
        "scored": false,
        "help": "Partner organizations or individuals. Used to draft applications — not used for match scoring."
      },
      {
        "name": "sustainability_plan",
        "label": "Sustainability plan",
        "format": "prose",
        "scored": false,
        "help": "Plan for sustaining the work beyond this grant. Used to draft applications — not used for match scoring."
      },
      {
        "name": "barriers_faced",
        "label": "Barriers faced",
        "format": "prose",
        "scored": false,
        "help": "Obstacles the applicant is navigating. Used to draft applications — not used for match scoring."
      },
      {
        "name": "special_circumstances",
        "label": "Special circumstances",
        "format": "prose",
        "scored": false,
        "help": "Any special circumstances that should inform the application. Used to draft applications — not used for match scoring."
      },
      {
        "name": "personal_statement",
        "label": "Personal statement",
        "format": "prose",
        "scored": false,
        "help": "Long-form personal statement or applicant story for applications. Used to draft applications — not used for match scoring."
      },
      {
        "name": "goals",
        "label": "Goals",
        "format": "prose",
        "scored": false,
        "help": "Long-form goals or outcomes the applicant is pursuing. Used to draft applications — not used for match scoring."
      },
      {
        "name": "needs_description",
        "label": "Needs description",
        "format": "prose",
        "scored": false,
        "help": "Long-form description of the funding need and barriers. Used to draft applications — not used for match scoring."
      },
      {
        "name": "focus_areas",
        "label": "Focus areas",
        "format": "tags",
        "vocabulary": "focus",
        "allow_custom": true,
        "help": "Focus areas relevant to the applicant or project. Choose from the suggested list; add a custom value only if none fit."
      },
      {
        "name": "supports",
        "label": "Support needs",
        "format": "tags",
        "vocabulary": "needs",
        "allow_custom": true,
        "help": "Support needs relevant to the applicant. Choose from the suggested list; add a custom value only if none fit."
      }
    ]
  },
  "essays": {
    "title": "Application essays",
    "description": "Long-form essays Hamilton uses to draft your applications. Editing these controls exactly what Hamilton writes from. Used for drafting only — not used for match scoring.",
    "fields": [
      {
        "name": "primary",
        "label": "Primary essay",
        "format": "prose",
        "scored": false,
        "help": "Your main application essay / applicant story. Hamilton grounds every draft in this. Used for drafting — not used for match scoring."
      },
      {
        "name": "personal_statement",
        "label": "Personal statement",
        "format": "prose",
        "scored": false,
        "help": "Long-form personal statement. Used for drafting — not used for match scoring."
      },
      {
        "name": "statement_of_need",
        "label": "Statement of need",
        "format": "prose",
        "scored": false,
        "help": "Why you need this funding, in your own words. Used for drafting — not used for match scoring."
      },
      {
        "name": "goals",
        "label": "Goals",
        "format": "prose",
        "scored": false,
        "help": "What you hope to achieve with this funding. Used for drafting — not used for match scoring."
      },
      {
        "name": "career_goals",
        "label": "Career goals",
        "format": "prose",
        "scored": false,
        "help": "Your longer-term career or organizational goals. Used for drafting — not used for match scoring."
      },
      {
        "name": "financial_hardship",
        "label": "Financial hardship",
        "format": "prose",
        "scored": false,
        "help": "Describe any financial hardship in your own words. Used for drafting — not used for match scoring."
      }
    ]
  }
}

export function getSectionTitle(key) {
  return SECTION_METADATA[key]?.title ?? String(key).replace(/_/g, ' ')
}

export function getSectionDescription(key) {
  return SECTION_METADATA[key]?.description ?? ''
}

export function getSectionFields(key) {
  return SECTION_METADATA[key]?.fields ?? []
}

export function getFieldHelp(sectionKey, fieldName) {
  return getSectionFields(sectionKey).find((f) => f.name === fieldName)?.help ?? ''
}

export const SECTION_KEYS = Object.keys(SECTION_METADATA)
