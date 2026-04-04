/**
 * NY.js — New York State Benefits
 *
 * Active programs for New York residents (2024-2025).
 * Real URLs. Covers food, healthcare, utilities, housing,
 * education, arts, business, seniors, and veterans.
 */

export const STATE_META = {
  code: 'NY',
  name: 'New York',
  benefitsPortal: 'https://www.mybenefits.ny.gov/',
  benefitsPortalName: 'myBenefits NY',
  medicaidName: 'New York Medicaid',
  dhsPhone: '1-800-342-3009',
  localOfficeUrl: 'https://otda.ny.gov/workingfamilies/dss.asp',
  is211Available: true,
};

export const STATE_BENEFITS = [

  // ════════════════════════════════════════
  // FOOD
  // ════════════════════════════════════════
  {
    id: 'ny-snap',
    name: 'New York SNAP (Supplemental Nutrition Assistance Program)',
    description: 'Monthly food benefits for low-income New York residents, provided on a benefits card usable at grocery stores and farmers markets. Apply online through myBenefits or at a local DSS office.',
    url: 'https://otda.ny.gov/programs/snap/',
    categories: ['food', 'nutrition'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['snap', 'food', 'new_york', 'nutrition'],
    eligibility: { incomeLimit: '130% FPL gross' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'NY',
    source: 'state',
  },

  // ════════════════════════════════════════
  // HEALTHCARE
  // ════════════════════════════════════════
  {
    id: 'ny-medicaid',
    name: 'New York Medicaid',
    description: 'Comprehensive health coverage for low-income New Yorkers including adults, children, seniors, and people with disabilities. New York has one of the most expansive Medicaid programs in the nation with broad eligibility.',
    url: 'https://www.health.ny.gov/health_care/medicaid/',
    categories: ['health', 'insurance'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['medicaid', 'healthcare', 'new_york'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'NY',
    source: 'state',
  },

  // ════════════════════════════════════════
  // UTILITIES / ENERGY
  // ════════════════════════════════════════
  {
    id: 'ny-heap',
    name: 'New York HEAP (Home Energy Assistance Program)',
    description: 'New York\'s LIHEAP program helping low-income households pay heating costs, avoid utility shutoff, and access emergency energy assistance during extreme weather. Regular and emergency benefit cycles throughout the year.',
    url: 'https://otda.ny.gov/programs/heap/',
    categories: ['utility_assistance', 'energy'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['liheap', 'heap', 'utility', 'new_york', 'heating'],
    eligibility: { incomeLimit: '60% State Median Income' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'NY',
    source: 'state',
  },

  // ════════════════════════════════════════
  // HOUSING
  // ════════════════════════════════════════
  {
    id: 'ny-era',
    name: 'New York State Emergency Rental Assistance Program (ERAP)',
    description: 'Emergency rental and utility assistance for New York households facing housing instability due to financial hardship. Helps prevent eviction by covering unpaid rent and utility arrears.',
    url: 'https://otda.ny.gov/programs/era/',
    categories: ['housing', 'rent_assistance'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['rent', 'housing', 'new_york', 'eviction'],
    type: 'assistance',
    fundingType: 'direct_benefit',
    recurring: false,
    is_active: true,
    state: 'NY',
    source: 'state',
  },

  // ════════════════════════════════════════
  // EDUCATION
  // ════════════════════════════════════════
  {
    id: 'ny-tap',
    name: 'New York TAP (Tuition Assistance Program)',
    description: 'New York State\'s largest need-based financial aid grant for full-time students attending approved New York colleges and universities. Awards up to $5,665 per year based on income and tuition costs.',
    url: 'https://www.hesc.ny.gov/pay-for-college/financial-aid/types-of-financial-aid/nys-grants-scholarships-awards/tap.html',
    categories: ['education', 'financial_aid'],
    applicant_types: ['student'],
    intentMatch: ['college', 'tuition', 'new_york', 'financial_aid'],
    type: 'grant',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'NY',
    source: 'state',
  },

  {
    id: 'ny-excelsior-scholarship',
    name: 'Excelsior Scholarship (Free Tuition at SUNY/CUNY)',
    description: 'Covers remaining tuition costs after other grants for eligible New York residents attending SUNY or CUNY institutions. Requires full-time enrollment, income eligibility, and a commitment to live and work in New York after graduation.',
    url: 'https://www.hesc.ny.gov/excelsior',
    categories: ['education', 'financial_aid'],
    applicant_types: ['student'],
    intentMatch: ['college', 'free_tuition', 'new_york', 'suny'],
    eligibility: { incomeLimit: '$125,000 household income' },
    type: 'grant',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'NY',
    source: 'state',
  },

  // ════════════════════════════════════════
  // ARTS / CULTURE
  // ════════════════════════════════════════
  {
    id: 'ny-nysca-grants',
    name: 'New York State Council on the Arts (NYSCA) Grants',
    description: 'State arts funding for New York nonprofits, schools, and government entities supporting arts programming, cultural projects, and creative organizations. Multiple grant categories available throughout the year.',
    url: 'https://arts.ny.gov/grants',
    categories: ['arts', 'culture'],
    applicant_types: ['nonprofit', 'organization'],
    intentMatch: ['arts', 'culture', 'new_york', 'creative'],
    type: 'grant',
    fundingType: 'grant',
    recurring: true,
    is_active: true,
    state: 'NY',
    source: 'state',
  },

  // ════════════════════════════════════════
  // SMALL BUSINESS
  // ════════════════════════════════════════
  {
    id: 'ny-forward-loan-fund',
    name: 'New York Forward Loan Fund',
    description: 'Low-interest loan program for small businesses and nonprofits in New York, particularly those in industries severely impacted by COVID-19. Administered through Empire State Development to support recovery and growth.',
    url: 'https://esd.ny.gov/nyforward-loan-fund',
    categories: ['business', 'financial_assistance'],
    applicant_types: ['small_business'],
    intentMatch: ['small_business', 'loan', 'new_york', 'business'],
    type: 'assistance',
    fundingType: 'loan',
    recurring: false,
    is_active: true,
    state: 'NY',
    source: 'state',
  },

  // ════════════════════════════════════════
  // SENIORS
  // ════════════════════════════════════════
  {
    id: 'ny-office-for-aging',
    name: 'New York State Office for the Aging Programs',
    description: 'Statewide network of services for New Yorkers age 60 and older including meal programs, transportation, caregiver support, legal assistance, home care, and case management through local Area Agencies on Aging.',
    url: 'https://aging.ny.gov/',
    categories: ['senior_services', 'health', 'food'],
    applicant_types: ['individual'],
    intentMatch: ['senior', 'aging', 'new_york', 'elderly'],
    eligibility: { ageMinimum: 60 },
    type: 'assistance',
    fundingType: 'direct_service',
    recurring: true,
    is_active: true,
    state: 'NY',
    source: 'state',
    demographicMatch: ['senior'],
  },

  // ════════════════════════════════════════
  // VETERANS
  // ════════════════════════════════════════
  {
    id: 'ny-veterans-services',
    name: 'NYS Division of Veterans\' Services',
    description: 'New York State agency connecting veterans and their families to benefits, housing assistance, employment programs, mental health services, and burial honors. County Veterans Service Offices provide free claims assistance.',
    url: 'https://veterans.ny.gov/',
    categories: ['veteran_services', 'financial_assistance'],
    applicant_types: ['individual'],
    intentMatch: ['veteran', 'military', 'new_york', 'veteran_services'],
    type: 'assistance',
    fundingType: 'referral_service',
    recurring: true,
    is_active: true,
    state: 'NY',
    source: 'state',
    demographicMatch: ['veteran'],
  },

];

export default { STATE_META, STATE_BENEFITS };
