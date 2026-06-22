/**
 * federalBenefits.js
 * 
 * Curated federal assistance programs available to individuals nationwide.
 * Every entry has a verified application URL and clear eligibility criteria.
 * NO loans. NO matching funds. Direct assistance only.
 */

export const FEDERAL_BENEFITS = [

  // ════════════════════════════════════════
  // FOOD ASSISTANCE
  // ════════════════════════════════════════
  {
    id: 'fed-snap',
    name: 'SNAP (Supplemental Nutrition Assistance Program)',
    description: 'Monthly benefits loaded to an EBT card to purchase food. Eligibility based on household size, income, and expenses. Most households must have gross income below 130% of poverty and net income below 100%.',
    url: 'https://www.fns.usda.gov/snap/recipient/eligibility',
    applicationNote: 'Apply through your state portal. Search your state at the URL above.',
    categories: ['food'],
    eligibility: { incomeLimit: '130% FPL gross / 100% FPL net', citizenshipRequired: true },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
  intentMatch: ['food']
  },
  {
    id: 'fed-wic',
    name: 'WIC (Women, Infants, and Children)',
    description: 'Provides nutritious foods, nutrition education, breastfeeding support, and healthcare referrals for pregnant/postpartum women and children under 5.',
    url: 'https://www.fns.usda.gov/wic',
    applicationNote: 'Contact your local WIC clinic. Find locations at the URL above.',
    categories: ['food','healthcare'],
    eligibility: { incomeLimit: '185% FPL', targetPopulation: ['pregnant','postpartum','children_under_5'] },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    demographicMatch: ['female','has_children'],
  intentMatch: ['food', 'healthcare']
  },
  {
    id: 'fed-tefap',
    name: 'TEFAP (Emergency Food Assistance Program)',
    description: 'Free food distributed through local food banks and pantries. No application required at most sites — just show up during distribution hours.',
    url: 'https://www.fns.usda.gov/tefap/the-emergency-food-assistance-program',
    applicationNote: 'Find your local food bank at feedingamerica.org/find-your-local-foodbank',
    categories: ['food'],
    eligibility: { incomeLimit: 'Varies by state, typically 150-185% FPL' },
    type: 'assistance',
    fundingType: 'direct_benefit',
    recurring: true,
  intentMatch: ['food']
  },
  {
    id: 'fed-csfp',
    name: 'CSFP (Commodity Supplemental Food Program)',
    description: 'Monthly food packages for low-income seniors age 60+. Includes canned fruits/vegetables, juice, grains, milk, cheese, meat, and more.',
    url: 'https://www.fns.usda.gov/csfp/commodity-supplemental-food-program',
    categories: ['food'],
    eligibility: { incomeLimit: '130% FPL', minAge: 60 },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    demographicMatch: ['senior'],
  intentMatch: ['food']
  },

  // ════════════════════════════════════════
  // UTILITIES / ENERGY
  // ════════════════════════════════════════
  {
    id: 'fed-liheap',
    name: 'LIHEAP (Low Income Home Energy Assistance Program)',
    description: 'Helps pay heating and cooling bills. Also covers energy crisis intervention (shutoff prevention) and weatherization. Benefit amounts vary by state.',
    url: 'https://www.acf.hhs.gov/ocs/low-income-home-energy-assistance-program-liheap',
    applicationNote: 'Apply through your state energy office or social services. Find your state program at liheapch.acf.gov',
    categories: ['utilities'],
    eligibility: { incomeLimit: '150% FPL or 60% state median income' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true, // annual
  intentMatch: ['utilities']
  },
  {
    id: 'fed-wap',
    name: 'Weatherization Assistance Program (WAP)',
    description: 'Free home energy improvements: insulation, air sealing, furnace repair/replacement, weather stripping. Reduces energy bills by an average of $283/year. No repayment required.',
    url: 'https://www.energy.gov/scep/wap/weatherization-assistance-program-1',
    applicationNote: 'Contact your local Community Action Agency. Find yours at nascsp.org',
    categories: ['utilities','weatherization','housing'],
    eligibility: { incomeLimit: '200% FPL' },
    type: 'grant',
    fundingType: 'direct_service',
    recurring: false,
  intentMatch: ['utilities', 'housing']
  },
  {
    id: 'fed-lifeline',
    name: 'Lifeline (FCC Phone/Internet Discount)',
    description: 'Up to $9.25/month discount on phone or internet service. Available to households on SNAP, Medicaid, SSI, Federal Public Housing, Veterans Pension, or with income below 135% FPL.',
    url: 'https://www.lifelinesupport.org/',
    applicationNote: 'Apply online at lifelinesupport.org or through your phone/internet provider.',
    categories: ['internet','utilities'],
    eligibility: { incomeLimit: '135% FPL', qualifyingPrograms: ['snap','medicaid','ssi','federal_housing','veterans_pension'] },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
  intentMatch: ['broadband', 'utilities']
  },

  // ════════════════════════════════════════
  // HOUSING
  // ════════════════════════════════════════
  {
    id: 'fed-section8',
    name: 'Housing Choice Voucher Program (Section 8)',
    description: 'Rental assistance vouchers that pay a portion of rent directly to landlords. Families pay roughly 30% of adjusted income toward rent.',
    url: 'https://www.hud.gov/topics/housing_choice_voucher_program_section_8',
    applicationNote: 'Apply through your local Public Housing Authority. Find yours at hud.gov/program_offices/public_indian_housing/pha/contacts',
    categories: ['housing'],
    eligibility: { incomeLimit: '50% area median income' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    waitlistNote: 'Most areas have waiting lists. Apply as soon as lists open.',
  intentMatch: ['housing']
  },
  {
    id: 'fed-public-housing',
    name: 'Public Housing',
    description: 'Affordable rental units owned by local housing authorities. Rent based on 30% of adjusted income.',
    url: 'https://www.hud.gov/topics/rental_assistance/phprog',
    applicationNote: 'Contact your local housing authority.',
    categories: ['housing'],
    eligibility: { incomeLimit: '80% area median income (typically)' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
  intentMatch: ['housing']
  },
  {
    id: 'fed-usda-rural-repair',
    name: 'USDA Section 504 Home Repair Grant',
    description: 'Grants up to $10,000 for very low-income rural homeowners age 62+ to repair or improve their homes. Removes health and safety hazards.',
    url: 'https://www.rd.usda.gov/programs-services/single-family-housing-programs/single-family-housing-repair-loans-grants',
    categories: ['housing','weatherization'],
    eligibility: { incomeLimit: '50% area median income', minAge: 62, ruralOnly: true },
    type: 'grant',
    fundingType: 'direct_grant',
    recurring: false,
    maxAmount: 10000,
    demographicMatch: ['senior'],
    geoMatch: ['rural'],
  intentMatch: ['housing']
  },

  // ════════════════════════════════════════
  // CASH ASSISTANCE
  // ════════════════════════════════════════
  {
    id: 'fed-tanf',
    name: 'TANF (Temporary Assistance for Needy Families)',
    description: 'Cash assistance for low-income families with children. Each state runs its own TANF program with different benefit amounts and rules. Also provides job training and support services.',
    url: 'https://www.acf.hhs.gov/ofa/programs/temporary-assistance-needy-families-tanf',
    applicationNote: 'Apply through your state benefits portal.',
    categories: ['cash_assistance'],
    eligibility: { incomeLimit: 'Varies by state', requiresChildren: true },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    familyMatch: ['has_children','single_parent'],
  intentMatch: ['food', 'childcare']
  },
  {
    id: 'fed-ssi',
    name: 'SSI (Supplemental Security Income)',
    description: 'Monthly cash payments for people who are aged 65+, blind, or disabled and have limited income and resources. 2026 federal benefit rate is up to $967/month for individuals.',
    url: 'https://www.ssa.gov/ssi',
    applicationNote: 'Apply at ssa.gov or your local Social Security office.',
    categories: ['cash_assistance','disability'],
    eligibility: { incomeLimit: 'Very low income', requiresDisabilityOrAge: true },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    healthMatch: ['disability','physical_disability','visual_impairment','hearing_impairment','mental_health'],
    demographicMatch: ['senior'],
  intentMatch: ['special_needs']
  },
  {
    id: 'fed-ssdi',
    name: 'SSDI (Social Security Disability Insurance)',
    description: 'Monthly benefits for workers who become disabled and can no longer work. Based on work history and earnings record. Includes Medicare after 24 months.',
    url: 'https://www.ssa.gov/disability',
    applicationNote: 'Apply at ssa.gov, by phone (1-800-772-1213), or at your local SSA office.',
    categories: ['cash_assistance','disability','healthcare'],
    eligibility: { requiresWorkHistory: true, requiresDisability: true },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    healthMatch: ['disability','physical_disability','visual_impairment','hearing_impairment','chronic_illness'],
  intentMatch: ['special_needs', 'healthcare']
  },

  // ════════════════════════════════════════
  // HEALTHCARE
  // ════════════════════════════════════════
  {
    id: 'fed-medicaid',
    name: 'Medicaid',
    description: 'Free or low-cost health coverage for low-income individuals, families, pregnant women, elderly, and people with disabilities. In expansion states, covers adults up to 138% FPL.',
    url: 'https://www.medicaid.gov/about-us/beneficiary-resources/index.html',
    applicationNote: 'Apply through your state Medicaid office or healthcare.gov.',
    categories: ['healthcare'],
    eligibility: { incomeLimit: '138% FPL (expansion states) or varies' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
  intentMatch: ['healthcare']
  },
  {
    id: 'fed-marketplace',
    name: 'ACA Marketplace (Healthcare.gov)',
    description: 'Health insurance with premium tax credits and cost-sharing reductions for low/moderate income. Many people qualify for $0 or very low premium plans.',
    url: 'https://www.healthcare.gov/',
    categories: ['healthcare'],
    eligibility: { incomeLimit: '100-400% FPL for subsidies' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
  intentMatch: ['healthcare']
  },
  {
    id: 'fed-hill-burton',
    name: 'Hill-Burton Free/Reduced-Cost Medical Care',
    description: 'Certain hospitals and health facilities that received Hill-Burton funds must provide free or reduced-cost care to patients who cannot afford to pay.',
    url: 'https://www.hrsa.gov/get-health-care/affordable/hill-burton/index.html',
    applicationNote: 'Ask the facility admissions or business office about Hill-Burton obligation.',
    categories: ['healthcare'],
    eligibility: { incomeLimit: 'Varies by facility, typically up to 200% FPL' },
    type: 'assistance',
    fundingType: 'direct_service',
    recurring: true,
  intentMatch: ['healthcare']
  },
  {
    id: 'fed-health-centers',
    name: 'HRSA Community Health Centers',
    description: 'Federally funded health centers that provide care on a sliding fee scale based on ability to pay. No one is turned away for inability to pay.',
    url: 'https://findahealthcenter.hrsa.gov/',
    categories: ['healthcare'],
    eligibility: { incomeLimit: 'Sliding scale — no one turned away' },
    type: 'assistance',
    fundingType: 'direct_service',
    recurring: true,
  intentMatch: ['healthcare']
  },

  // ════════════════════════════════════════
  // VETERANS
  // ════════════════════════════════════════
  {
    id: 'fed-va-pension',
    name: 'VA Pension (Veterans Pension)',
    description: 'Monthly payments to wartime veterans with limited income who are 65+ or permanently disabled. Tax-free benefit.',
    url: 'https://www.va.gov/pension/',
    categories: ['cash_assistance'],
    eligibility: { requiresVeteran: true, incomeLimit: 'VA means test' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    militaryMatch: ['veteran'],
  intentMatch: ['military']
  },
  {
    id: 'fed-va-healthcare',
    name: 'VA Healthcare',
    description: 'Comprehensive healthcare for eligible veterans including primary care, mental health, specialty care, prescriptions, and more.',
    url: 'https://www.va.gov/health-care/',
    categories: ['healthcare'],
    eligibility: { requiresVeteran: true },
    type: 'benefit',
    fundingType: 'direct_service',
    recurring: true,
    militaryMatch: ['veteran','disabled_veteran'],
  intentMatch: ['military', 'healthcare']
  },
  {
    id: 'fed-va-disability',
    name: 'VA Disability Compensation',
    description: 'Monthly tax-free payments for veterans with service-connected disabilities. Amount based on disability rating (0-100%).',
    url: 'https://www.va.gov/disability/',
    categories: ['cash_assistance','disability'],
    eligibility: { requiresVeteran: true, requiresServiceConnectedDisability: true },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    militaryMatch: ['veteran','disabled_veteran'],
    healthMatch: ['disability'],
  intentMatch: ['military', 'special_needs']
  },
  {
    id: 'fed-ssvf',
    name: 'SSVF (Supportive Services for Veteran Families)',
    description: 'Rapid re-housing and homelessness prevention for veteran families. Provides temporary financial assistance for rent, utilities, deposits, moving costs, and case management.',
    url: 'https://www.va.gov/homeless/ssvf/',
    categories: ['housing','utilities','cash_assistance'],
    eligibility: { requiresVeteran: true, incomeLimit: '50% area median income' },
    type: 'grant',
    fundingType: 'direct_benefit',
    recurring: false,
    militaryMatch: ['veteran'],
  intentMatch: ['military', 'housing']
  },

  // ════════════════════════════════════════
  // DISABILITY-SPECIFIC
  // ════════════════════════════════════════
  {
    id: 'fed-vocrehab',
    name: 'Vocational Rehabilitation',
    description: 'Employment services for people with disabilities: job training, education, job placement, assistive technology, and support services. Each state runs its own VR program.',
    url: 'https://rsa.ed.gov/about/states',
    categories: ['employment','disability','education'],
    eligibility: { requiresDisability: true },
    type: 'benefit',
    fundingType: 'direct_service',
    recurring: true,
    healthMatch: ['disability','physical_disability','visual_impairment','hearing_impairment','mental_health','developmental_disability'],
  intentMatch: ['workforce', 'special_needs']
  },

  // ════════════════════════════════════════
  // EDUCATION
  // ════════════════════════════════════════
  {
    id: 'fed-pell',
    name: 'Federal Pell Grant',
    description: 'Up to $7,395 (2025-2026) per year for undergraduate students with financial need. Does not need to be repaid.',
    url: 'https://studentaid.gov/understand-aid/types/grants/pell',
    applicationNote: 'Complete the FAFSA at studentaid.gov.',
    categories: ['education'],
    eligibility: { requiresStudent: true, incomeLimit: 'Based on EFC/SAI' },
    type: 'grant',
    fundingType: 'direct_grant',
    recurring: true,
    maxAmount: 7395,
  intentMatch: ['education']
  },
  {
    id: 'fed-fseog',
    name: 'Federal Supplemental Educational Opportunity Grant (FSEOG)',
    description: 'Additional grant of $100-$4,000/year for undergraduates with exceptional financial need. Priority given to Pell Grant recipients.',
    url: 'https://studentaid.gov/understand-aid/types/grants/fseog',
    categories: ['education'],
    eligibility: { requiresStudent: true, requiresPellEligible: true },
    type: 'grant',
    fundingType: 'direct_grant',
    recurring: true,
    maxAmount: 4000,
  intentMatch: ['education']
  },

  // ════════════════════════════════════════
  // CHILDCARE / FAMILY
  // ════════════════════════════════════════
  {
    id: 'fed-ccdf',
    name: 'Child Care Assistance (CCDF/CCDBG)',
    description: 'Subsidized child care for low-income working families. Reduces or eliminates child care costs so parents can work or attend training.',
    url: 'https://www.acf.hhs.gov/occ/parents',
    applicationNote: 'Apply through your state child care assistance program.',
    categories: ['childcare'],
    eligibility: { incomeLimit: '85% state median income', requiresChildren: true, requiresWorkOrTraining: true },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    familyMatch: ['has_children','single_parent'],
  intentMatch: ['childcare']
  },
  {
    id: 'fed-head-start',
    name: 'Head Start / Early Head Start',
    description: 'Free comprehensive early childhood education, health, nutrition, and parent involvement services for children birth to 5 from low-income families.',
    url: 'https://www.acf.hhs.gov/ohs',
    applicationNote: 'Find a program near you at eclkc.ohs.acf.hhs.gov/center-locator',
    categories: ['childcare','education'],
    eligibility: { incomeLimit: '100% FPL', requiresChildren: true },
    type: 'benefit',
    fundingType: 'direct_service',
    recurring: true,
    familyMatch: ['has_children'],
  intentMatch: ['childcare', 'education']
  },

  // ════════════════════════════════════════
  // LEGAL
  // ════════════════════════════════════════
  {
    id: 'fed-lsc',
    name: 'Legal Services Corporation (Free Legal Aid)',
    description: 'Free civil legal assistance for low-income Americans. Covers housing disputes, family law, consumer issues, benefits appeals, and more.',
    url: 'https://www.lsc.gov/about-lsc/what-legal-aid/get-legal-help',
    categories: ['legal'],
    eligibility: { incomeLimit: '125% FPL' },
    type: 'assistance',
    fundingType: 'direct_service',
    recurring: true,
  intentMatch: ['legal']
  },
];

export default FEDERAL_BENEFITS;
