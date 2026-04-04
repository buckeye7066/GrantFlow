/**
 * IL.js — Illinois State Benefits
 *
 * Active programs for Illinois residents (2024-2025).
 * Real URLs. Covers healthcare, food, utilities, housing,
 * education, business, arts, seniors, and veterans.
 */

export const STATE_META = {
  code: 'IL',
  name: 'Illinois',
  benefitsPortal: 'https://abe.illinois.gov/',
  benefitsPortalName: 'ABE (Application for Benefits Eligibility)',
  medicaidName: 'Illinois Medicaid',
  dhsPhone: '1-800-843-6154',
  localOfficeUrl: 'https://www.dhs.state.il.us/page.aspx?item=34775',
  is211Available: true,
};

export const STATE_BENEFITS = [

  // ════════════════════════════════════════
  // HEALTHCARE
  // ════════════════════════════════════════
  {
    id: 'il-medicaid',
    name: 'Illinois Medicaid (Medical Assistance Program)',
    description: 'Comprehensive health coverage for low-income Illinois residents including adults, children, seniors, and people with disabilities. Illinois expanded Medicaid under the ACA, providing broad eligibility for adults up to 138% FPL.',
    url: 'https://www.illinois.gov/hfs/MedicalClients/Pages/default.aspx',
    categories: ['health', 'insurance'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['medicaid', 'healthcare', 'illinois'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'IL',
    source: 'state',
  },

  // ════════════════════════════════════════
  // FOOD / NUTRITION
  // ════════════════════════════════════════
  {
    id: 'il-snap',
    name: 'Illinois SNAP (Supplemental Nutrition Assistance Program)',
    description: 'Monthly food assistance benefits on a Link Card (EBT) for low-income Illinois households. Apply through the ABE online portal or at a local DHS office. Illinois uses categorical eligibility for broader access.',
    url: 'https://www.dhs.state.il.us/page.aspx?item=30357',
    categories: ['food', 'nutrition'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['snap', 'food', 'illinois', 'nutrition'],
    eligibility: { incomeLimit: '130% FPL gross' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'IL',
    source: 'state',
  },

  // ════════════════════════════════════════
  // UTILITIES / ENERGY
  // ════════════════════════════════════════
  {
    id: 'il-liheap',
    name: 'Illinois LIHEAP (Low Income Home Energy Assistance Program)',
    description: 'Helps low-income Illinois households pay heating and cooling costs and avoid utility shutoff. Administered through the Department of Commerce and Economic Opportunity (DCEO) and local community action agencies.',
    url: 'https://www.cca.illinois.gov/liheap',
    categories: ['utility_assistance', 'energy'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['liheap', 'utility', 'illinois', 'energy', 'heating'],
    eligibility: { incomeLimit: '150% FPL' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'IL',
    source: 'state',
  },

  // ════════════════════════════════════════
  // HOUSING
  // ════════════════════════════════════════
  {
    id: 'il-rental-payment-program',
    name: 'Illinois Rental Payment Program (ILRPP)',
    description: 'Emergency rental assistance for Illinois residents facing housing instability. Provides up to 15 months of rental and utility assistance for income-eligible households. Administered through the Illinois Housing Development Authority.',
    url: 'https://www.illinoishousinghelp.org/',
    categories: ['housing', 'rent_assistance'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['rent', 'housing', 'illinois', 'eviction'],
    type: 'assistance',
    fundingType: 'direct_benefit',
    recurring: false,
    is_active: true,
    state: 'IL',
    source: 'state',
  },

  // ════════════════════════════════════════
  // EDUCATION
  // ════════════════════════════════════════
  {
    id: 'il-map-grant',
    name: 'Illinois Monetary Award Program (MAP Grant)',
    description: 'Illinois\'s primary need-based grant for undergraduate students attending approved Illinois colleges. Awards up to $5,466 per year (2024-25) for students with significant financial need. File FAFSA early as funds are limited.',
    url: 'https://www.isac.org/students/during-college/types-of-aid/grants/monetary-award-program/',
    categories: ['education', 'financial_aid'],
    applicant_types: ['student'],
    intentMatch: ['college', 'grant', 'illinois', 'financial_aid'],
    eligibility: { incomeLimit: 'Based on EFC from FAFSA' },
    type: 'grant',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'IL',
    source: 'state',
  },

  // ════════════════════════════════════════
  // SMALL BUSINESS
  // ════════════════════════════════════════
  {
    id: 'il-sbdc-grants',
    name: 'Illinois Small Business Development Center (SBDC) Programs',
    description: 'Illinois DCEO provides grants and technical assistance to small businesses through the statewide SBDC network. Includes programs for women, minority, and veteran entrepreneurs, plus disaster recovery support.',
    url: 'https://www2.illinois.gov/dceo/SmallBizAssistance/Pages/default.aspx',
    categories: ['business', 'financial_assistance'],
    applicant_types: ['small_business'],
    intentMatch: ['small_business', 'illinois', 'business_assistance'],
    type: 'grant',
    fundingType: 'grant',
    recurring: true,
    is_active: true,
    state: 'IL',
    source: 'state',
  },

  // ════════════════════════════════════════
  // ARTS / CULTURE
  // ════════════════════════════════════════
  {
    id: 'il-arts-council-grants',
    name: 'Illinois Arts Council Agency Grants',
    description: 'State arts funding for Illinois nonprofits, schools, units of local government, and artists supporting arts programming, creative placemaking, and cultural development across the state.',
    url: 'https://arts.illinois.gov/grants',
    categories: ['arts', 'culture'],
    applicant_types: ['nonprofit', 'organization'],
    intentMatch: ['arts', 'culture', 'illinois', 'nonprofit'],
    type: 'grant',
    fundingType: 'grant',
    recurring: true,
    is_active: true,
    state: 'IL',
    source: 'state',
  },

  // ════════════════════════════════════════
  // SENIORS
  // ════════════════════════════════════════
  {
    id: 'il-community-care-program',
    name: 'Illinois Department on Aging — Community Care Program',
    description: 'In-home and community services for Illinoisans age 60 and older, helping seniors remain in their homes and communities. Services include homemaker assistance, adult day services, emergency home response, and case management.',
    url: 'https://www2.illinois.gov/aging/Pages/default.aspx',
    categories: ['senior_services', 'health'],
    applicant_types: ['individual'],
    intentMatch: ['senior', 'aging', 'illinois', 'elder_care'],
    eligibility: { ageMinimum: 60 },
    type: 'assistance',
    fundingType: 'direct_service',
    recurring: true,
    is_active: true,
    state: 'IL',
    source: 'state',
    demographicMatch: ['senior'],
  },

  // ════════════════════════════════════════
  // VETERANS
  // ════════════════════════════════════════
  {
    id: 'il-veterans-assistance',
    name: 'Illinois Veterans Assistance Commission',
    description: 'Illinois county-based network providing emergency financial assistance, benefits counseling, and referrals to veterans and their families. Helps with VA claims, housing, employment, and access to state and federal veterans benefits.',
    url: 'https://www.illinois.gov/sites/veterans/',
    categories: ['veteran_services', 'financial_assistance'],
    applicant_types: ['individual'],
    intentMatch: ['veteran', 'illinois', 'military_benefits'],
    type: 'assistance',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'IL',
    source: 'state',
    demographicMatch: ['veteran'],
  },

  // ════════════════════════════════════════
  // COMMUNITY SERVICES
  // ════════════════════════════════════════
  {
    id: 'il-csbg',
    name: 'Illinois Community Services Block Grant (CSBG)',
    description: 'Funds Illinois community action agencies providing emergency assistance with utilities, food, housing, employment, and other basic needs to individuals and families living in poverty across all 102 counties.',
    url: 'https://www.caa.illinois.gov/',
    categories: ['financial_assistance', 'community_services'],
    applicant_types: ['individual', 'family', 'nonprofit'],
    intentMatch: ['community', 'poverty', 'illinois', 'social_services'],
    type: 'assistance',
    fundingType: 'direct_service',
    recurring: true,
    is_active: true,
    state: 'IL',
    source: 'state',
  },

];

export default { STATE_META, STATE_BENEFITS };
