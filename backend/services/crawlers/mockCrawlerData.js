/**
 * Mock data for testing crawlers without external dependencies
 * Simulates real funding opportunities that would be scraped
 */

export const mockLocalFunding = [
  {
    title: 'Columbus Community Foundation Grant',
    sponsor: 'Columbus Community Foundation',
    description: 'Support for local nonprofits serving Franklin County',
    url: 'https://columbusfoundation.org/grants',
    amount_min: 5000,
    amount_max: 25000,
    deadline: '2025-03-31',
    eligibility: '501(c)(3) nonprofits serving Franklin County',
    latitude: 39.9612,
    longitude: -82.9988
  },
  {
    title: 'United Way Central Ohio Emergency Fund',
    sponsor: 'United Way of Central Ohio',
    description: 'Emergency assistance for community organizations',
    url: 'https://liveunitedcentralohio.org',
    amount_min: 2500,
    amount_max: 15000,
    deadline: 'Rolling',
    eligibility: 'Organizations providing emergency services',
    latitude: 40.0150,
    longitude: -83.0130
  }
]

export const mockGovernmentFunding = [
  {
    title: 'NIH Small Business Innovation Research (SBIR)',
    sponsor: 'National Institutes of Health',
    description: 'Funding for health-related research and development',
    url: 'https://grants.nih.gov/grants/guide/pa-files/PA-20-265.html',
    opportunity_number: 'PA-20-265',
    amount_min: 150000,
    amount_max: 1000000,
    deadline: '2025-04-05',
    eligibility: 'Small businesses with research capabilities',
    cfda_number: '93.855'
  },
  {
    title: 'FEMA Hazard Mitigation Grant',
    sponsor: 'Federal Emergency Management Agency',
    description: 'Funding for disaster risk reduction',
    url: 'https://www.fema.gov/grants/mitigation',
    amount_min: 10000,
    amount_max: 500000,
    deadline: '2025-06-30',
    eligibility: 'State and local governments, nonprofits'
  }
]

export const mockStudentGrants = [
  {
    title: 'Federal Pell Grant',
    sponsor: 'U.S. Department of Education',
    description: 'Need-based grant for undergraduate students',
    url: 'https://studentaid.gov/understand-aid/types/grants/pell',
    amount_min: 750,
    amount_max: 7395,
    deadline: 'June 30, 2025',
    eligibility: 'Demonstrate financial need, US citizen',
    grant_type: 'need_based'
  },
  {
    title: 'Ohio State Merit Scholarship',
    sponsor: 'Ohio State University',
    description: 'Merit-based scholarship for high-achieving students',
    url: 'https://sfa.osu.edu',
    amount_min: 5000,
    amount_max: 20000,
    deadline: 'February 1, 2025',
    eligibility: 'Minimum 3.5 GPA, SAT 1400+ or ACT 32+',
    school_specific: true
  }
]

export const mockECFBenefits = [
  {
    title: 'ECF CHOICES Essential Supports',
    sponsor: 'TennCare',
    description: 'Employment and community living supports',
    url: 'https://www.tn.gov/tenncare',
    amount_min: 0,
    amount_max: 50000,
    deadline: 'Ongoing',
    eligibility: 'Intellectual or developmental disability',
    benefit_categories: ['employment', 'community_living']
  },
  {
    title: 'CLS-FM Provider Reimbursement',
    sponsor: 'Tennessee DIDD',
    description: 'Reimbursement for Family Model providers',
    url: 'https://www.tn.gov/didd',
    amount_min: 2000,
    amount_max: 6000,
    deadline: 'Ongoing',
    eligibility: 'Licensed CLS-FM provider',
    benefit_categories: ['provider_reimbursement']
  }
]

export const mockItemFunding = [
  {
    title: '15-Passenger Van Grant',
    sponsor: 'Transportation Foundation',
    description: 'Grants for vans for nonprofits serving communities',
    url: 'https://example.org/vans',
    amount_min: 20000,
    amount_max: 50000,
    deadline: 'Quarterly',
    eligibility: 'Nonprofit with transportation needs for 10+ people',
    item_categories: ['vehicle', 'van', 'transportation']
  },
  {
    title: 'Technology Equipment Grant',
    sponsor: 'TechSoup',
    description: 'Donated technology for nonprofits',
    url: 'https://www.techsoup.org',
    amount_min: 1000,
    amount_max: 10000,
    deadline: 'Ongoing',
    eligibility: '501(c)(3) nonprofit organization',
    item_categories: ['technology', 'computers', 'equipment']
  }
]

export const mockSpecialNeeds = [
  {
    title: 'Cancer Patient Financial Assistance',
    sponsor: 'American Cancer Society',
    description: 'Financial help for cancer patients',
    url: 'https://www.cancer.org',
    amount_min: 500,
    amount_max: 5000,
    deadline: 'Ongoing',
    eligibility: 'Current or past cancer diagnosis',
    assistance_types: ['medical_bills', 'living_expenses']
  },
  {
    title: 'Single Parent Emergency Fund',
    sponsor: 'Single Parent Advocate',
    description: 'Emergency assistance for single parents',
    url: 'https://singleparentadvocate.org',
    amount_min: 250,
    amount_max: 2500,
    deadline: 'Ongoing',
    eligibility: 'Single parent with emergency need',
    assistance_types: ['emergency', 'housing', 'utilities']
  }
]