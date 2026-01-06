/**
 * Opportunity Matcher and Pipeline Manager
 * Evaluates opportunity matches and saves to appropriate pipelines
 */

/**
 * Calculate match percentage between opportunity and profile
 */
function calculateMatchPercentage(opportunity, profileContext) {
  if (!profileContext) return 0
  
  const { profile, sections } = profileContext
  if (!profile || !sections) return 0
  
  // Build matching criteria
  let matchPoints = 0
  let totalPoints = 0
  
  // Location matching (20 points)
  totalPoints += 20
  if (opportunity.state && profile.state) {
    if (opportunity.state === profile.state) {
      matchPoints += 20
    } else if (opportunity.is_national) {
      matchPoints += 15
    }
  } else if (opportunity.is_national) {
    matchPoints += 20
  }
  
  // Category/Interest matching (30 points)
  totalPoints += 30
  const profileInterests = new Set()
  sections.forEach(section => {
    if (section.tags) {
      section.tags.split(',').forEach(tag => profileInterests.add(tag.trim().toLowerCase()))
    }
  })
  
  if (opportunity.categories && opportunity.categories.length > 0) {
    const oppCategories = new Set(opportunity.categories.map(c => c.toLowerCase()))
    const categoryMatches = [...profileInterests].filter(i => oppCategories.has(i))
    if (categoryMatches.length > 0) {
      matchPoints += Math.min(30, categoryMatches.length * 10)
    }
  }
  
  // Profile type matching (20 points)
  totalPoints += 20
  if (profile.profile_type && opportunity.eligibility_bullets) {
    const profileType = profile.profile_type.toLowerCase()
    const eligibilityText = opportunity.eligibility_bullets.join(' ').toLowerCase()
    
    if (eligibilityText.includes(profileType) || 
        (profileType === 'nonprofit' && eligibilityText.includes('501c3')) ||
        (profileType === 'individual' && eligibilityText.includes('individual'))) {
      matchPoints += 20
    }
  }
  
  // Keyword matching (30 points)
  totalPoints += 30
  if (opportunity.keywords && opportunity.keywords.length > 0) {
    const oppKeywords = new Set(opportunity.keywords.map(k => k.toLowerCase()))
    const profileKeywords = new Set()
    
    // Extract keywords from profile sections
    sections.forEach(section => {
      if (section.content) {
        // Simple keyword extraction from content
        const words = section.content.toLowerCase().split(/\s+/)
        words.forEach(word => {
          if (word.length > 4) profileKeywords.add(word)
        })
      }
    })
    
    const keywordMatches = [...profileKeywords].filter(k => oppKeywords.has(k))
    if (keywordMatches.length > 0) {
      matchPoints += Math.min(30, keywordMatches.length * 5)
    }
  }
  
  return Math.round((matchPoints / totalPoints) * 100)
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