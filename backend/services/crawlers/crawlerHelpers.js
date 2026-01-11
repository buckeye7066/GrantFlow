/**
 * Helper functions for all crawlers
 * Provides common utilities and mock data
 */

import { loadProfileContext, extractStateFromContext, extractZipFromContext, extractCityFromContext } from '../profileHelpers.js'

export function getProfileWithLocation(db, profileId) {
  // Load the full profile context (profile + all profile_sections + derived signals).
  // IMPORTANT: Do not fabricate fallback location data; missing location should be treated as missing data.
  const context = loadProfileContext(db, profileId)

  const organization =
    context?.profile?.organization_id
      ? db
          .prepare('SELECT id, name, type, city, state, zip FROM organizations WHERE id = ?')
          .get(context.profile.organization_id)
      : null

  const derivedLocation = {
    state: extractStateFromContext({ profile: context.profile, sections: context.sections }),
    city: extractCityFromContext({ profile: context.profile, sections: context.sections }),
    zip_code: extractZipFromContext({ profile: context.profile, sections: context.sections }),
  }

  return {
    ...context.profile,
    // Attach full context for crawlers that can use it.
    sections: context.sections,
    signals: context.signals,
    // Keep legacy location keys expected by crawler implementations.
    state: derivedLocation.state ?? organization?.state ?? null,
    city: derivedLocation.city ?? organization?.city ?? null,
    zip_code: derivedLocation.zip_code ?? organization?.zip ?? null,
    organization_name: organization?.name ?? null,
    organization_type: organization?.type ?? null,
  }
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