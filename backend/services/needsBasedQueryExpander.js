/**
 * needsBasedQueryExpander.js
 *
 * Needs-Based Query Expander
 *
 * Reads the full profile context and generates compound queries that combine
 * multiple needs to discover programs the user wouldn't think to search for.
 * Includes a rule engine with 30+ situation→program mappings.
 *
 * @module needsBasedQueryExpander
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function isTruthy(v) {
  if (!v) return false
  if (typeof v === 'boolean') return v
  return String(v).toLowerCase().trim() === 'yes' || String(v).toLowerCase().trim() === 'true'
}

function includes(arr, term) {
  if (!Array.isArray(arr)) return false
  return arr.some((v) => String(v).toLowerCase().includes(term.toLowerCase()))
}

// ── Situation rule engine ──────────────────────────────────────────────────────

/**
 * @typedef {Object} SituationRule
 * @property {string} id - Unique rule identifier
 * @property {Object} conditions - Conditions to match against profile signals
 * @property {Object[]} programs - Programs to surface when conditions match
 */

/**
 * Each rule has:
 *   conditions.needs    — array of signal keyword substrings to match
 *   conditions.demographics — key/value checks against demographics section
 *   conditions.state    — optional 2-letter state abbreviation
 *   conditions.custom   — optional function (signals) => boolean for complex logic
 * All conditions are ANDed; array conditions are ORed internally.
 */

/** @type {SituationRule[]} */
const SITUATION_RULES = [
  // ── 1. Single parent + low income + children ─────────────────────────────
  {
    id: 'single_parent_low_income',
    conditions: {
      custom: (s) =>
        (s.family?.has('single_parent') || s.family?.has('single mother') || s.family?.has('single father')) &&
        s.financial?.below_poverty_line,
    },
    programs: [
      {
        name: 'TANF (Temporary Assistance for Needy Families)',
        searchQuery: 'TANF cash assistance single parent',
        description: 'Monthly cash assistance for single-parent families in financial need.',
        expectedProgramType: 'cash_assistance',
      },
      {
        name: 'CCDF Childcare Subsidy',
        searchQuery: 'CCDF childcare subsidy working parents low income',
        description: 'Subsidized childcare so parents can work or attend school.',
        expectedProgramType: 'childcare',
      },
      {
        name: 'Head Start / Early Head Start',
        searchQuery: 'Head Start early childhood program low income',
        description: 'Free preschool and family services for low-income children under 5.',
        expectedProgramType: 'childcare',
      },
    ],
  },

  // ── 2. Single parent + TN ─────────────────────────────────────────────────
  {
    id: 'single_parent_tennessee',
    conditions: {
      custom: (s) =>
        (s.family?.has('single_parent') || s.family?.has('single mother') || s.family?.has('single father')) &&
        (s.location?.state || '').toLowerCase() === 'tn',
    },
    programs: [
      {
        name: 'Tennessee Families First (TANF)',
        searchQuery: 'Tennessee Families First TANF single parent',
        description: 'TN state TANF program providing cash assistance and employment services.',
        expectedProgramType: 'cash_assistance',
      },
      {
        name: 'Tennessee Promise Scholarship',
        searchQuery: 'Tennessee Promise scholarship community college free tuition',
        description: 'Last-dollar scholarship covering tuition at TN community colleges.',
        expectedProgramType: 'scholarship',
      },
      {
        name: 'TN Child Care Certificate Program',
        searchQuery: 'Tennessee childcare certificate program subsidy',
        description: 'Childcare subsidies for working Tennessee families.',
        expectedProgramType: 'childcare',
      },
    ],
  },

  // ── 3. Veteran + housing instability ────────────────────────────────────
  {
    id: 'veteran_housing',
    conditions: {
      custom: (s) =>
        (s.military?.size > 0 || s.demographics?.has('veteran')) &&
        (s.assistance?.has('housing') || s.keywords?.includes('homeless') || s.keywords?.includes('eviction')),
    },
    programs: [
      {
        name: 'HUD-VASH (Supportive Housing for Veterans)',
        searchQuery: 'HUD-VASH veteran housing voucher homeless',
        description: 'Combines HCV vouchers with VA case management for homeless veterans.',
        expectedProgramType: 'housing_assistance',
      },
      {
        name: 'SSVF (Supportive Services for Veteran Families)',
        searchQuery: 'SSVF supportive services veteran families housing',
        description: 'Rapid rehousing and homelessness prevention for very-low-income veteran households.',
        expectedProgramType: 'housing_assistance',
      },
      {
        name: 'VA Homeless Veterans Programs',
        searchQuery: 'VA homeless veteran outreach programs',
        description: 'VA outreach, case management, and residential treatment for homeless veterans.',
        expectedProgramType: 'housing_assistance',
      },
    ],
  },

  // ── 4. Veteran + disability ──────────────────────────────────────────────
  {
    id: 'veteran_disability',
    conditions: {
      custom: (s) =>
        (s.military?.size > 0 || s.demographics?.has('veteran')) &&
        (s.demographics?.has('disability') || s.health?.size > 0),
    },
    programs: [
      {
        name: 'VA Disability Compensation',
        searchQuery: 'VA disability compensation service-connected',
        description: 'Monthly payments for veterans with disabilities connected to military service.',
        expectedProgramType: 'disability_benefits',
      },
      {
        name: 'VA Vocational Rehabilitation (VR&E)',
        searchQuery: 'VA vocational rehabilitation employment veteran',
        description: 'Employment services and education benefits for disabled veterans.',
        expectedProgramType: 'workforce_development',
      },
    ],
  },

  // ── 5. Foster youth + education ──────────────────────────────────────────
  {
    id: 'foster_youth_education',
    conditions: {
      custom: (s) => s.family?.has('foster') || s.keywords?.includes('foster care'),
    },
    programs: [
      {
        name: 'Chafee Education and Training Vouchers (ETV)',
        searchQuery: 'Chafee Education Training Voucher foster care youth',
        description: 'Up to $5,000/year for postsecondary education for current/former foster youth.',
        expectedProgramType: 'scholarship',
      },
      {
        name: 'Extended Foster Care (18-21)',
        searchQuery: 'extended foster care 18 21 aging out services',
        description: 'Continued housing and support services for youth aging out of foster care.',
        expectedProgramType: 'youth_services',
      },
      {
        name: 'Guardian Scholars Program',
        searchQuery: 'Guardian Scholars foster youth college scholarships',
        description: 'Campus-based scholarship and support programs for foster care alumni in college.',
        expectedProgramType: 'scholarship',
      },
    ],
  },

  // ── 6. Low income + school-age children + TN ────────────────────────────
  {
    id: 'low_income_children_tennessee',
    conditions: {
      custom: (s) =>
        s.financial?.below_poverty_line &&
        (s.family?.has('children') || s.family?.has('school')) &&
        (s.location?.state || '').toLowerCase() === 'tn',
    },
    programs: [
      {
        name: 'Tennessee CCDF Child Care Certificate',
        searchQuery: 'Tennessee CCDF child care certificate program',
        description: 'State childcare subsidies for working/training Tennessee parents.',
        expectedProgramType: 'childcare',
      },
      {
        name: 'Nashville Afterschool Programs',
        searchQuery: 'afterschool programs Nashville Tennessee low income',
        description: 'Free or reduced afterschool care and tutoring for Nashville-area children.',
        expectedProgramType: 'youth_services',
      },
      {
        name: 'TN SNAP Education & Training',
        searchQuery: 'Tennessee SNAP education training program',
        description: 'Skills training and education for SNAP recipients.',
        expectedProgramType: 'workforce_development',
      },
    ],
  },

  // ── 7. Disability + employment ───────────────────────────────────────────
  {
    id: 'disability_employment',
    conditions: {
      custom: (s) =>
        (s.demographics?.has('disability') || s.health?.size > 0) &&
        (s.occupation?.size > 0 || s.keywords?.includes('employment') || s.keywords?.includes('work')),
    },
    programs: [
      {
        name: 'Vocational Rehabilitation Services',
        searchQuery: 'vocational rehabilitation disability employment services',
        description: 'Free employment counseling, training, and job placement for people with disabilities.',
        expectedProgramType: 'workforce_development',
      },
      {
        name: 'Ticket to Work Program',
        searchQuery: 'Social Security Ticket to Work disability employment',
        description: 'SSA program helping disability beneficiaries return to work without losing benefits.',
        expectedProgramType: 'workforce_development',
      },
      {
        name: 'ABLE Account (Achieving a Better Life Experience)',
        searchQuery: 'ABLE account disability savings tax-free',
        description: 'Tax-advantaged savings accounts for people with disabilities.',
        expectedProgramType: 'financial_assistance',
      },
    ],
  },

  // ── 8. Low income + utilities burden ─────────────────────────────────────
  {
    id: 'low_income_utilities',
    conditions: {
      custom: (s) =>
        s.financial?.below_poverty_line &&
        (s.assistance?.has('utility') || s.assistance?.has('energy') || s.keywords?.includes('heat')),
    },
    programs: [
      {
        name: 'LIHEAP (Home Energy Assistance)',
        searchQuery: 'LIHEAP home energy assistance program heating cooling',
        description: 'Federal program to help pay home heating and cooling costs.',
        expectedProgramType: 'utility_assistance',
      },
      {
        name: 'Weatherization Assistance Program (WAP)',
        searchQuery: 'weatherization assistance program energy efficiency low income',
        description: 'Free home weatherization to reduce energy bills for low-income households.',
        expectedProgramType: 'home_improvement',
      },
    ],
  },

  // ── 9. Senior (65+) + low income ─────────────────────────────────────────
  {
    id: 'senior_low_income',
    conditions: {
      custom: (s) =>
        (s.demographics?.has('senior') || s.demographics?.has('elderly') || s.demographics?.has('65')) &&
        s.financial?.below_poverty_line,
    },
    programs: [
      {
        name: 'SCSEP (Senior Community Service Employment Program)',
        searchQuery: 'SCSEP senior community service employment program',
        description: 'Paid community service and job training for low-income adults 55+.',
        expectedProgramType: 'employment',
      },
      {
        name: 'Extra Help (LIS) — Medicare Prescription Costs',
        searchQuery: 'Medicare Extra Help Low Income Subsidy prescription costs',
        description: 'Helps pay Medicare Part D prescription drug costs for low-income beneficiaries.',
        expectedProgramType: 'healthcare_assistance',
      },
      {
        name: 'Supplemental Security Income (SSI)',
        searchQuery: 'SSI supplemental security income elderly disabled',
        description: 'Monthly federal payments for seniors 65+ or disabled people with limited resources.',
        expectedProgramType: 'cash_assistance',
      },
    ],
  },

  // ── 10. Pregnant / new mother + low income ───────────────────────────────
  {
    id: 'pregnant_low_income',
    conditions: {
      custom: (s) =>
        (s.family?.has('pregnant') || s.demographics?.has('pregnant') || s.family?.has('newborn')) &&
        s.financial?.below_poverty_line,
    },
    programs: [
      {
        name: 'WIC (Women, Infants, and Children)',
        searchQuery: 'WIC nutrition benefits pregnant low income',
        description: 'Nutrition benefits and health referrals for pregnant women and children under 5.',
        expectedProgramType: 'nutrition_assistance',
      },
      {
        name: 'Healthy Start Program',
        searchQuery: 'Healthy Start program prenatal care low income',
        description: 'HRSA-funded prenatal and infant care for high-risk communities.',
        expectedProgramType: 'healthcare_assistance',
      },
      {
        name: 'Medicaid for Pregnant Women',
        searchQuery: 'Medicaid pregnant women prenatal coverage income',
        description: 'Medicaid expansion often covers pregnancy at higher income thresholds (up to 185–200% FPL).',
        expectedProgramType: 'healthcare_assistance',
      },
    ],
  },

  // ── 11. Immigrant / refugee ───────────────────────────────────────────────
  {
    id: 'immigrant_refugee',
    conditions: {
      custom: (s) =>
        s.immigration?.size > 0 ||
        s.demographics?.has('immigrant') ||
        s.demographics?.has('refugee') ||
        s.demographics?.has('daca'),
    },
    programs: [
      {
        name: 'Refugee Cash Assistance (RCA)',
        searchQuery: 'refugee cash assistance RCA resettlement',
        description: 'Short-term cash and medical assistance for newly arrived refugees.',
        expectedProgramType: 'cash_assistance',
      },
      {
        name: 'TheDream.US Scholarship (DACA)',
        searchQuery: 'TheDream.US scholarship DACA undocumented students',
        description: 'College scholarships for DREAMers with DACA status.',
        expectedProgramType: 'scholarship',
      },
      {
        name: 'IRC (International Rescue Committee) Services',
        searchQuery: 'IRC International Rescue Committee immigrant services',
        description: 'Resettlement, employment, and financial assistance for immigrants and refugees.',
        expectedProgramType: 'social_services',
      },
    ],
  },

  // ── 12. Re-entry / formerly incarcerated ────────────────────────────────
  {
    id: 'reentry_formerly_incarcerated',
    conditions: {
      custom: (s) =>
        s.keywords?.includes('reentry') ||
        s.keywords?.includes('incarcerated') ||
        s.keywords?.includes('formerly incarcerated') ||
        s.keywords?.includes('criminal record') ||
        s.keywords?.includes('second chance'),
    },
    programs: [
      {
        name: 'Second Chance Act Reentry Grants',
        searchQuery: 'Second Chance Act reentry employment housing',
        description: 'Federal grants for reentry services, employment, and housing for returning citizens.',
        expectedProgramType: 'reentry',
      },
      {
        name: 'Pell Grant Restoration (BOP incarcerated)',
        searchQuery: 'Pell grant restoration incarcerated students Second Chance Pell',
        description: 'Federal Pell Grant eligibility restored for currently incarcerated individuals.',
        expectedProgramType: 'scholarship',
      },
    ],
  },

  // ── 13. Domestic violence survivor ──────────────────────────────────────
  {
    id: 'domestic_violence',
    conditions: {
      custom: (s) =>
        s.family?.has('domestic violence') || s.family?.has('dv survivor') || s.keywords?.includes('domestic violence'),
    },
    programs: [
      {
        name: 'VAWA (Violence Against Women Act) Services',
        searchQuery: 'VAWA domestic violence shelter legal advocacy',
        description: 'Emergency shelter, legal aid, and services for domestic violence survivors.',
        expectedProgramType: 'emergency_services',
      },
      {
        name: 'FVPSA (Family Violence Prevention Services)',
        searchQuery: 'FVPSA family violence prevention shelter',
        description: 'Emergency shelter and support services for victims of family violence.',
        expectedProgramType: 'emergency_services',
      },
    ],
  },

  // ── 14. Caregiver + elderly or disabled family member ───────────────────
  {
    id: 'caregiver',
    conditions: {
      custom: (s) =>
        s.occupation?.has('caregiver') ||
        s.keywords?.includes('caregiver') ||
        s.occupation?.has('family caregiver'),
    },
    programs: [
      {
        name: 'National Family Caregiver Support Program (NFCSP)',
        searchQuery: 'National Family Caregiver Support Program NFCSP respite',
        description: 'Respite care, information, and support for family caregivers of older adults.',
        expectedProgramType: 'caregiver_support',
      },
      {
        name: 'LISG (Lifespan Respite Care Program)',
        searchQuery: 'Lifespan Respite Care Program caregiver relief',
        description: 'Grants for temporary relief (respite) for caregivers of individuals with disabilities.',
        expectedProgramType: 'caregiver_support',
      },
    ],
  },

  // ── 15. Student loan debt + low income ──────────────────────────────────
  {
    id: 'student_loan_low_income',
    conditions: {
      custom: (s) =>
        (s.education?.degree_level || s.keywords?.includes('student loan')) && s.financial?.below_poverty_line,
    },
    programs: [
      {
        name: 'Income-Driven Repayment (IDR) Plans',
        searchQuery: 'student loan income driven repayment plan SAVE IDR',
        description: 'Federal student loan repayment capped at percentage of discretionary income.',
        expectedProgramType: 'loan_forgiveness',
      },
      {
        name: 'Public Service Loan Forgiveness (PSLF)',
        searchQuery: 'Public Service Loan Forgiveness PSLF government nonprofit',
        description: 'Student loan forgiveness after 10 years of payments in public service.',
        expectedProgramType: 'loan_forgiveness',
      },
    ],
  },

  // ── 16. Small business + minority owned ─────────────────────────────────
  {
    id: 'minority_small_business',
    conditions: {
      custom: (s) =>
        (s.organization?.type === 'small_business' ||
          s.occupation?.has('small business') ||
          s.occupation?.has('entrepreneur')) &&
        (s.demographics?.has('minority') ||
          s.demographics?.has('black') ||
          s.demographics?.has('hispanic') ||
          s.demographics?.has('asian') ||
          s.demographics?.has('native american')),
    },
    programs: [
      {
        name: 'MBDA Business Center (Minority Business Development Agency)',
        searchQuery: 'MBDA minority business development grants loans',
        description: 'Federal agency supporting minority-owned businesses with grants, loans, and technical assistance.',
        expectedProgramType: 'business_grant',
      },
      {
        name: 'SBA 8(a) Business Development Program',
        searchQuery: 'SBA 8a business development program minority',
        description: 'Federal contracting preference program for small disadvantaged businesses.',
        expectedProgramType: 'business_development',
      },
    ],
  },

  // ── 17. Rural + agriculture ──────────────────────────────────────────────
  {
    id: 'rural_agriculture',
    conditions: {
      custom: (s) =>
        s.geographic?.has('rural') ||
        s.keywords?.includes('farm') ||
        s.keywords?.includes('agriculture') ||
        s.keywords?.includes('rural'),
    },
    programs: [
      {
        name: 'USDA Beginning Farmer Loans and Grants',
        searchQuery: 'USDA beginning farmer rancher grants loans FSA',
        description: 'Low-interest loans and grants for beginning farmers and ranchers.',
        expectedProgramType: 'agriculture_grant',
      },
      {
        name: 'USDA Rural Development Business Grants',
        searchQuery: 'USDA rural development business grant Tennessee',
        description: 'Grants to develop rural economies and create jobs in rural communities.',
        expectedProgramType: 'business_grant',
      },
    ],
  },

  // ── 18. High school student + college-bound + TN ─────────────────────────
  {
    id: 'high_school_college_bound_tennessee',
    conditions: {
      custom: (s) =>
        (s.applicantType?.has('high_school_student') || s.applicantType?.has('student')) &&
        (s.location?.state || '').toLowerCase() === 'tn',
    },
    programs: [
      {
        name: 'Tennessee Promise',
        searchQuery: 'Tennessee Promise free community college scholarship',
        description: 'Last-dollar scholarship for TN high school graduates to attend community college free.',
        expectedProgramType: 'scholarship',
      },
      {
        name: 'Tennessee Student Assistance Awards (TSAA)',
        searchQuery: 'Tennessee Student Assistance Award TSAA need based',
        description: 'Need-based grant for TN residents attending TN colleges.',
        expectedProgramType: 'scholarship',
      },
      {
        name: 'Tennessee Reconnect',
        searchQuery: 'Tennessee Reconnect adult learner community college',
        description: 'Free community college for Tennessee adults without a degree.',
        expectedProgramType: 'scholarship',
      },
    ],
  },

  // ── 19. Unemployed + job seeker ──────────────────────────────────────────
  {
    id: 'unemployed_job_seeker',
    conditions: {
      custom: (s) =>
        s.occupation?.has('unemployed') ||
        s.keywords?.includes('unemployed') ||
        s.keywords?.includes('job seeker') ||
        s.keywords?.includes('laid off'),
    },
    programs: [
      {
        name: 'WIOA Workforce Innovation (Dislocated Workers)',
        searchQuery: 'WIOA workforce innovation opportunity dislocated worker training',
        description: 'Free job training, career counseling, and employment services for unemployed workers.',
        expectedProgramType: 'workforce_development',
      },
      {
        name: 'Trade Adjustment Assistance (TAA)',
        searchQuery: 'Trade Adjustment Assistance TAA job loss imports',
        description: 'Federal assistance for workers who lost jobs due to foreign trade.',
        expectedProgramType: 'workforce_development',
      },
    ],
  },

  // ── 20. Homelessness / at risk of eviction ───────────────────────────────
  {
    id: 'housing_instability',
    conditions: {
      custom: (s) =>
        s.assistance?.has('housing') ||
        s.keywords?.includes('homeless') ||
        s.keywords?.includes('eviction') ||
        s.keywords?.includes('housing unstable'),
    },
    programs: [
      {
        name: 'Emergency Rental Assistance (ERA)',
        searchQuery: 'emergency rental assistance program eviction prevention',
        description: 'Direct rental and utility assistance to prevent eviction for low-income households.',
        expectedProgramType: 'rental_assistance',
      },
      {
        name: 'CoC Continuum of Care Homeless Grants',
        searchQuery: 'CoC Continuum of Care homeless assistance grant',
        description: 'HUD grants for permanent supportive housing and transitional housing programs.',
        expectedProgramType: 'housing_assistance',
      },
      {
        name: 'ESG (Emergency Solutions Grant)',
        searchQuery: 'ESG Emergency Solutions Grant shelter outreach',
        description: 'Rapid rehousing, emergency shelter, and homelessness prevention funding.',
        expectedProgramType: 'housing_assistance',
      },
    ],
  },

  // ── 21. Youth (13-24) + at-risk ──────────────────────────────────────────
  {
    id: 'at_risk_youth',
    conditions: {
      custom: (s) =>
        s.applicantType?.has('youth') ||
        s.keywords?.includes('at-risk youth') ||
        s.keywords?.includes('runaway') ||
        s.keywords?.includes('youth homelessness'),
    },
    programs: [
      {
        name: 'Runaway and Homeless Youth Act (RHYA) Programs',
        searchQuery: 'Runaway Homeless Youth Act shelter basic center',
        description: 'Emergency shelters, transitional living, and street outreach for runaway youth.',
        expectedProgramType: 'youth_services',
      },
      {
        name: 'YouthBuild',
        searchQuery: 'YouthBuild program construction training GED',
        description: 'Job training and education for low-income youth 16-24 who dropped out of school.',
        expectedProgramType: 'workforce_development',
      },
    ],
  },

  // ── 22. Food insecurity ───────────────────────────────────────────────────
  {
    id: 'food_insecurity',
    conditions: {
      custom: (s) =>
        s.assistance?.has('food') ||
        s.keywords?.includes('food insecurity') ||
        s.keywords?.includes('hunger') ||
        s.keywords?.includes('food bank'),
    },
    programs: [
      {
        name: 'SNAP (Supplemental Nutrition Assistance)',
        searchQuery: 'SNAP food stamps supplemental nutrition assistance',
        description: 'Monthly food benefits for low-income households.',
        expectedProgramType: 'nutrition_assistance',
      },
      {
        name: 'TEFAP (Emergency Food Assistance Program)',
        searchQuery: 'TEFAP emergency food assistance program food bank',
        description: 'Free USDA foods distributed through food banks to low-income households.',
        expectedProgramType: 'nutrition_assistance',
      },
    ],
  },

  // ── 23. Medical debt / uninsured ─────────────────────────────────────────
  {
    id: 'medical_debt_uninsured',
    conditions: {
      custom: (s) =>
        s.health?.size > 0 &&
        (s.keywords?.includes('uninsured') ||
          s.keywords?.includes('medical debt') ||
          s.keywords?.includes('no insurance')),
    },
    programs: [
      {
        name: 'Hill-Burton Free Hospital Care',
        searchQuery: 'Hill-Burton free hospital care low income uninsured',
        description: 'Hospitals that received federal funding must provide free or reduced-cost care.',
        expectedProgramType: 'healthcare_assistance',
      },
      {
        name: 'Federally Qualified Health Centers (FQHC)',
        searchQuery: 'FQHC federally qualified health center sliding scale',
        description: 'Community health centers offering sliding-scale fees based on income.',
        expectedProgramType: 'healthcare_assistance',
      },
    ],
  },

  // ── 24. Substance use / addiction recovery ────────────────────────────────
  {
    id: 'substance_use_recovery',
    conditions: {
      custom: (s) =>
        s.keywords?.includes('recovery') ||
        s.keywords?.includes('substance use') ||
        s.keywords?.includes('addiction') ||
        s.keywords?.includes('sobriety'),
    },
    programs: [
      {
        name: 'SAMHSA Substance Use Treatment Locator',
        searchQuery: 'SAMHSA substance use disorder treatment grants',
        description: 'Federal funding for substance use prevention, treatment, and recovery services.',
        expectedProgramType: 'healthcare_assistance',
      },
      {
        name: 'Recovery Housing Programs',
        searchQuery: 'recovery housing sober living low income transitional',
        description: 'Supportive housing for individuals in substance use recovery.',
        expectedProgramType: 'housing_assistance',
      },
    ],
  },

  // ── 25. Low income + broadband / digital divide ──────────────────────────
  {
    id: 'digital_divide',
    conditions: {
      custom: (s) =>
        s.financial?.below_poverty_line &&
        (s.keywords?.includes('internet') ||
          s.keywords?.includes('broadband') ||
          s.keywords?.includes('digital')),
    },
    programs: [
      {
        name: 'ACP (Affordable Connectivity Program)',
        searchQuery: 'Affordable Connectivity Program broadband discount internet',
        description: 'Up to $30/month discount on internet service for low-income households.',
        expectedProgramType: 'utility_assistance',
      },
      {
        name: 'Lifeline Phone/Internet Discount',
        searchQuery: 'Lifeline phone internet discount low income',
        description: 'FCC program providing discounts on phone and internet service.',
        expectedProgramType: 'utility_assistance',
      },
    ],
  },

  // ── 26. Non-English speaking + language barrier ──────────────────────────
  {
    id: 'language_barrier',
    conditions: {
      custom: (s) =>
        s.immigration?.size > 0 ||
        s.keywords?.includes('spanish') ||
        s.keywords?.includes('non-english') ||
        s.keywords?.includes('ESL'),
    },
    programs: [
      {
        name: 'Adult ESL and Literacy Programs',
        searchQuery: 'ESL adult literacy English language learner grants',
        description: 'Free English as a Second Language classes funded by federal Adult Education Act.',
        expectedProgramType: 'education',
      },
      {
        name: 'Language Access Services (Title VI)',
        searchQuery: 'Title VI language access services interpretation',
        description: 'Federally required free interpretation services for limited-English speakers.',
        expectedProgramType: 'social_services',
      },
    ],
  },

  // ── 27. Nonprofit organization + capacity building ───────────────────────
  {
    id: 'nonprofit_capacity',
    conditions: {
      custom: (s) =>
        s.organization?.type === 'nonprofit' ||
        s.applicantType?.has('nonprofit') ||
        s.applicantType?.has('organization'),
    },
    programs: [
      {
        name: 'AmeriCorps VISTA Volunteers',
        searchQuery: 'AmeriCorps VISTA volunteer capacity building nonprofit',
        description: 'Assign VISTA volunteers to build nonprofit capacity and end poverty.',
        expectedProgramType: 'capacity_building',
      },
      {
        name: 'TechSoup Technology Grants for Nonprofits',
        searchQuery: 'TechSoup nonprofit technology grants software',
        description: 'Discounted software and technology grants for eligible nonprofits.',
        expectedProgramType: 'technology',
      },
    ],
  },

  // ── 28. Mental health + low income ──────────────────────────────────────
  {
    id: 'mental_health_low_income',
    conditions: {
      custom: (s) =>
        (s.health?.has('mental health') || s.keywords?.includes('mental health')) &&
        s.financial?.below_poverty_line,
    },
    programs: [
      {
        name: 'Community Mental Health Center (CMHC) Sliding Scale',
        searchQuery: 'community mental health center sliding scale low income',
        description: 'Publicly funded mental health centers offering reduced-cost therapy.',
        expectedProgramType: 'healthcare_assistance',
      },
      {
        name: 'PATH (Projects for Assistance in Transition from Homelessness)',
        searchQuery: 'PATH program mental illness homelessness assistance',
        description: 'Outreach and services for homeless individuals with serious mental illness.',
        expectedProgramType: 'healthcare_assistance',
      },
    ],
  },

  // ── 29. College student + financial need ─────────────────────────────────
  {
    id: 'college_student_financial_need',
    conditions: {
      custom: (s) =>
        (s.applicantType?.has('college_student') || s.applicantType?.has('student')) &&
        s.financial?.below_poverty_line,
    },
    programs: [
      {
        name: 'Federal Supplemental Educational Opportunity Grant (SEOG)',
        searchQuery: 'SEOG supplemental educational opportunity grant college',
        description: 'Additional grant up to $4,000/year for college students with exceptional financial need.',
        expectedProgramType: 'scholarship',
      },
      {
        name: 'College Emergency Funds',
        searchQuery: 'college emergency fund basic needs crisis grant',
        description: 'Campus-based emergency grants for students facing unexpected financial crises.',
        expectedProgramType: 'emergency_assistance',
      },
    ],
  },

  // ── 30. Child with special needs + IDD ──────────────────────────────────
  {
    id: 'child_special_needs',
    conditions: {
      custom: (s) =>
        s.family?.has('special needs') ||
        s.keywords?.includes('idd') ||
        s.keywords?.includes('intellectual disability') ||
        s.keywords?.includes('autism'),
    },
    programs: [
      {
        name: 'ABLE Account (Special Needs Savings)',
        searchQuery: 'ABLE account special needs savings disability',
        description: 'Tax-free savings accounts for individuals with disabilities diagnosed before age 26.',
        expectedProgramType: 'financial_assistance',
      },
      {
        name: 'IDEA (Individuals with Disabilities Education Act)',
        searchQuery: 'IDEA special education services IEP disability rights',
        description: 'Free appropriate public education and related services for students with disabilities.',
        expectedProgramType: 'education',
      },
      {
        name: 'Medicaid Home and Community-Based Services (HCBS)',
        searchQuery: 'Medicaid HCBS waiver home community based services',
        description: 'Medicaid waivers funding in-home services for individuals with IDD.',
        expectedProgramType: 'healthcare_assistance',
      },
    ],
  },

  // ── 31. Veteran + education ───────────────────────────────────────────────
  {
    id: 'veteran_education',
    conditions: {
      custom: (s) =>
        (s.military?.size > 0 || s.demographics?.has('veteran')) &&
        (s.applicantType?.has('student') || s.keywords?.includes('education') || s.keywords?.includes('college')),
    },
    programs: [
      {
        name: "Post-9/11 GI Bill (Chapter 33)",
        searchQuery: 'Post-9/11 GI Bill veteran tuition housing allowance',
        description: 'Up to 100% tuition, fees, and housing allowance for veterans and dependents.',
        expectedProgramType: 'scholarship',
      },
      {
        name: 'Scholarships for Military Children',
        searchQuery: 'scholarships military children dependent education',
        description: 'Fisher House / commissary scholarships for dependent children of military members.',
        expectedProgramType: 'scholarship',
      },
    ],
  },

  // ── 32. HIV/AIDS + financial need ────────────────────────────────────────
  {
    id: 'hiv_aids',
    conditions: {
      custom: (s) =>
        s.health?.has('hiv') ||
        s.health?.has('aids') ||
        s.keywords?.includes('hiv') ||
        s.keywords?.includes('aids'),
    },
    programs: [
      {
        name: 'Ryan White HIV/AIDS Program',
        searchQuery: 'Ryan White HIV AIDS program medical care housing',
        description: 'Federal funding for HIV-related medical care, medications, and support services.',
        expectedProgramType: 'healthcare_assistance',
      },
    ],
  },
]

// ── Signal extraction ─────────────────────────────────────────────────────────

/**
 * Extract the signals object from a profileContext.
 * Normalizes Sets and arrays for consistent access in condition checks.
 */
function extractSignals(profileContext) {
  if (!profileContext) return {}
  const signals = profileContext.signals || {}
  const sections = profileContext.sections || {}
  const financial = sections.financial_information || sections.financial || {}

  // Merge section-level signals for condition checking
  return {
    ...signals,
    keywords: new Set(
      [
        ...(Array.isArray(signals.keywords) ? signals.keywords : []),
        ...Object.values(sections).flatMap((s) =>
          typeof s === 'object' && s !== null
            ? Object.values(s).flatMap((v) => (typeof v === 'string' ? [v.toLowerCase()] : []))
            : [],
        ),
      ].map((v) => v.toLowerCase()),
    ),
    financial: {
      ...signals.financial,
      below_poverty_line:
        financial.below_poverty_line === true ||
        financial.below_poverty_line === 'yes' ||
        (financial.income_percentage_fpl && parseInt(financial.income_percentage_fpl) <= 200) ||
        false,
    },
    // Ensure Set-based fields from buildProfileSignals remain intact
    family: signals.family instanceof Set ? signals.family : new Set(signals.family || []),
    demographics: signals.demographics instanceof Set ? signals.demographics : new Set(signals.demographics || []),
    military: signals.military instanceof Set ? signals.military : new Set(signals.military || []),
    health: signals.health instanceof Set ? signals.health : new Set(signals.health || []),
    occupation: signals.occupation instanceof Set ? signals.occupation : new Set(signals.occupation || []),
    immigration: signals.immigration instanceof Set ? signals.immigration : new Set(signals.immigration || []),
    geographic: signals.geographic instanceof Set ? signals.geographic : new Set(signals.geographic || []),
    assistance: signals.assistance instanceof Set ? signals.assistance : new Set(signals.assistance || []),
    applicantType: signals.applicantTypes instanceof Set ? signals.applicantTypes : new Set(signals.applicantTypes || []),
    location: signals.location || {},
    organization: signals.organization || {},
  }
}

// ── Main exports ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ExpandedQuery
 * @property {string} query
 * @property {string} source - Program name
 * @property {string} reason - Why this query was generated
 * @property {string} expectedProgramType
 */

/**
 * @typedef {Object} SituationMatch
 * @property {string} ruleId
 * @property {string} description
 * @property {ExpandedQuery[]} queries
 */

/**
 * Expand queries based on profile needs and situations.
 *
 * @param {Object} profileContext - Full profile context ({ profile, sections, signals })
 * @returns {{ queries: ExpandedQuery[], situationMatches: SituationMatch[] }}
 */
export function expandNeedsQueries(profileContext) {
  if (!profileContext) return { queries: [], situationMatches: [] }

  const signals = extractSignals(profileContext)
  const situationMatches = []
  const allQueries = []

  for (const rule of SITUATION_RULES) {
    let matched = false
    try {
      matched = rule.conditions.custom ? rule.conditions.custom(signals) : false
    } catch {
      matched = false
    }

    if (!matched) continue

    const queries = rule.programs.map((program) => ({
      query: program.searchQuery,
      source: program.name,
      reason: `Matched situation rule: ${rule.id}`,
      expectedProgramType: program.expectedProgramType,
    }))

    situationMatches.push({
      ruleId: rule.id,
      description: rule.programs.map((p) => p.name).join(', '),
      queries,
    })

    allQueries.push(...queries)
  }

  // Deduplicate queries by query string
  const seen = new Set()
  const uniqueQueries = allQueries.filter((q) => {
    if (seen.has(q.query)) return false
    seen.add(q.query)
    return true
  })

  return { queries: uniqueQueries, situationMatches }
}

// ── Standalone CLI entrypoint ─────────────────────────────────────────────────
// Run: node backend/services/needsBasedQueryExpander.js

if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].includes('needsBasedQueryExpander')
) {
  const demoContext = {
    profile: { primary_type: 'individual', state: 'tn' },
    sections: {
      financial_information: { below_poverty_line: true },
      family_life: { single_parent: 'yes', number_of_children: 2 },
    },
    signals: {
      keywords: ['housing', 'food', 'single parent'],
      family: new Set(['single_parent', 'children']),
      financial: { below_poverty_line: true },
      location: { state: 'tn' },
      military: new Set(),
      demographics: new Set(),
      health: new Set(),
      occupation: new Set(),
      immigration: new Set(),
      geographic: new Set(),
      assistance: new Set(['food', 'housing']),
      applicantTypes: new Set(),
      organization: {},
    },
  }

  const result = expandNeedsQueries(demoContext)
  console.log('=== Needs-Based Query Expander Demo ===')
  console.log(`Situation rules matched: ${result.situationMatches.length}`)
  console.log(`Total expanded queries: ${result.queries.length}`)
  result.situationMatches.forEach((sm) =>
    console.log(`  [${sm.ruleId}] ${sm.description}`),
  )
}
