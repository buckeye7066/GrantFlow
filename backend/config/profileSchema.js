/**
 * Canonical profile schema (release-hardening)
 *
 * Goal:
 * - Define EVERY "comprehensive application" data point GrantFlow knows about
 * - Provide human-readable explanations for each data point
 * - Provide defaults so we can reliably "repair" profiles to include every key
 *
 * Notes:
 * - Sections are stored as JSON in `profile_sections.data`; adding keys is backwards compatible.
 * - Keep this file as the single source of truth; prompts, validation, and crawlers should derive from it.
 */
export const PROFILE_SCHEMA = {
  basic_information: {
    title: 'Basic Information',
    description: 'Primary contact and identity fields used for eligibility and communications.',
    fields: {
      full_name: { type: 'string', default: '', description: "Applicant or primary contact's full legal name." },
      email: { type: 'string', default: '', description: 'Primary email address for the applicant/primary contact.' },
      phone: { type: 'string', default: '', description: 'Primary phone number for the applicant/primary contact.' },
      website: { type: 'string', default: '', description: 'Website or online profile URL (org site, portfolio, etc.).' },
      address: { type: 'string', default: '', description: 'Mailing address (street + city/state/ZIP if available).' },
      city: { type: 'string', default: '', description: 'City of residence or primary organizational location.' },
      state: { type: 'string', default: '', description: '2-letter US state abbreviation (e.g., TN, CA) for eligibility filtering.' },
      zip: { type: 'string', default: '', description: '5-digit ZIP code for local/county/state eligibility and matching.' },
      date_of_birth: { type: 'string', default: '', description: 'Date of birth (YYYY-MM-DD) for age-based eligibility programs.' },
      age: { type: 'number|null', default: null, description: 'Age (in years) if DOB is unavailable; used for age-based eligibility.' },
      gender: { type: 'string', default: '', description: 'Gender identity when explicitly provided; used for women/men-focused programs.' },
      profile_category: {
        type: 'string',
        default: '',
        description:
          'High-level category for the applicant (e.g., individual_need, high_school_student, nonprofit, small_business).',
      },
      notes: { type: 'string', default: '', description: 'Freeform notes relevant to intake, context, and matching.' },
    },
  },

  organization_details: {
    title: 'Organization Details',
    description: 'Organization identifiers and capacity indicators used for nonprofit/small business eligibility.',
    fields: {
      organization_type: {
        type: 'string',
        default: '',
        description: 'Type of applicant organization (e.g., nonprofit, church, school, small business).',
      },
      ein: { type: 'string', default: '', description: 'Employer Identification Number (EIN) if applicable.' },
      uei: { type: 'string', default: '', description: 'Unique Entity Identifier (UEI) for SAM.gov / federal grants.' },
      cage_code: { type: 'string', default: '', description: 'CAGE code (federal contractor identifier) if applicable.' },
      annual_budget: { type: 'number|null', default: null, description: 'Annual operating budget (USD) if known.' },
      staff_count: { type: 'number|null', default: null, description: 'Number of staff (FTE or headcount) if known.' },
      mission: { type: 'string', default: '', description: 'Organization mission statement or concise purpose.' },
      notes: { type: 'string', default: '', description: 'Additional org context (service area, programs, awards, etc.).' },
    },
  },

  financial_information: {
    title: 'Financial Information',
    description: 'Household/financial need signals often required for assistance, scholarships, and hardship programs.',
    fields: {
      household_income: { type: 'number|null', default: null, description: 'Annual household income (USD) if known.' },
      household_size: { type: 'number|null', default: null, description: 'Number of people in the household (integer).' },
      financial_need_level: {
        type: 'string',
        default: '',
        description: 'Short descriptor of need (e.g., high, moderate, unknown).',
      },
      low_income: { type: 'boolean', default: false, description: 'True if the applicant is explicitly low-income.' },
      unemployed: { type: 'boolean', default: false, description: 'True if the applicant is explicitly unemployed.' },
      displaced_worker: {
        type: 'boolean',
        default: false,
        description: 'True if the applicant is a displaced worker (job loss/layoff) when explicitly stated.',
      },
      notes: { type: 'string', default: '', description: 'Concise context about income/need (max ~2 sentences).' },
    },
  },

  government_assistance: {
    title: 'Government Assistance',
    description: 'Public benefits (eligibility flags for many assistance programs).',
    fields: {
      medicaid_enrolled: { type: 'boolean', default: false, description: 'True if enrolled in Medicaid.' },
      medicare_recipient: { type: 'boolean', default: false, description: 'True if receiving Medicare.' },
      ssi_recipient: { type: 'boolean', default: false, description: 'True if receiving SSI.' },
      ssdi_recipient: { type: 'boolean', default: false, description: 'True if receiving SSDI.' },
      snap_recipient: { type: 'boolean', default: false, description: 'True if receiving SNAP (food stamps).' },
      tanf_recipient: { type: 'boolean', default: false, description: 'True if receiving TANF.' },
      section8_housing: { type: 'boolean', default: false, description: 'True if receiving Section 8 housing voucher.' },
      other_programs: {
        type: 'string',
        default: '',
        description: 'Comma-separated list of other benefits/programs (or leave blank).',
      },
    },
  },

  health_medical: {
    title: 'Health & Medical',
    description: 'Medical/health characteristics frequently used in assistance eligibility.',
    fields: {
      conditions: {
        type: 'array<object>',
        default: [],
        description:
          'List of health conditions (objects). Minimum shape: { name, icd10?, stage?, diagnosed_year? }. Informational only (no medical advice).',
      },
      chronic_illness: { type: 'boolean', default: false, description: 'True if chronic illness is explicitly stated.' },
      chronic_illness_type: { type: 'string', default: '', description: 'Type/name of chronic illness if provided.' },
      disability_type: {
        type: 'array<string>',
        default: [],
        description: 'List of disability types (strings) when explicitly stated.',
      },
      support_needs: {
        type: 'array<string>',
        default: [],
        description:
          'Support needs (strings). Examples: transportation, copay_assistance, lodging, caregiver_support, equipment, mental_health_support.',
      },
      support_needs_level: {
        type: 'string',
        default: '',
        description: 'Short descriptor of support needs (high/moderate/low/unknown).',
      },
      consent_for_studies: {
        type: 'boolean',
        default: false,
        description:
          'True if the user opts in to seeing research studies/trials they may be eligible to participate in.',
      },
      mobility_or_transport_notes: {
        type: 'string',
        default: '',
        description:
          'Optional notes about mobility or transportation needs for appointments (informational; no medical advice).',
      },
      dialysis_patient: { type: 'boolean', default: false, description: 'True if on dialysis.' },
      organ_transplant: { type: 'boolean', default: false, description: 'True if transplant recipient/candidate.' },
      hiv_aids: { type: 'boolean', default: false, description: 'True if HIV/AIDS is explicitly stated.' },
      tbi_survivor: { type: 'boolean', default: false, description: 'True if traumatic brain injury survivor.' },
      amputee: { type: 'boolean', default: false, description: 'True if amputee.' },
      neurodivergent: { type: 'boolean', default: false, description: 'True if neurodivergent (autism/ADHD/etc.) stated.' },
      visual_impairment: { type: 'boolean', default: false, description: 'True if visual impairment/blindness stated.' },
      hearing_impairment: { type: 'boolean', default: false, description: 'True if hearing impairment/deafness stated.' },
      wheelchair_user: { type: 'boolean', default: false, description: 'True if wheelchair user.' },
      substance_recovery: { type: 'boolean', default: false, description: 'True if in recovery/substance use recovery stated.' },
      mental_health_condition: { type: 'boolean', default: false, description: 'True if a mental health condition is stated.' },
      notes: { type: 'string', default: '', description: 'Brief medical context (<= ~3 sentences).' },
    },
  },

  medical_insurance: {
    title: 'Medical Insurance',
    description:
      'Insurance coverage details used for care coordination, assistance programs, and documentation (do not invent identifiers).',
    applies_to: ['medical_assistance', 'medical_need', 'individual_need', 'family', 'medical_assistance'],
    fields: {
      insurance_provider: {
        type: 'string',
        default: '',
        description: 'Primary insurance provider name (e.g., BlueCross, Aetna, Medicaid managed-care plan).',
      },
      plan_name: { type: 'string', default: '', description: 'Plan name (e.g., HMO/PPO plan name) if known.' },
      plan_type: { type: 'string', default: '', description: 'Plan type (e.g., HMO, PPO, Medicaid, Medicare, Marketplace).' },
      member_id: {
        type: 'string',
        default: '',
        description:
          'Member/Subscriber ID if explicitly provided in documents; leave blank if unknown (sensitive identifier).',
      },
      group_id: {
        type: 'string',
        default: '',
        description: 'Group ID if explicitly provided in documents; leave blank if unknown (sensitive identifier).',
      },
      policy_holder_name: { type: 'string', default: '', description: 'Name of policy holder when relevant.' },
      effective_date: { type: 'string', default: '', description: 'Coverage effective date (YYYY-MM-DD) if known.' },
      phone_for_claims: { type: 'string', default: '', description: 'Member services / claims phone number if known.' },
      notes: {
        type: 'string',
        default: '',
        description: 'High-level notes about coverage gaps, copays, prior auth needs, etc. (no fabricated details).',
      },
    },
  },

  medical_history: {
    title: 'Medical History & Needs',
    description:
      'Medical background needed to target condition-specific resources and support letters (avoid unnecessary PHI; keep concise).',
    applies_to: ['medical_assistance', 'medical_need', 'individual_need', 'family', 'medical_assistance'],
    fields: {
      primary_condition: { type: 'string', default: '', description: 'Primary condition/diagnosis when explicitly stated.' },
      secondary_conditions: {
        type: 'array<string>',
        default: [],
        description: 'Other conditions/diagnoses explicitly stated (strings).',
      },
      mobility_needs: {
        type: 'string',
        default: '',
        description: 'Mobility needs summary (e.g., wheelchair, walker, limited standing).',
      },
      dme_needed: {
        type: 'array<string>',
        default: [],
        description: 'Durable medical equipment needed (e.g., shower chair) when explicitly stated.',
      },
      doctor_name: { type: 'string', default: '', description: 'Primary clinician/doctor name if known.' },
      clinic_name: { type: 'string', default: '', description: 'Clinic/hospital name if known.' },
      letter_support_needed: {
        type: 'boolean',
        default: false,
        description: 'True if a letter of medical necessity / support letter is needed for coverage or assistance.',
      },
      notes: { type: 'string', default: '', description: 'Concise medical history context (<= ~5 sentences).' },
    },
  },

  nonprofit_compliance: {
    title: 'Nonprofit Compliance',
    description: 'Nonprofit compliance signals used for grant readiness and eligibility.',
    applies_to: ['nonprofit', 'organization'],
    fields: {
      is_501c3: { type: 'boolean', default: false, description: 'True if 501(c)(3) status is confirmed.' },
      fiscal_sponsor: { type: 'boolean', default: false, description: 'True if operating under a fiscal sponsor.' },
      fiscal_sponsor_name: { type: 'string', default: '', description: 'Fiscal sponsor name if applicable.' },
      sam_registered: { type: 'boolean', default: false, description: 'True if SAM.gov registration is confirmed.' },
      insurance_coverage: { type: 'string', default: '', description: 'General insurance coverage (GL, D&O) if known.' },
      compliance_notes: { type: 'string', default: '', description: 'Notes about audits, policies, and compliance gaps.' },
    },
  },

  small_business_details: {
    title: 'Small Business Details',
    description: 'Business details used for small business programs, certifications, and lending resources.',
    applies_to: ['small_business'],
    fields: {
      business_name: { type: 'string', default: '', description: 'Legal business name if different from profile name.' },
      naics_code: { type: 'string', default: '', description: 'NAICS code if known.' },
      years_in_business: { type: 'number|null', default: null, description: 'Years in business (integer) if known.' },
      employee_count: { type: 'number|null', default: null, description: 'Employee count if known.' },
      annual_revenue: { type: 'number|null', default: null, description: 'Annual revenue (USD) if known; null if unknown.' },
      certifications: {
        type: 'array<string>',
        default: [],
        description: 'Certifications (e.g., WOSB, HUBZone, MBE) when explicitly stated.',
      },
      notes: { type: 'string', default: '', description: 'Notes about products/services, capacity, and priorities.' },
    },
  },
  demographics: {
    title: 'Demographics',
    description: 'Demographic identifiers that unlock targeted funds and scholarships.',
    fields: {
      african_american: { type: 'boolean', default: false, description: 'True if Black/African American identity stated.' },
      hispanic_latino: { type: 'boolean', default: false, description: 'True if Hispanic/Latino identity stated.' },
      asian_american: { type: 'boolean', default: false, description: 'True if Asian/AAPI identity stated.' },
      native_american: { type: 'boolean', default: false, description: 'True if Native American/Indigenous identity stated.' },
      tribal_affiliation: { type: 'string', default: '', description: 'Tribal affiliation if specified.' },
      lgbtq: { type: 'boolean', default: false, description: 'True if LGBTQ+ identity stated.' },
      immigrant_status: {
        type: 'string',
        default: 'unknown',
        description: 'One of us_citizen, permanent_resident, refugee, undocumented, other, unknown.',
      },
      notes: { type: 'string', default: '', description: 'Additional demographic context (<= ~2 sentences).' },
    },
  },

  family_life: {
    title: 'Family & Life Situation',
    description: 'Life events and family status that drive eligibility for many programs.',
    fields: {
      single_parent: { type: 'boolean', default: false, description: 'True if single parent.' },
      foster_youth: { type: 'boolean', default: false, description: 'True if current/former foster youth.' },
      orphan: { type: 'boolean', default: false, description: 'True if orphan.' },
      adopted: { type: 'boolean', default: false, description: 'True if adopted.' },
      foster_parent: { type: 'boolean', default: false, description: 'True if foster parent.' },
      caregiver: { type: 'boolean', default: false, description: 'True if caregiver for someone else.' },
      widow_widower: { type: 'boolean', default: false, description: 'True if widowed.' },
      grandparent_raising_grandchildren: {
        type: 'boolean',
        default: false,
        description: 'True if grandparent raising grandchildren.',
      },
      first_time_parent: { type: 'boolean', default: false, description: 'True if first-time parent.' },
      homeless: { type: 'boolean', default: false, description: 'True if homeless/housing insecure.' },
      domestic_violence_survivor: { type: 'boolean', default: false, description: 'True if domestic violence survivor.' },
      trafficking_survivor: { type: 'boolean', default: false, description: 'True if human trafficking survivor.' },
      disaster_survivor: { type: 'boolean', default: false, description: 'True if disaster survivor (fire/flood/storm/etc.).' },
      formerly_incarcerated: { type: 'boolean', default: false, description: 'True if formerly incarcerated.' },
      notes: { type: 'string', default: '', description: 'Brief life situation context (<= ~2 sentences).' },
    },
  },

  military_service: {
    title: 'Military Status',
    description: 'Military affiliation flags used by veteran-specific and military family programs.',
    fields: {
      veteran: { type: 'boolean', default: false, description: 'True if veteran.' },
      active_duty_military: { type: 'boolean', default: false, description: 'True if active duty.' },
      national_guard: { type: 'boolean', default: false, description: 'True if National Guard.' },
      disabled_veteran: { type: 'boolean', default: false, description: 'True if disabled veteran.' },
      military_spouse: { type: 'boolean', default: false, description: 'True if military spouse.' },
      military_dependent: { type: 'boolean', default: false, description: 'True if military dependent/child.' },
      gold_star_family: { type: 'boolean', default: false, description: 'True if Gold Star family.' },
      notes: { type: 'string', default: '', description: 'Branch/years/disability rating context when relevant.' },
    },
  },

  occupation: {
    title: 'Occupation',
    description: 'Professional roles that unlock job-specific benefits and scholarships.',
    fields: {
      healthcare_worker: { type: 'boolean', default: false, description: 'True if healthcare worker.' },
      healthcare_worker_type: { type: 'string', default: '', description: 'Healthcare role type (e.g., RN, CNA).' },
      ems_worker: { type: 'boolean', default: false, description: 'True if EMS worker.' },
      educator: { type: 'boolean', default: false, description: 'True if educator/teacher.' },
      firefighter: { type: 'boolean', default: false, description: 'True if firefighter.' },
      law_enforcement: { type: 'boolean', default: false, description: 'True if law enforcement.' },
      public_servant: { type: 'boolean', default: false, description: 'True if public servant/government worker.' },
      clergy: { type: 'boolean', default: false, description: 'True if clergy.' },
      missionary: { type: 'boolean', default: false, description: 'True if missionary.' },
      nonprofit_employee: { type: 'boolean', default: false, description: 'True if nonprofit employee.' },
      small_business_owner: { type: 'boolean', default: false, description: 'True if small business owner.' },
      minority_owned_business: { type: 'boolean', default: false, description: 'True if minority-owned business.' },
      women_owned_business: { type: 'boolean', default: false, description: 'True if women-owned business.' },
      union_member: { type: 'boolean', default: false, description: 'True if union member.' },
      farmer: { type: 'boolean', default: false, description: 'True if farmer/agriculture.' },
      truck_driver: { type: 'boolean', default: false, description: 'True if truck driver.' },
      notes: { type: 'string', default: '', description: 'Other roles/certifications relevant to eligibility.' },
    },
  },

  location_focus: {
    title: 'Location Focus',
    description: 'Geographic qualifiers that impact location-scoped eligibility and matching.',
    fields: {
      rural_resident: { type: 'boolean', default: false, description: 'True if rural resident/served area is rural.' },
      appalachian_region: { type: 'boolean', default: false, description: 'True if in/serving Appalachia.' },
      urban_underserved: { type: 'boolean', default: false, description: 'True if in/serving an underserved urban area.' },
      geographic_focus: { type: 'string', default: '', description: 'Primary geography served or targeted.' },
      notes: { type: 'string', default: '', description: 'County/census tract/other location qualifiers.' },
    },
  },

  university_applications: {
    title: 'University Applications',
    description: 'Student college application tracking (for scholarship targeting).',
    fields: {
      applications: { type: 'array<object>', default: [], description: 'Array of tracked college applications and details.' },
    },
  },

  education: {
    title: 'Education',
    description: 'Academic history and student qualifiers used for scholarship eligibility.',
    fields: {
      highest_level: { type: 'string', default: '', description: 'Highest education level attained (freeform string).' },
      current_institution: { type: 'string', default: '', description: 'Current institution/school name.' },
      target_colleges: { type: 'array<string>', default: [], description: 'Target colleges/universities (strings).' },
      intended_major: { type: 'string', default: '', description: 'Intended major/program.' },
      gpa: { type: 'number|null', default: null, description: 'GPA when explicitly provided.' },
      act_score: { type: 'number|null', default: null, description: 'ACT score when explicitly provided.' },
      sat_score: { type: 'number|null', default: null, description: 'SAT score when explicitly provided.' },
      community_service_hours: { type: 'number|null', default: null, description: 'Community service hours when known.' },
      leadership_roles: { type: 'array<string>', default: [], description: 'Leadership roles (strings).' },
      valedictorian: { type: 'boolean', default: false, description: 'True if valedictorian (explicitly stated).' },
      notes: { type: 'string', default: '', description: 'Additional education context.' },
    },
  },

  employment: {
    title: 'Employment',
    description: 'Employment status and experience used for workforce/training program eligibility.',
    fields: {
      current_status: { type: 'string', default: '', description: 'Current employment status (freeform).' },
      career_goal: { type: 'string', default: '', description: 'Career goal (freeform).' },
      experience: { type: 'string', default: '', description: 'Brief experience summary (freeform).' },
      notes: { type: 'string', default: '', description: 'Additional employment context.' },
    },
  },

  housing: {
    title: 'Housing',
    description: 'Housing status and qualifiers relevant to assistance programs.',
    fields: {
      status: { type: 'string', default: '', description: 'Housing status (e.g., stable, at-risk, homeless, unknown).' },
      type: { type: 'string', default: '', description: 'Housing type (rent, own, shelter, transitional, etc.).' },
      address: { type: 'string', default: '', description: 'Housing address when explicitly provided.' },
      broadband_speed: { type: 'string', default: '', description: 'Broadband speed / connectivity details if relevant.' },
      geographic_designation: {
        type: 'array<string>',
        default: [],
        description: 'Geographic designations (e.g., rural/urban/frontier).',
      },
      notes: { type: 'string', default: '', description: 'Additional housing context.' },
    },
  },

  family: {
    title: 'Household Details',
    description: 'Household structure and support system (distinct from eligibility flags).',
    fields: {
      household_size: { type: 'number|null', default: null, description: 'Household size when known.' },
      responsibilities: { type: 'string', default: '', description: 'Primary household responsibilities/caregiving context.' },
      support_system: { type: 'string', default: '', description: 'Support system description.' },
      notes: { type: 'string', default: '', description: 'Additional household context.' },
    },
  },

  programs_services: {
    title: 'Programs & Services',
    description: 'Program focus areas, services, and keywords used for opportunity matching.',
    fields: {
      focus_areas: { type: 'array<string>', default: [], description: 'Focus areas (strings).' },
      interests: { type: 'array<string>', default: [], description: 'Interests (strings).' },
      keywords: { type: 'array<string>', default: [], description: 'Keywords/tags (strings).' },
      notes: { type: 'string', default: '', description: 'Additional program/service notes.' },
    },
  },

  narrative: {
    title: 'Story & Goals',
    description: 'Narrative fields that drive mission/fit matching and keyword extraction.',
    fields: {
      mission: { type: 'string', default: '', description: 'Mission statement or personal mission.' },
      primary_goal: { type: 'string', default: '', description: 'Primary goal of the applicant/project.' },
      target_population: { type: 'string', default: '', description: 'Who benefits from the work (population served).' },
      funding_amount_needed: { type: 'string', default: '', description: 'Requested/needed funding amount (numeric or descriptive).' },
      timeline: { type: 'string', default: '', description: 'Timeline for project/need.' },
      past_experience: { type: 'string', default: '', description: 'Past experience relevant to the request.' },
      unique_qualities: { type: 'string', default: '', description: 'Unique qualities/strengths.' },
      collaboration_partners: { type: 'string', default: '', description: 'Partner organizations/coalitions.' },
      sustainability_plan: { type: 'string', default: '', description: 'How work continues after funding.' },
      barriers_faced: { type: 'string', default: '', description: 'Barriers/challenges faced.' },
      special_circumstances: { type: 'string', default: '', description: 'Special circumstances that unlock eligibility.' },
    },
  },
}

export const supportedSectionKeys = Object.keys(PROFILE_SCHEMA)

export function getSectionSchema(sectionKey) {
  return PROFILE_SCHEMA[sectionKey] ?? null
}

export function getDefaultSectionData(sectionKey) {
  const schema = getSectionSchema(sectionKey)
  if (!schema) return {}
  const defaults = {}
  for (const [key, meta] of Object.entries(schema.fields ?? {})) {
    defaults[key] = meta?.default
  }
  return defaults
}

