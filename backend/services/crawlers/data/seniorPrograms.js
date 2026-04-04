/**
 * seniorPrograms.js
 *
 * Curated programs specifically targeting adults 60 and older (some programs begin at 55).
 * Includes Medicare assistance, nutrition, transportation, employment, and community services
 * authorized under the Older Americans Act and related legislation.
 *
 * All entries include ageGroup: 'senior' and eligibility.ageMin for matching.
 * Every URL is real and current. NO loans. Direct assistance or referral only.
 */

export const SENIOR_PROGRAMS = [

  // ════════════════════════════════════════
  // MEDICARE COST ASSISTANCE
  // ════════════════════════════════════════
  {
    id: 'senior-medicare-savings',
    name: 'Medicare Savings Programs (QMB / SLMB / QI)',
    description: 'State-administered programs that help low-income Medicare beneficiaries pay premiums, deductibles, and copays. Four levels: Qualified Medicare Beneficiary (QMB) covers Part A & B premiums plus cost-sharing; Specified Low-Income Medicare Beneficiary (SLMB) covers Part B premium; Qualifying Individual (QI) provides partial Part B premium help; Qualified Disabled and Working Individual (QDWI) covers Part A premium. Apply through your state Medicaid office.',
    url: 'https://www.medicare.gov/basics/costs/help/medicare-savings-programs',
    categories: ['healthcare', 'senior', 'cash_assistance'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['healthcare', 'senior', 'prescription_assistance'],
    ageGroup: 'senior',
    eligibility: {
      ageMin: 65,
      incomeLimit: 'QMB: up to 100% FPL; SLMB: up to 120% FPL; QI: up to 135% FPL',
      requiresMedicare: true,
      note: 'Must be enrolled in Medicare Part A; income and resource limits apply; apply through state Medicaid',
    },
    recurring: true,
  },

  {
    id: 'senior-ship',
    name: 'SHIP — State Health Insurance Assistance Program',
    description: 'Free, unbiased Medicare counseling provided by trained volunteers and staff in every state. SHIP counselors help seniors understand Medicare options, find cost savings, navigate appeals, and detect Medicare fraud. No income requirement — free to all Medicare beneficiaries and their families. Find your state SHIP at shiphelp.org.',
    url: 'https://shiphelp.org/',
    categories: ['healthcare', 'senior'],
    type: 'assistance',
    fundingType: 'direct_service',
    intentMatch: ['healthcare', 'senior'],
    ageGroup: 'senior',
    eligibility: {
      ageMin: 60,
      incomeLimit: 'None — free to all Medicare beneficiaries',
      requiresMedicare: false,
      note: 'Open to anyone with Medicare or soon turning 65; family members may also call on behalf of a beneficiary',
    },
    recurring: true,
  },

  {
    id: 'senior-part-d-extra-help',
    name: 'Medicare Part D Extra Help (Low-Income Subsidy)',
    description: 'Federal subsidy that reduces or eliminates Medicare prescription drug (Part D) costs for low-income seniors. Full Extra Help beneficiaries pay no more than $4.50 for generics and $11.20 for brand-name drugs. Apply through the Social Security Administration online, by phone, or at a local SSA office.',
    url: 'https://www.ssa.gov/medicare/part-d-low-income-subsidy',
    categories: ['healthcare', 'prescription_assistance', 'senior'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['healthcare', 'prescription_assistance', 'senior'],
    ageGroup: 'senior',
    eligibility: {
      ageMin: 65,
      incomeLimit: 'Up to 150% FPL for full subsidy; graduated assistance to ~185% FPL',
      requiresMedicare: true,
      note: 'Must be enrolled in Medicare Part A or B; resource limits also apply',
    },
    recurring: true,
  },

  // ════════════════════════════════════════
  // EMPLOYMENT & TRAINING (55+)
  // ════════════════════════════════════════
  {
    id: 'senior-scsep',
    name: 'SCSEP — Senior Community Service Employment Program',
    description: 'Federally funded job training and community service program for adults 55 and older with low income. Participants work part-time (average 20 hrs/week) at nonprofit or government host agencies while gaining marketable job skills. Paid minimum wage during training. Operated through AARP Foundation, National Council on Aging, and other national grantees.',
    url: 'https://www.dol.gov/agencies/eta/seniors',
    categories: ['employment', 'senior'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['employment', 'senior'],
    ageGroup: 'senior',
    eligibility: {
      ageMin: 55,
      incomeLimit: 'Up to 125% FPL',
      note: 'Must be unemployed; priority given to veterans, those over 65, individuals with disabilities, and low-literacy adults',
    },
    recurring: true,
  },

  // ════════════════════════════════════════
  // NUTRITION PROGRAMS
  // ════════════════════════════════════════
  {
    id: 'senior-meals-on-wheels',
    name: 'Meals on Wheels — Home-Delivered Senior Nutrition',
    description: 'Network of 5,000+ local programs delivering nutritious meals to homebound seniors who cannot prepare food for themselves. Services vary by location and may include hot meals, frozen meals, groceries, and wellness checks. Funded in part by the Older Americans Act (Title III-C). Contact your local program for availability and waitlist status.',
    url: 'https://www.mealsonwheelsamerica.org/find-meals',
    categories: ['food', 'senior'],
    type: 'assistance',
    fundingType: 'direct_service',
    intentMatch: ['food', 'senior'],
    ageGroup: 'senior',
    eligibility: {
      ageMin: 60,
      incomeLimit: 'No strict income requirement; prioritized by need and functional limitations',
      note: 'Must have difficulty preparing meals; homebound status often required for home delivery',
    },
    recurring: true,
  },

  {
    id: 'senior-congregate-meals',
    name: 'Senior Nutrition Program — Congregate Meals (Title III-C, Older Americans Act)',
    description: 'Federally funded program providing nutritious meals at senior centers, adult day programs, churches, and other community sites. Also provides nutrition education and socialization. Free or low-cost (suggested donation). Find your local program through the Eldercare Locator or your Area Agency on Aging.',
    url: 'https://acl.gov/programs/health-wellness/nutrition-services',
    categories: ['food', 'senior'],
    type: 'benefit',
    fundingType: 'direct_service',
    intentMatch: ['food', 'senior'],
    ageGroup: 'senior',
    eligibility: {
      ageMin: 60,
      incomeLimit: 'None — open to all adults 60+; no means test required',
      note: 'Spouses of any age may also participate; priority given to those with greatest social and economic need',
    },
    recurring: true,
  },

  // ════════════════════════════════════════
  // VOLUNTEER & COMMUNITY ENGAGEMENT
  // ════════════════════════════════════════
  {
    id: 'senior-senior-corps',
    name: 'Senior Corps Programs (RSVP / Foster Grandparents / Senior Companions)',
    description: 'AmeriCorps Senior Corps connects adults 55+ with meaningful volunteer opportunities. Three programs: RSVP (volunteer in your community), Foster Grandparents (mentor children with special needs, small stipend), and Senior Companions (assist homebound adults, small stipend). Foster Grandparents and Senior Companions have income eligibility; RSVP is open to all.',
    url: 'https://americorps.gov/serve/fit-finder/americorps-seniors',
    categories: ['employment', 'senior', 'community'],
    type: 'assistance',
    fundingType: 'direct_service',
    intentMatch: ['employment', 'senior'],
    ageGroup: 'senior',
    eligibility: {
      ageMin: 55,
      incomeLimit: 'RSVP: none; Foster Grandparents and Senior Companions: up to 200% FPL for stipend eligibility',
      note: 'Stipend-earning positions (Foster Grandparents, Senior Companions) are income-tested; RSVP is open to all 55+',
    },
    recurring: true,
  },

  // ════════════════════════════════════════
  // BENEFITS SCREENING & REFERRAL
  // ════════════════════════════════════════
  {
    id: 'senior-benefitscheckup',
    name: 'BenefitsCheckUp — NCOA Benefits Eligibility Screener',
    description: 'Free online tool from the National Council on Aging that screens seniors for over 2,500 federal, state, and local benefit programs. Enter basic information to get a personalized list of programs you may qualify for, including food, healthcare, housing, utilities, and more. Available in English and Spanish.',
    url: 'https://www.benefitscheckup.org/',
    categories: ['healthcare', 'food', 'housing', 'utilities', 'senior'],
    type: 'referral',
    fundingType: 'referral_service',
    intentMatch: ['healthcare', 'food', 'housing', 'utilities', 'senior'],
    ageGroup: 'senior',
    eligibility: {
      ageMin: 55,
      incomeLimit: 'None — tool screens for programs with varying income limits',
      note: 'Free screener; no registration required to use basic search',
    },
    recurring: true,
  },

  {
    id: 'senior-aarp-foundation',
    name: 'AARP Foundation Programs and Grants',
    description: 'AARP Foundation offers programs targeting low-income adults 50+, including AARP Tax-Aide (free tax preparation), AARP Foundation Litigation (legal advocacy), and grants to local organizations serving seniors. SCSEP is operated nationally by AARP Foundation. Also offers financial resilience programs and food security initiatives.',
    url: 'https://www.aarp.org/aarp-foundation/',
    categories: ['cash_assistance', 'employment', 'legal', 'food', 'senior'],
    type: 'assistance',
    fundingType: 'direct_service',
    intentMatch: ['employment', 'food', 'senior', 'legal'],
    ageGroup: 'senior',
    eligibility: {
      ageMin: 50,
      incomeLimit: 'Varies by program; most target low-income adults 50+',
      note: 'Tax-Aide is open to all ages with low-to-moderate income; SCSEP requires 55+ and income up to 125% FPL',
    },
    recurring: true,
  },

  {
    id: 'senior-eldercare-locator',
    name: 'Eldercare Locator — Find Your Local Area Agency on Aging',
    description: 'Free national service (1-800-677-1116) connecting seniors and caregivers to local Area Agencies on Aging (AAAs) and other community resources. AAAs coordinate a wide range of services including home care, transportation, legal aid, caregiver support, and nutrition programs. Available by phone or online search.',
    url: 'https://eldercare.acl.gov/',
    categories: ['healthcare', 'transportation', 'housing', 'food', 'senior'],
    type: 'referral',
    fundingType: 'referral_service',
    intentMatch: ['healthcare', 'transportation', 'housing', 'food', 'senior'],
    ageGroup: 'senior',
    eligibility: {
      ageMin: 60,
      incomeLimit: 'None — free referral service for any older adult or caregiver',
      note: 'Individual programs accessed through AAAs may have income requirements',
    },
    recurring: true,
  },

  // ════════════════════════════════════════
  // ENERGY & HOUSING ASSISTANCE (SENIOR-TARGETED)
  // ════════════════════════════════════════
  {
    id: 'senior-liheap-senior',
    name: 'LIHEAP — Energy Assistance (Senior Priority)',
    description: 'The Low-Income Home Energy Assistance Program gives priority to households with seniors 60 and older, especially those with high energy burdens or living in extreme weather. Helps pay heating and cooling bills, prevent utility shutoffs, and fund weatherization. Many states give seniors priority processing. Apply through your state or local community action agency.',
    url: 'https://www.acf.hhs.gov/ocs/low-income-home-energy-assistance-program-liheap',
    categories: ['utilities', 'senior', 'housing'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['utilities', 'senior', 'housing'],
    ageGroup: 'senior',
    eligibility: {
      ageMin: 60,
      incomeLimit: 'Up to 150% FPL or 60% state median income; seniors may receive priority',
      note: 'Apply through your state energy office; priority given to households with elderly members',
    },
    recurring: true,
  },

  {
    id: 'senior-property-tax-relief',
    name: 'Senior Property Tax Relief Programs (State & Local)',
    description: 'Every state has at least one property tax relief program for seniors 65+ and disabled homeowners. Common types include: homestead exemptions (reduce assessed value), circuit-breaker credits (based on income-to-tax ratio), and property tax deferrals (delay payment until home is sold). Benefits vary widely by state and county. See propertyTaxRelief programs for state-specific programs.',
    url: 'https://www.ncsl.org/research/fiscal-policy/property-tax-relief-for-homeowners.aspx',
    categories: ['housing', 'property_tax_relief', 'senior', 'cash_assistance'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['housing', 'property_tax_relief', 'senior'],
    ageGroup: 'senior',
    eligibility: {
      ageMin: 65,
      incomeLimit: 'Varies by state; typically low-to-moderate income homeowners',
      requiresHomeowner: true,
      note: 'Apply through your county assessor or tax office; state-specific rules apply',
    },
    recurring: true,
  },

  // ════════════════════════════════════════
  // INCOME SUPPORT
  // ════════════════════════════════════════
  {
    id: 'senior-ssi-elderly',
    name: 'Supplemental Security Income (SSI) for Adults 65+',
    description: 'Federal cash assistance for adults 65 and older with very limited income and resources. SSI provides monthly payments to help with basic needs including food, clothing, and shelter. In 2024, the maximum federal SSI payment is $943/month for an individual. Many states supplement the federal payment. Apply through the Social Security Administration.',
    url: 'https://www.ssa.gov/benefits/ssi/',
    categories: ['cash_assistance', 'senior'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['cash_assistance', 'senior'],
    ageGroup: 'senior',
    eligibility: {
      ageMin: 65,
      incomeLimit: 'Very limited income and resources; individual resource limit $2,000, couple $3,000',
      note: 'Must be US citizen or qualifying non-citizen; income and asset tests apply; some income is excluded',
    },
    recurring: true,
  },

  {
    id: 'senior-va-aid-attendance',
    name: 'VA Aid & Attendance Pension Benefit',
    description: 'Enhanced VA pension benefit for wartime veterans and surviving spouses who need help with daily activities (bathing, dressing, feeding) or who are housebound. Provides additional monthly income on top of basic VA pension. In 2024, the maximum is $2,300/month for a veteran with a dependent. Does not require a service-connected disability.',
    url: 'https://www.va.gov/pension/aid-attendance-housebound/',
    categories: ['healthcare', 'cash_assistance', 'senior', 'veterans'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['healthcare', 'cash_assistance', 'senior', 'veterans'],
    ageGroup: 'senior',
    eligibility: {
      ageMin: 65,
      incomeLimit: 'Income adjusted for unreimbursed medical expenses; net worth limit applies (~$155,356 in 2024)',
      note: 'Must have served at least 90 days active duty with at least one day during a wartime period; must need help with daily activities',
      requiresVeteran: true,
    },
    recurring: true,
  },

  // ════════════════════════════════════════
  // TRANSPORTATION
  // ════════════════════════════════════════
  {
    id: 'senior-nadtc',
    name: 'National Aging and Disability Transportation Center',
    description: 'National resource center providing information about transportation options for older adults and people with disabilities. Find local specialized transportation services, volunteer driver programs, ride-sharing options, and accessibility resources. Funded by the Federal Transit Administration and the Administration for Community Living.',
    url: 'https://www.nadtc.org/about/transportation-resources/find-local-transit-resources/',
    categories: ['transportation', 'senior'],
    type: 'referral',
    fundingType: 'referral_service',
    intentMatch: ['transportation', 'senior'],
    ageGroup: 'senior',
    eligibility: {
      ageMin: 60,
      incomeLimit: 'None for the resource center; local programs vary',
      note: 'Use the resource finder to locate transportation options in your area; Medicaid Non-Emergency Medical Transportation (NEMT) may also be available',
    },
    recurring: true,
  },
];
