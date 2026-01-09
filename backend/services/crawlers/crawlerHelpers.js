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
  
  // Deterministic scoring based on opportunity and profile characteristics
  // Category/keyword alignment (0-15 points)
  const oppText = `${opportunity.title} ${opportunity.description}`.toLowerCase()
  const profileKeywords = profile.keywords || profile.focus_areas || []
  const matchedKeywords = profileKeywords.filter(keyword => 
    oppText.includes(keyword.toLowerCase())
  )
  score += Math.min(15, matchedKeywords.length * 3)
  
  // Eligibility alignment (0-10 points)
  const eligText = (opportunity.eligibility_criteria || opportunity.eligibility || '').toLowerCase()
  const profileType = (profile.organization_type || profile.primary_type || '').toLowerCase()
  if (eligText.includes(profileType)) {
    score += 10
  }
  
  return Math.min(100, score)
}

// REMOVED: getMockOpportunities() function
// All crawlers must use real data connectors, not mock data
// See backend/services/connectors/ for real API integrations

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
  formatOpportunity
}