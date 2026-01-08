/**
 * Helper functions for all crawlers
 * Provides common utilities and mock data
 */

export function getProfileWithLocation(db, profileId) {
  // Get profile with organization location data
  const query = `
    SELECT 
      p.*,
      COALESCE(o.state, 'OH') as state,
      COALESCE(o.city, 'Columbus') as city,
      COALESCE(o.zip, '43215') as zip_code,
      o.name as organization_name,
      o.type as organization_type
    FROM profiles p
    LEFT JOIN organizations o ON p.organization_id = o.id
    WHERE p.id = ?
  `
  
  const profile = db.prepare(query).get(profileId)
  
  // Ensure profile has required fields
  if (profile) {
    profile.state = profile.state || 'OH'
    profile.city = profile.city || 'Columbus'
    profile.zip_code = profile.zip_code || '43215'
  }
  
  return profile
}

export function calculateMatchScore(opportunity, profile) {
  let score = 50 // Base score
  
  // Geographic match
  if (opportunity.state === profile.state) {
    score += 20
  }
  
  // Type match
  if (opportunity.applicant_type === profile.primary_type) {
    score += 15
  }
  
  // Random variation for testing
  score += Math.floor(Math.random() * 35)
  
  return Math.min(100, score)
}

export function getMockOpportunities(crawlerType, profile) {
  const baseOpportunities = {
    local_funding: [
      {
        title: `${profile.city} Community Development Grant`,
        description: 'Local funding for community organizations and initiatives',
        amount: '$5,000 - $25,000',
        sponsor: `City of ${profile.city}`,
        deadline: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        url: `https://example.gov/${profile.city.toLowerCase()}/grants`,
        eligibility: ['Local organizations', 'Community impact focus'],
        match_score: 85
      },
      {
        title: `${profile.state} Housing Assistance Program`,
        description: 'Support for housing improvements and accessibility modifications',
        amount: 'Up to $15,000',
        sponsor: `${profile.state} Housing Authority`,
        deadline: 'Rolling',
        url: `https://${profile.state.toLowerCase()}.gov/housing-assistance`,
        eligibility: ['Low-income residents', 'Property owners'],
        match_score: 82
      },
      {
        title: 'Regional Foundation Community Grant',
        description: 'Supporting local nonprofits and community programs',
        amount: '$10,000 - $50,000',
        sponsor: 'Community Foundation',
        deadline: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        url: 'https://communityfoundation.org/grants',
        eligibility: ['501(c)(3) organizations', 'Local service area'],
        match_score: 88
      }
    ],
    government_funding: [
      {
        title: 'HHS Community Services Block Grant',
        description: 'Federal funding for anti-poverty programs',
        amount: '$50,000 - $200,000',
        sponsor: 'U.S. Department of Health and Human Services',
        deadline: new Date(Date.now() + 120 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        url: 'https://www.acf.hhs.gov/ocs/programs/csbg',
        eligibility: ['Community Action Agencies', 'Nonprofit organizations'],
        match_score: 90
      },
      {
        title: 'USDA Rural Development Grant',
        description: 'Funding for rural communities and organizations',
        amount: '$25,000 - $100,000',
        sponsor: 'USDA Rural Development',
        deadline: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        url: 'https://www.rd.usda.gov/programs-services',
        eligibility: ['Rural communities', 'Population under 50,000'],
        match_score: 81
      },
      {
        title: `${profile.state} Economic Development Grant`,
        description: 'State funding for economic growth initiatives',
        amount: '$30,000 - $150,000',
        sponsor: `${profile.state} Department of Development`,
        deadline: 'Quarterly',
        url: `https://${profile.state.toLowerCase()}.gov/development/grants`,
        eligibility: ['Businesses', 'Nonprofits', 'Local governments'],
        match_score: 86
      }
    ],
    student_grants: [
      {
        title: 'Federal Pell Grant',
        description: 'Need-based grant for undergraduate students',
        amount: 'Up to $7,395',
        sponsor: 'U.S. Department of Education',
        deadline: 'June 30',
        url: 'https://studentaid.gov/understand-aid/types/grants/pell',
        eligibility: ['Undergraduate students', 'Demonstrated financial need'],
        match_score: 95
      },
      {
        title: `${profile.state} Student Success Grant`,
        description: 'State grant for college students',
        amount: '$1,000 - $5,000',
        sponsor: `${profile.state} Higher Education Commission`,
        deadline: 'March 1',
        url: `https://${profile.state.toLowerCase()}.gov/highered/grants`,
        eligibility: ['State residents', 'Full-time enrollment'],
        match_score: 87
      },
      {
        title: 'STEM Excellence Scholarship',
        description: 'Merit-based award for STEM students',
        amount: '$10,000',
        sponsor: 'National Science Foundation',
        deadline: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        url: 'https://www.nsf.gov/funding/students',
        eligibility: ['STEM majors', 'GPA 3.5+'],
        match_score: 83
      }
    ],
    ecf_benefits: [
      {
        title: 'ECF CHOICES Waiver Services',
        description: 'Comprehensive support for individuals with disabilities',
        amount: 'Varies by need',
        sponsor: `${profile.state} Department of Developmental Disabilities`,
        deadline: 'Rolling enrollment',
        url: `https://${profile.state.toLowerCase()}.gov/ecf-choices`,
        eligibility: ['Individuals with disabilities', 'Medicaid eligible'],
        match_score: 92
      },
      {
        title: 'Respite Care Program',
        description: 'Support for caregivers of individuals with special needs',
        amount: 'Up to 40 hours/month',
        sponsor: 'Regional DD Board',
        deadline: 'Open enrollment',
        url: 'https://ddboard.org/respite',
        eligibility: ['Family caregivers', 'Qualified individuals'],
        match_score: 88
      },
      {
        title: 'Assistive Technology Grant',
        description: 'Funding for adaptive equipment and technology',
        amount: '$500 - $5,000',
        sponsor: 'Assistive Technology Program',
        deadline: 'Quarterly',
        url: 'https://atprogram.org/grants',
        eligibility: ['Individuals with disabilities', 'Documented need'],
        match_score: 85
      }
    ],
    item_matching: [
      {
        title: 'Equipment Purchase Grant',
        description: 'Funding for essential equipment and supplies',
        amount: '$1,000 - $10,000',
        sponsor: 'Equipment Foundation',
        deadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        url: 'https://equipmentfoundation.org/apply',
        eligibility: ['Nonprofits', 'Specific equipment needs'],
        match_score: 84
      },
      {
        title: 'Vehicle Donation Program',
        description: 'Donated vehicles for qualifying organizations',
        amount: 'Vehicle value',
        sponsor: 'Vehicles for Change',
        deadline: 'Rolling',
        url: 'https://vehiclesforchange.org',
        eligibility: ['501(c)(3) organizations', 'Transportation need'],
        match_score: 81
      },
      {
        title: 'Technology Grant Program',
        description: 'Computers and technology for nonprofits',
        amount: 'Up to $20,000 in equipment',
        sponsor: 'Tech for Good',
        deadline: 'Bi-annual',
        url: 'https://techforgood.org/grants',
        eligibility: ['Nonprofits', 'Technology needs assessment'],
        match_score: 86
      }
    ],
    special_needs: [
      {
        title: 'Autism Support Services Grant',
        description: 'Funding for autism programs and services',
        amount: '$5,000 - $30,000',
        sponsor: 'Autism Foundation',
        deadline: new Date(Date.now() + 75 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        url: 'https://autismfoundation.org/grants',
        eligibility: ['Autism service providers', 'Families affected by autism'],
        match_score: 89
      },
      {
        title: 'Single Parent Support Fund',
        description: 'Emergency assistance for single-parent families',
        amount: '$500 - $2,500',
        sponsor: 'Family Support Network',
        deadline: 'Monthly review',
        url: 'https://familysupport.org/single-parents',
        eligibility: ['Single parents', 'Financial hardship'],
        match_score: 83
      },
      {
        title: 'Disability Advocacy Grant',
        description: 'Supporting disability rights and advocacy',
        amount: '$10,000 - $50,000',
        sponsor: 'Disability Rights Fund',
        deadline: 'Annual',
        url: 'https://disabilityrightsfund.org',
        eligibility: ['Disability organizations', 'Advocacy focus'],
        match_score: 87
      }
    ]
  }
  
  return baseOpportunities[crawlerType] || []
}

export function formatOpportunity(opp, profile) {
  return {
    title: opp.title,
    description: opp.description,
    amount: opp.amount,
    sponsor: opp.sponsor,
    deadline: opp.deadline,
    url: opp.url,
    eligibility_criteria: opp.eligibility,
    match_score: opp.match_score || calculateMatchScore(opp, profile),
    source: 'crawler',
    state: profile.state,
    is_loan: false,
    requires_match: false
  }
}

export default {
  getProfileWithLocation,
  calculateMatchScore,
  getMockOpportunities,
  formatOpportunity
}