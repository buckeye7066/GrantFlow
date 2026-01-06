/**
 * Opportunity Matcher and Pipeline Manager
 * Evaluates opportunity matches and saves to appropriate pipelines
 * ENHANCED: Uses ALL profile data points for comprehensive matching
 */

import { buildProfileSignals } from './profileHelpers.js'

/**
 * Calculate match percentage between opportunity and profile
 * Uses comprehensive profile signals including:
 * - Demographics (age, gender, ethnicity, etc.)
 * - Military/veteran status
 * - Health/disability status
 * - Financial need indicators
 * - Government assistance programs
 * - Family situation
 * - Education level
 * - Geographic location
 * - Interests and focus areas
 */
function calculateMatchPercentage(opportunity, profileContext) {
  if (!profileContext) return 0
  
  const { profile, sections, signals: prebuiltSignals } = profileContext
  if (!profile) return 0
  
  // Use prebuilt signals if available, otherwise build from context
  const signals = prebuiltSignals || buildProfileSignals({ profile, sections: sections || {} })
  
  let score = 40 // Base score - must earn the rest
  let matchStrength = 0 // Track category matches
  const matchedFields = []
  
  // Parse opportunity data
  let oppKeywords = []
  let oppCategories = []
  let eligibility = []
  
  try { 
    oppKeywords = Array.isArray(opportunity.keywords) 
      ? opportunity.keywords 
      : JSON.parse(opportunity.keywords || '[]')
  } catch (e) { /* ignore */ }
  
  try { 
    oppCategories = Array.isArray(opportunity.categories) 
      ? opportunity.categories 
      : JSON.parse(opportunity.categories || '[]')
  } catch (e) { /* ignore */ }
  
  try { 
    eligibility = Array.isArray(opportunity.eligibility_bullets) 
      ? opportunity.eligibility_bullets 
      : JSON.parse(opportunity.eligibility_bullets || '[]')
  } catch (e) { /* ignore */ }
  
  const oppTerms = new Set([
    ...oppKeywords.map(k => String(k).toLowerCase()),
    ...oppCategories.map(c => String(c).toLowerCase()),
    ...eligibility.map(e => String(e).toLowerCase())
  ])
  
  const oppText = `${opportunity.title || ''} ${opportunity.description || ''} ${opportunity.summary || ''}`.toLowerCase()
  
  // KEYWORD MATCHING (up to 20 points)
  let keywordMatches = 0
  if (signals.keywordSet && signals.keywordSet.size > 0) {
    signals.keywordSet.forEach(keyword => {
      for (const term of oppTerms) {
        if (term.includes(keyword) || keyword.includes(term)) {
          keywordMatches++
          break
        }
      }
      if (oppText.includes(keyword)) keywordMatches += 0.5
    })
  }
  if (keywordMatches > 0) {
    score += Math.min(20, Math.floor(keywordMatches * 3))
    matchStrength++
    matchedFields.push(`${Math.floor(keywordMatches)} keyword matches`)
  }
  
  // DEMOGRAPHIC MATCHING (up to 15 points)
  let demoMatches = 0
  if (signals.demographics && signals.demographics.size > 0) {
    signals.demographics.forEach(demo => {
      for (const term of oppTerms) {
        if (term.includes(demo) || demo.includes(term) || oppText.includes(demo)) {
          demoMatches++
          break
        }
      }
    })
  }
  if (demoMatches > 0) {
    score += Math.min(15, demoMatches * 5)
    matchStrength++
    matchedFields.push('demographic match')
  }
  
  // MILITARY/VETERAN MATCHING (up to 15 points)
  let militaryMatches = 0
  if (signals.military && signals.military.size > 0) {
    signals.military.forEach(mil => {
      for (const term of oppTerms) {
        if (term.includes(mil) || mil.includes(term) || oppText.includes(mil)) {
          militaryMatches++
          break
        }
      }
    })
  }
  if (militaryMatches > 0) {
    score += Math.min(15, militaryMatches * 5)
    matchStrength++
    matchedFields.push('military/veteran match')
  }
  
  // ASSISTANCE PROGRAM MATCHING (up to 10 points)
  let assistMatches = 0
  if (signals.assistance && signals.assistance.size > 0) {
    signals.assistance.forEach(assist => {
      const assistNorm = assist.replace(/_/g, ' ')
      for (const term of oppTerms) {
        if (term.includes(assistNorm) || assistNorm.includes(term) || oppText.includes(assistNorm)) {
          assistMatches++
          break
        }
      }
    })
  }
  if (assistMatches > 0) {
    score += Math.min(10, assistMatches * 5)
    matchStrength++
    matchedFields.push('assistance program match')
  }
  
  // INTERESTS/FOCUS AREAS (up to 15 points)
  let interestMatches = 0
  if (signals.interests && signals.interests.size > 0) {
    signals.interests.forEach(interest => {
      for (const term of oppTerms) {
        if (term.includes(interest) || interest.includes(term) || oppText.includes(interest)) {
          interestMatches++
          break
        }
      }
    })
  }
  if (signals.phrases && signals.phrases.size > 0) {
    signals.phrases.forEach(phrase => {
      if (oppText.includes(phrase)) interestMatches += 0.5
    })
  }
  if (interestMatches > 0) {
    score += Math.min(15, Math.floor(interestMatches * 4))
    matchStrength++
    matchedFields.push('interest/focus match')
  }
  
  // LOCATION MATCHING (up to 10 points)
  if (signals.location) {
    const { state, zip, city } = signals.location
    if (state && opportunity.state) {
      if (opportunity.state.toLowerCase() === state.toLowerCase() || 
          opportunity.state.toLowerCase() === 'nationwide' ||
          oppText.includes(state.toLowerCase())) {
        score += 10
        matchStrength++
        matchedFields.push('location match')
      }
    } else if (opportunity.is_national || opportunity.state === 'nationwide') {
      score += 8
      matchStrength++
    }
  }
  
  // APPLICANT TYPE MATCHING (up to 10 points)
  if (signals.applicantTypes && signals.applicantTypes.size > 0) {
    let typeMatch = false
    signals.applicantTypes.forEach(type => {
      for (const term of oppTerms) {
        if (term.includes(type) || type.includes(term)) {
          typeMatch = true
          break
        }
      }
    })
    if (typeMatch) {
      score += 10
      matchStrength++
      matchedFields.push('applicant type match')
    }
  }
  
  // MULTI-CATEGORY BONUS (up to 10 points)
  if (matchStrength >= 5) {
    score += 10
    matchedFields.push('excellent multi-category fit')
  } else if (matchStrength >= 3) {
    score += 5
    matchedFields.push('good multi-category fit')
  }
  
  const finalScore = Math.min(100, Math.round(score))
  return finalScore
}

/**
 * Save opportunity to profile pipeline if match > 80%
 */
export function saveToProfilePipeline(db, opportunity, profileId, profileContext, matchPercentage = null) {
  try {
    // Calculate match if not provided
    if (matchPercentage === null) {
      matchPercentage = calculateMatchPercentage(opportunity, profileContext)
    }
    
    // Only save to pipeline if match > 80%
    if (matchPercentage < 80) {
      return {
        saved: false,
        reason: `Match score ${matchPercentage}% below 80% threshold`
      }
    }
    
    // Get organization_id for this profile
    const profile = db.prepare(`
      SELECT organization_id FROM profiles WHERE id = ?
    `).get(profileId)
    
    if (!profile?.organization_id) {
      return {
        saved: false,
        reason: 'Profile has no organization'
      }
    }
    
    // Check if already in pipeline
    const existing = db.prepare(`
      SELECT id FROM grants
      WHERE organization_id = ? AND funding_opportunity_id = ?
    `).get(profile.organization_id, opportunity.id)
    
    if (existing) {
      return {
        saved: false,
        reason: 'Already in pipeline'
      }
    }
    
    // Add to pipeline
    db.prepare(`
      INSERT INTO grants (
        organization_id,
        funding_opportunity_id,
        title,
        funder,
        status,
        deadline,
        notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      profile.organization_id,
      opportunity.id,
      opportunity.title,
      opportunity.sponsor,
      'discovered',
      opportunity.deadline,
      `Auto-added: ${matchPercentage}% match for profile ${profileId}`
    )
    
    console.log(`[opportunityMatcher] Added to pipeline: ${opportunity.title} (${matchPercentage}% match for profile ${profileId})`)
    
    return {
      saved: true,
      matchPercentage,
      pipelineId: db.prepare('SELECT last_insert_rowid() as id').get().id
    }
  } catch (error) {
    console.error('[opportunityMatcher] Error saving to pipeline:', error)
    return {
      saved: false,
      reason: error.message
    }
  }
}

/**
 * Save all opportunities globally (to the opportunities table)
 * This is already handled by upsertFundingOpportunity, but we can track it
 */
export function trackGlobalOpportunity(db, opportunity) {
  try {
    // Log that this opportunity was saved globally
    const trackingQuery = db.prepare(`
      INSERT INTO crawler_logs (
        crawler_type,
        profile_id,
        status,
        message,
        created_at
      ) VALUES (?, ?, ?, ?, datetime('now'))
    `)
    
    trackingQuery.run(
      opportunity.source || 'unknown',
      null, // Global, not profile-specific
      'success',
      `Saved opportunity globally: ${opportunity.title}`
    )
    
    return { tracked: true }
  } catch (error) {
    console.error('[opportunityMatcher] Error tracking global opportunity:', error)
    return { tracked: false, error: error.message }
  }
}

/**
 * Process crawled opportunities and save appropriately
 */
export function processCrawledOpportunities(db, opportunities, profileId, profileContext) {
  const results = {
    total: opportunities.length,
    savedToPipeline: 0,
    savedGlobally: 0,
    matches: []
  }
  
  opportunities.forEach(opportunity => {
    // Calculate match percentage
    const matchPercentage = calculateMatchPercentage(opportunity, profileContext)
    
    // Save to pipeline if > 80% match
    if (matchPercentage >= 80) {
      const pipelineResult = saveToProfilePipeline(db, opportunity, profileId, profileContext, matchPercentage)
      if (pipelineResult.saved) {
        results.savedToPipeline++
        results.matches.push({
          title: opportunity.title,
          matchPercentage,
          pipelineId: pipelineResult.pipelineId
        })
      }
    }
    
    // All opportunities are saved globally by default through upsertFundingOpportunity
    results.savedGlobally++
  })
  
  console.log(`[opportunityMatcher] Processed ${results.total} opportunities:`)
  console.log(`  - ${results.savedToPipeline} saved to pipeline (>80% match)`)
  console.log(`  - ${results.savedGlobally} saved globally`)
  
  return results
}