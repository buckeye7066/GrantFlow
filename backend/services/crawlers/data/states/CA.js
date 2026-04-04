/**
 * CA.js — California State Benefits
 *
 * Active programs for California residents (2024-2025).
 * Real URLs. Covers welfare, healthcare, education, housing,
 * utilities, business, and arts funding.
 */

export const STATE_META = {
  code: 'CA',
  name: 'California',
  benefitsPortal: 'https://www.benefitscal.com/',
  benefitsPortalName: 'BenefitsCal',
  medicaidName: 'Medi-Cal',
  dhsPhone: '1-877-847-3663',
  localOfficeUrl: 'https://www.benefitscal.com/',
  is211Available: true,
};

export const STATE_BENEFITS = [

  // ════════════════════════════════════════
  // CASH ASSISTANCE / EMPLOYMENT
  // ════════════════════════════════════════
  {
    id: 'ca-calworks',
    name: 'CalWORKs (California Work Opportunity and Responsibility to Kids)',
    description: 'California\'s welfare-to-work program providing cash assistance and employment services to low-income families with children. Supports single parents and working families with job training, childcare, and transitional benefits.',
    url: 'https://www.cdss.ca.gov/calworks',
    categories: ['financial_assistance', 'employment'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['single_parent', 'welfare', 'employment', 'california'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'CA',
    source: 'state',
    familyMatch: ['has_children', 'single_parent'],
  },

  // ════════════════════════════════════════
  // HEALTHCARE
  // ════════════════════════════════════════
  {
    id: 'ca-medi-cal',
    name: 'Medi-Cal (California Medicaid)',
    description: 'California\'s Medicaid program providing free or low-cost health coverage to eligible residents including families, seniors, persons with disabilities, and low-income adults. Covers doctor visits, hospital care, prescriptions, mental health, and dental.',
    url: 'https://www.dhcs.ca.gov/services/medi-cal',
    categories: ['health', 'insurance'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['healthcare', 'medicaid', 'california', 'insurance'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'CA',
    source: 'state',
  },

  // ════════════════════════════════════════
  // TAX BENEFITS
  // ════════════════════════════════════════
  {
    id: 'ca-caleitc',
    name: 'California Earned Income Tax Credit (CalEITC)',
    description: 'State tax credit for low-income working Californians and families. Can be combined with the federal EITC for significant refunds. No minimum age requirement — available to workers as young as 18.',
    url: 'https://www.ftb.ca.gov/file/personal/credits/california-earned-income-tax-credit.html',
    categories: ['tax_benefit', 'financial_assistance'],
    applicant_types: ['individual'],
    intentMatch: ['eitc', 'tax_credit', 'low_income', 'california'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'CA',
    source: 'state',
  },

  // ════════════════════════════════════════
  // UTILITIES / ENERGY
  // ════════════════════════════════════════
  {
    id: 'ca-liheap',
    name: 'California LIHEAP (Low Income Home Energy Assistance Program)',
    description: 'Helps low-income California households pay heating and cooling energy costs. Also provides crisis assistance to prevent utility shutoff and weatherization services through local community action agencies.',
    url: 'https://www.csd.ca.gov/pages/liheapprogram.aspx',
    categories: ['utility_assistance', 'energy'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['utility', 'energy', 'heating', 'california', 'liheap'],
    eligibility: { incomeLimit: '60% State Median Income' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'CA',
    source: 'state',
  },

  {
    id: 'ca-water-assistance',
    name: 'California Water Assistance Program (CWAP)',
    description: 'Provides financial assistance to low-income California households to help pay water and wastewater bills. Administered through the Department of Community Services and Development.',
    url: 'https://www.csd.ca.gov/pages/waterassistanceprogram.aspx',
    categories: ['utility_assistance'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['water', 'utility', 'california'],
    eligibility: { incomeLimit: '60% State Median Income' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'CA',
    source: 'state',
  },

  // ════════════════════════════════════════
  // EDUCATION
  // ════════════════════════════════════════
  {
    id: 'ca-college-promise-grant',
    name: 'California College Promise Grant (BOG Fee Waiver)',
    description: 'Waives enrollment fees at California Community Colleges for eligible low-income students. One of the largest college fee waiver programs in the nation, covering tuition at all 116 community colleges.',
    url: 'https://www.cccco.edu/Students/Support-and-Success/Financial-Aid',
    categories: ['education', 'financial_aid'],
    applicant_types: ['student'],
    intentMatch: ['college', 'community_college', 'california', 'tuition_waiver'],
    type: 'grant',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'CA',
    source: 'state',
  },

  {
    id: 'ca-cal-grant',
    name: 'Cal Grant A & B',
    description: 'California\'s primary state financial aid grant for undergraduate students at qualifying colleges and universities. Cal Grant A covers tuition; Cal Grant B provides a living allowance plus tuition assistance for low-income students.',
    url: 'https://www.csac.ca.gov/cal-grants',
    categories: ['education', 'financial_aid'],
    applicant_types: ['student'],
    intentMatch: ['college', 'grant', 'california', 'undergraduate'],
    type: 'grant',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'CA',
    source: 'state',
  },

  // ════════════════════════════════════════
  // HOUSING
  // ════════════════════════════════════════
  {
    id: 'ca-housing-is-key',
    name: 'California Housing Is Key (Rent Relief)',
    description: 'State rental assistance program helping California tenants and landlords affected by financial hardship. Covers unpaid rent, utilities, and future rent for income-qualifying households.',
    url: 'https://housing.ca.gov/',
    categories: ['housing', 'rent_assistance'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['rent', 'housing', 'california', 'eviction'],
    type: 'assistance',
    fundingType: 'direct_benefit',
    recurring: false,
    is_active: true,
    state: 'CA',
    source: 'state',
  },

  // ════════════════════════════════════════
  // SMALL BUSINESS
  // ════════════════════════════════════════
  {
    id: 'ca-ibank-small-business',
    name: 'California Small Business Finance Center (IBank)',
    description: 'IBank\'s Small Business Finance Center provides loan guarantees, direct loans, and grant programs to support California small businesses, including disaster relief and COVID recovery funding.',
    url: 'https://ibank.ca.gov/small-business-finance-center/',
    categories: ['business', 'financial_assistance'],
    applicant_types: ['small_business'],
    intentMatch: ['small_business', 'california', 'business_grant'],
    type: 'grant',
    fundingType: 'grant',
    recurring: false,
    is_active: true,
    state: 'CA',
    source: 'state',
  },

  // ════════════════════════════════════════
  // ARTS / CULTURE
  // ════════════════════════════════════════
  {
    id: 'ca-cultural-districts',
    name: 'California Cultural Districts Program',
    description: 'State program supporting the development and sustainability of arts and culture districts across California. Provides grants and technical assistance to nonprofits, local governments, and arts organizations.',
    url: 'https://arts.ca.gov/programs/california-cultural-districts-program/',
    categories: ['arts', 'culture', 'community'],
    applicant_types: ['nonprofit', 'organization'],
    intentMatch: ['arts', 'culture', 'california', 'community'],
    type: 'grant',
    fundingType: 'grant',
    recurring: true,
    is_active: true,
    state: 'CA',
    source: 'state',
  },

];

export default { STATE_META, STATE_BENEFITS };
