/**
 * Opportunity Matcher and Pipeline Manager
 * Evaluates opportunity matches and saves to appropriate pipelines
 * Delegates scoring to matchingEngine for single source of truth
 */

import crypto from 'crypto'
import { calculateMatchScore } from './matchingEngine.js'

/**
 * Calculate match percentage between opportunity and profile.
 * Delegates to matchingEngine.calculateMatchScore for one engine, one set of weights.
 */
function calculateMatchPercentage(opportunity, profileContext) {
  if (!profileContext) return 0
  const { score } = calculateMatchScore(profileContext, opportunity)
  return score
}

/**
 * Save opportunity to profile pipeline if match >= threshold.
 *
 * Back-compat: `minMatchThreshold` defaults to 80 to preserve prior behavior.
 */
export async function saveToProfilePipeline(
  db,
  opportunity,
  profileId,
  profileContext,
  matchPercentage = null,
  minMatchThreshold = 80,
) {
  try {
    // Calculate match if not provided
    if (matchPercentage === null) {
      matchPercentage = calculateMatchPercentage(opportunity, profileContext)
    }
    
    const thresholdNum = Number(minMatchThreshold)
    const threshold = Number.isFinite(thresholdNum) ? Math.max(0, Math.min(100, thresholdNum)) : 80

    // Only save to pipeline if match meets threshold
    if (matchPercentage < threshold) {
      return {
        saved: false,
        reason: `Match score ${matchPercentage}% below ${threshold}% threshold`,
        matchPercentage,
        threshold,
      }
    }
    
    // Resolve profile context (organization is optional; profile-scoped pipeline is canonical).
    const profile = await db
      .prepare(
        `
          SELECT id, organization_id
          FROM profiles
          WHERE id = ?
          LIMIT 1
        `,
      )
      .get(profileId)

    if (!profile?.id) {
      return { saved: false, reason: 'Profile not found' }
    }

    // Check if already in pipeline (profile-scoped idempotency).
    const existing = await db
      .prepare(
        `
          SELECT id
          FROM grants
          WHERE profile_id = ?
            AND (funding_opportunity_id = ? OR title = ?)
          LIMIT 1
        `,
      )
      .get(profileId, opportunity.id, opportunity.title)

    if (existing) {
      return {
        saved: false,
        reason: 'Already in pipeline',
        matchPercentage,
        threshold,
      }
    }
    
    // Add to pipeline — preserve application URL, contact info, amounts, and submission method
    const grantId = crypto.randomUUID()
    const contactInfo = parseContactInfo(opportunity)
    await db
      .prepare(
        `
          INSERT INTO grants (
            id,
            organization_id,
            profile_id,
            funding_opportunity_id,
            title,
            funder,
            status,
            deadline,
            match_score,
            match_reasons,
            notes,
            application_url,
            application_method,
            contact_name,
            contact_email,
            contact_phone,
            amount_requested,
            amount_min,
            amount_max
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        grantId,
        profile.organization_id ?? null,
        profileId,
        opportunity.id,
        opportunity.title,
        opportunity.sponsor,
        'discovered',
        opportunity.deadline ?? null,
        matchPercentage,
        JSON.stringify(profileContext?.match_reasons ?? opportunity.match_reasons ?? []),
        `Auto-added: ${matchPercentage}% match for profile ${profileId} (threshold ${threshold}%)`,
        opportunity.application_url || opportunity.applicationUrl || opportunity.url || null,
        opportunity.application_method || opportunity.submission_method || guessMethodFromOpportunity(opportunity) || null,
        contactInfo.name,
        contactInfo.email,
        contactInfo.phone,
        opportunity.amount_max || opportunity.maxAmount || null,
        opportunity.amount_min || opportunity.amountMin || null,
        opportunity.amount_max || opportunity.amountMax || null,
      )
    
    console.log(`[opportunityMatcher] Added to pipeline: ${opportunity.title} (${matchPercentage}% match for profile ${profileId})`)
    
    return {
      saved: true,
      matchPercentage,
      threshold,
      pipelineId: grantId,
    }
  } catch (error) {
    console.error('[opportunityMatcher] Error saving to pipeline:', error)
    // If we raced another insert (unique constraint), treat as idempotent success=false.
    const msg = String(error?.message || '')
    if (msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('duplicate')) {
      const thresholdNum = Number(minMatchThreshold)
      const threshold = Number.isFinite(thresholdNum) ? Math.max(0, Math.min(100, thresholdNum)) : 80
      return { saved: false, reason: 'Already in pipeline', matchPercentage, threshold }
    }
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
export async function trackGlobalOpportunity(db, opportunity) {
  try {
    // Log that this opportunity was saved globally
    const trackingQuery = db.prepare(`
      INSERT INTO crawler_logs (
        crawler_type,
        profile_id,
        status,
        message,
        created_at
      ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `)
    
    await trackingQuery.run(
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
export async function processCrawledOpportunities(db, opportunities, profileId, profileContext, minMatchThreshold = 80) {
  const results = {
    total: opportunities.length,
    savedToPipeline: 0,
    savedGlobally: 0,
    matches: []
  }
  
  for (const opportunity of opportunities) {
    // Calculate match percentage
    const matchPercentage = calculateMatchPercentage(opportunity, profileContext)
    
    // Save to pipeline if match meets threshold
    if (matchPercentage >= minMatchThreshold) {
      const pipelineResult = await saveToProfilePipeline(db, opportunity, profileId, profileContext, matchPercentage, minMatchThreshold)
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
  }
  
  console.log(`[opportunityMatcher] Processed ${results.total} opportunities:`)
  console.log(`  - ${results.savedToPipeline} saved to pipeline (≥${minMatchThreshold}% match)`)
  console.log(`  - ${results.savedGlobally} saved globally`)
  
  return results
}

function parseContactInfo(opportunity) {
  let name = null, email = null, phone = null
  const ci = opportunity.contact_info || opportunity.contact || null
  if (ci) {
    if (typeof ci === 'string') {
      try { const parsed = JSON.parse(ci); name = parsed.name; email = parsed.email; phone = parsed.phone } catch { /* ignore */ }
    } else if (typeof ci === 'object') {
      name = ci.name || null; email = ci.email || null; phone = ci.phone || null
    }
  }
  return {
    name: name || opportunity.contact_name || null,
    email: email || opportunity.contact_email || null,
    phone: phone || opportunity.contact_phone || null,
  }
}

function guessMethodFromOpportunity(opportunity) {
  const text = `${opportunity.applicationNote || ''} ${opportunity.description || ''} ${opportunity.application_url || ''}`.toLowerCase()
  if (text.includes('fax')) return 'fax'
  if (text.includes('mail') && !text.includes('email')) return 'print_and_mail'
  if (text.includes('portal') || text.includes('.gov') || text.includes('apply online')) return 'portal'
  if (text.includes('call') || text.includes('phone')) return 'phone_contact'
  if (text.includes('email')) return 'email_contact'
  if (opportunity.application_url || opportunity.applicationUrl || opportunity.url) return 'portal'
  return null
}