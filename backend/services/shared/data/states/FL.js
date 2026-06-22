/**
 * FL.js — Florida State Benefits
 *
 * Active programs for Florida residents (2024-2025).
 * Real URLs. Covers healthcare, utilities, education, housing,
 * business, arts, veterans, and nutrition assistance.
 */

export const STATE_META = {
  code: 'FL',
  name: 'Florida',
  benefitsPortal: 'https://www.myflorida.com/accessflorida/',
  benefitsPortalName: 'ACCESS Florida',
  medicaidName: 'Florida Medicaid',
  dhsPhone: '1-866-762-2237',
  localOfficeUrl: 'https://www.myflfamilies.com/programs-and-services/access-florida-food-medical-assistance-cash/find-an-office',
  is211Available: true,
};

export const STATE_BENEFITS = [

  // ════════════════════════════════════════
  // HEALTHCARE
  // ════════════════════════════════════════
  {
    id: 'fl-medicaid',
    name: 'Florida Medicaid',
    description: 'Health coverage for eligible low-income Floridians including children, pregnant women, seniors, and people with disabilities. Florida did not expand Medicaid under the ACA, so eligibility requirements are more restrictive than in expansion states.',
    url: 'https://ahca.myflorida.com/medicaid',
    categories: ['health', 'insurance'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['medicaid', 'healthcare', 'florida'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'FL',
    source: 'state',
  },

  {
    id: 'fl-kidcare',
    name: 'Florida KidCare (CHIP)',
    description: 'Affordable health coverage for uninsured Florida children from birth through age 18 whose families earn too much for Medicaid. Covers doctor visits, prescriptions, dental, vision, mental health, and hospital care.',
    url: 'https://www.floridakidcare.org/',
    categories: ['health', 'insurance'],
    applicant_types: ['family'],
    intentMatch: ['chip', 'children_health', 'florida'],
    eligibility: { requiresChildren: true, incomeLimit: '200% FPL' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'FL',
    source: 'state',
    familyMatch: ['has_children'],
  },

  // ════════════════════════════════════════
  // FOOD / NUTRITION
  // ════════════════════════════════════════
  {
    id: 'fl-snap',
    name: 'Florida SNAP (Supplemental Nutrition Assistance Program)',
    description: 'Monthly food assistance benefits on an EBT card for low-income Florida residents. Apply through ACCESS Florida online portal or at a local DCF service center.',
    url: 'https://www.myflfamilies.com/service-programs/food-assistance',
    categories: ['food', 'nutrition'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['snap', 'food', 'florida', 'nutrition'],
    eligibility: { incomeLimit: '130% FPL gross' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'FL',
    source: 'state',
  },

  // ════════════════════════════════════════
  // UTILITIES / ENERGY
  // ════════════════════════════════════════
  {
    id: 'fl-liheap',
    name: 'Florida LIHEAP (Low Income Home Energy Assistance Program)',
    description: 'Helps low-income Florida households pay cooling and heating energy costs. Florida\'s hot climate makes cooling assistance a priority. Administered through the Department of Children and Families and local community action agencies.',
    url: 'https://www.myflfamilies.com/service-programs/energy-assistance',
    categories: ['utility_assistance', 'energy'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['liheap', 'utility', 'florida', 'energy'],
    eligibility: { incomeLimit: '150% FPL' },
    type: 'benefit',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'FL',
    source: 'state',
  },

  // ════════════════════════════════════════
  // EDUCATION
  // ════════════════════════════════════════
  {
    id: 'fl-bright-futures',
    name: 'Florida Bright Futures Scholarship',
    description: 'Merit-based scholarship for Florida high school graduates attending Florida colleges and universities. Three award levels (Florida Academic Scholars, Medallion Scholars, Gold Seal Vocational Scholars) based on GPA and test scores.',
    url: 'https://www.floridastudentfinancialaidsg.org/SAPubHome',
    categories: ['education', 'financial_aid'],
    applicant_types: ['student'],
    intentMatch: ['scholarship', 'college', 'florida', 'merit'],
    type: 'grant',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'FL',
    source: 'state',
  },

  {
    id: 'fl-first-generation-grant',
    name: 'Florida First Generation Matching Grant',
    description: 'Need-based grants for Florida undergraduate students who are the first in their family to attend college. Requires matching funds from participating institutions and priority is given to students with greatest financial need.',
    url: 'https://www.floridastudentfinancialaidsg.org/SAPubHome',
    categories: ['education', 'financial_aid'],
    applicant_types: ['student'],
    intentMatch: ['first_generation', 'college', 'florida', 'financial_aid'],
    type: 'grant',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'FL',
    source: 'state',
  },

  // ════════════════════════════════════════
  // HOUSING
  // ════════════════════════════════════════
  {
    id: 'fl-housing-finance',
    name: 'Florida Housing Finance Corporation Programs',
    description: 'State agency offering affordable rental housing, down payment assistance, and homeownership programs for income-eligible Floridians. Manages the SHIP and HOME programs, as well as the State Housing Initiatives Partnership.',
    url: 'https://www.floridahousing.org/',
    categories: ['housing', 'rent_assistance'],
    applicant_types: ['individual', 'family'],
    intentMatch: ['housing', 'rent', 'florida', 'affordable_housing'],
    type: 'assistance',
    fundingType: 'direct_service',
    recurring: true,
    is_active: true,
    state: 'FL',
    source: 'state',
  },

  // ════════════════════════════════════════
  // SMALL BUSINESS
  // ════════════════════════════════════════
  {
    id: 'fl-small-business-bridge-loan',
    name: 'Florida Small Business Emergency Bridge Loan Program',
    description: 'Short-term, interest-free loans for Florida small businesses experiencing economic injury due to a disaster or emergency. Bridges the gap while businesses pursue longer-term recovery financing through SBA and other sources.',
    url: 'https://www.floridajobs.org/business-growth-and-partnerships/small-business-assistance/emergency-bridge-loan-program',
    categories: ['business', 'financial_assistance'],
    applicant_types: ['small_business'],
    intentMatch: ['small_business', 'florida', 'loan', 'emergency'],
    type: 'assistance',
    fundingType: 'loan',
    recurring: false,
    is_active: true,
    state: 'FL',
    source: 'state',
  },

  // ════════════════════════════════════════
  // ARTS / CULTURE
  // ════════════════════════════════════════
  {
    id: 'fl-division-cultural-affairs',
    name: 'Florida Division of Cultural Affairs Grants',
    description: 'State arts funding for Florida nonprofits, local governments, and schools supporting arts programming, cultural facilities, and community cultural development through multiple grant programs.',
    url: 'https://dos.myflorida.com/cultural/',
    categories: ['arts', 'culture'],
    applicant_types: ['nonprofit', 'organization'],
    intentMatch: ['arts', 'culture', 'florida', 'nonprofit'],
    type: 'grant',
    fundingType: 'grant',
    recurring: true,
    is_active: true,
    state: 'FL',
    source: 'state',
  },

  // ════════════════════════════════════════
  // VETERANS
  // ════════════════════════════════════════
  {
    id: 'fl-veterans-benefits',
    name: 'Florida Veterans Benefits (Florida Department of Veterans\' Affairs)',
    description: 'Florida state veterans\' benefits including property tax exemptions, education assistance, employment preferences, specialty license plates, and access to state veterans\' nursing homes. Free claims assistance from accredited VSOs.',
    url: 'https://floridavets.org/',
    categories: ['veteran_services', 'financial_assistance'],
    applicant_types: ['individual'],
    intentMatch: ['veteran', 'florida', 'military_benefits'],
    type: 'assistance',
    fundingType: 'direct_benefit',
    recurring: true,
    is_active: true,
    state: 'FL',
    source: 'state',
    demographicMatch: ['veteran'],
  },

];

export default { STATE_META, STATE_BENEFITS };
