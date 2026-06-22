/**
 * TX.js — Texas State Benefits
 *
 * Active programs for Texas residents (2024-2025).
 * Real URLs. Covers welfare, healthcare, housing, education,
 * workforce development, business, and arts funding.
 */

export const STATE_META = {
  code: 'TX',
  name: 'Texas',
  benefitsPortal: 'https://www.yourtexasbenefits.com/',
  benefitsPortalName: 'Your Texas Benefits',
  medicaidName: 'Texas Medicaid',
  dhsPhone: '1-877-541-7905',
  localOfficeUrl: 'https://www.hhs.texas.gov/about-hhs/find-us/local-hhs-offices',
  is211Available: true,
};

export const STATE_BENEFITS = [

  // ════════════════════════════════════════
  // CASH ASSISTANCE / FOOD
  // ════════════════════════════════════════
  {
    id: 'tx-tanf',
    name: 'Texas Works (TANF — Temporary Assistance for Needy Families)',
    description: 'Cash assistance for low-income Texas families with children, combined with work support services including job training, employment assistance, and transitional benefits to promote self-sufficiency.',
    url: 'https://www.hhs.texas.gov/services/financial/texas-works',
    categories: ['financial_assistance', 'employment'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['tanf', 'welfare', 'texas', 'family'],
    eligibility: { requiresChildren: true },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'TX',
    source: 'state',
    familyMatch: ['has_children', 'single_parent'],
  },

  {
    id: 'tx-snap',
    name: 'Texas SNAP (Supplemental Nutrition Assistance Program)',
    description: 'Monthly food benefits on a Lone Star Card (EBT) for low-income Texas households. Helps families, seniors, and individuals purchase groceries at authorized retailers.',
    url: 'https://www.hhs.texas.gov/services/financial/snap',
    categories: ['food', 'nutrition'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['food', 'snap', 'texas', 'nutrition'],
    eligibility: { incomeLimit: '130% FPL gross' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'TX',
    source: 'state',
  },

  // ════════════════════════════════════════
  // HEALTHCARE
  // ════════════════════════════════════════
  {
    id: 'tx-medicaid',
    name: 'Texas Medicaid',
    description: 'Health coverage for eligible low-income Texans including children, pregnant women, seniors, and people with disabilities. Texas did not expand Medicaid under the ACA, so eligibility criteria are more limited than in expansion states.',
    url: 'https://www.hhs.texas.gov/services/health/medicaid-chip',
    categories: ['health', 'insurance'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['medicaid', 'healthcare', 'texas'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'TX',
    source: 'state',
  },

  {
    id: 'tx-chip',
    name: 'Texas CHIP (Children\'s Health Insurance Program)',
    description: 'Low-cost health coverage for Texas children up to age 18 in families that earn too much for Medicaid but cannot afford private insurance. Covers doctor visits, prescriptions, dental, vision, and mental health services.',
    url: 'https://www.hhs.texas.gov/services/health/medicaid-chip/medicaid-chip-eligibility',
    categories: ['health', 'insurance'],
    applicant_types: ['family'],
    intentMatch: ['chip', 'children_health', 'texas'],
    eligibility: { requiresChildren: true, incomeLimit: '200% FPL' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'TX',
    source: 'state',
    familyMatch: ['has_children'],
  },

  // ════════════════════════════════════════
  // UTILITIES / ENERGY
  // ════════════════════════════════════════
  {
    id: 'tx-liheap',
    name: 'Texas LIHEAP (Low Income Home Energy Assistance Program)',
    description: 'Helps low-income Texas households pay heating and cooling costs and prevents utility disconnection. Administered through local community action agencies across the state.',
    url: 'https://www.tdhca.state.tx.us/community-affairs/liheap/',
    categories: ['utility_assistance', 'energy'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['liheap', 'utility', 'texas', 'energy'],
    eligibility: { incomeLimit: '150% FPL' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'TX',
    source: 'state',
  },

  // ════════════════════════════════════════
  // HOUSING
  // ════════════════════════════════════════
  {
    id: 'tx-rental-assistance',
    name: 'Texas Rental Assistance Program (TDHCA)',
    description: 'Provides emergency rental and utility assistance to income-eligible Texas households facing eviction or housing instability. Administered by the Texas Department of Housing and Community Affairs.',
    url: 'https://www.tdhca.state.tx.us/',
    categories: ['housing', 'rent_assistance'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['rent', 'housing', 'texas', 'eviction'],
    type: 'assistance',
    fundingType: 'direct_benefit',
    recurring: false,
    is_active: true,
    state: 'TX',
    source: 'state',
  },

  // ════════════════════════════════════════
  // ECONOMIC DEVELOPMENT / BUSINESS
  // ════════════════════════════════════════
  {
    id: 'tx-enterprise-fund',
    name: 'Texas Enterprise Fund',
    description: 'Deal-closing fund used by the Governor\'s office to attract large-scale business investments and job creation to Texas. Provides direct grants to businesses committing significant capital investment and employment.',
    url: 'https://gov.texas.gov/business/page/texas-enterprise-fund',
    categories: ['business', 'economic_development'],
    applicant_types: ['small_business', 'organization'],
    intentMatch: ['business', 'economic_development', 'texas'],
    type: 'grant',
    fundingType: 'grant',
    recurring: false,
    is_active: true,
    state: 'TX',
    source: 'state',
  },

  {
    id: 'tx-skills-development-fund',
    name: 'Texas Workforce Commission Skills Development Fund',
    description: 'Provides customized job training grants to Texas businesses and community colleges. Helps companies train new and existing employees while partnering with local educational institutions.',
    url: 'https://www.twc.texas.gov/businesses/skills-development-fund',
    categories: ['employment', 'workforce_development'],
    applicant_types: ['small_business', 'organization'],
    intentMatch: ['workforce', 'job_training', 'texas', 'business'],
    type: 'grant',
    fundingType: 'grant',
    recurring: true,
    is_active: true,
    state: 'TX',
    source: 'state',
  },

  // ════════════════════════════════════════
  // ARTS / CULTURE
  // ════════════════════════════════════════
  {
    id: 'tx-arts-grants',
    name: 'Texas Commission on the Arts Grants',
    description: 'State arts agency providing grants to Texas nonprofits, schools, and local governments for arts programming, cultural events, and organizational development across the state.',
    url: 'https://www.arts.texas.gov/',
    categories: ['arts', 'culture'],
    applicant_types: ['nonprofit', 'organization'],
    intentMatch: ['arts', 'nonprofit', 'texas', 'culture'],
    type: 'grant',
    fundingType: 'grant',
    recurring: true,
    is_active: true,
    state: 'TX',
    source: 'state',
  },

  // ════════════════════════════════════════
  // RURAL DEVELOPMENT
  // ════════════════════════════════════════
  {
    id: 'tx-usda-rural-development',
    name: 'USDA Rural Development — Texas State Office',
    description: 'Federal-state partnership providing loans, grants, and loan guarantees to support housing, business, and community facilities in rural Texas. Programs cover water systems, broadband, business development, and rural housing.',
    url: 'https://www.rd.usda.gov/tx',
    categories: ['rural_development', 'housing', 'business'],
    applicant_types: ['nonprofit', 'organization', 'small_business'],
    intentMatch: ['rural', 'texas', 'rural_development'],
    type: 'grant',
    fundingType: 'grant',
    recurring: true,
    is_active: true,
    state: 'TX',
    source: 'state',
  },

];

export default { STATE_META, STATE_BENEFITS };
