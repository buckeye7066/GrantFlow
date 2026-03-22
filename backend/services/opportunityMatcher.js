/**
 * Opportunity Matcher and Pipeline Manager
 * Evaluates opportunity matches and saves to appropriate pipelines
 * Delegates to matchDecisionEngine for one shared decision pipeline.
 */

import crypto from 'crypto'
import { calculateMatchScore } from './matchingEngine.js'
import { applyRelevanceFilter, extractProfileData } from './relevanceFilter.js'
import { computeMatchDecision, normalizeProfile, computeProfileFingerprint, normalizeOpportunity, computeOpportunityFingerprint } from './matchDecisionEngine.js'

// Cache the result of the decision-columns PRAGMA check per DB instance to avoid
// running PRAGMA table_info(grants) on every saveToProfilePipeline call.
const _decisionColumnCache = new WeakMap()

function hasGrantsDecisionColumns(db) {
  if (_decisionColumnCache.has(db)) return _decisionColumnCache.get(db)
  let result = false
  try {
    const cols = db.prepare('PRAGMA table_info(grants)').all()
    result = cols.some((c) => c.name === 'match_decision')
  } catch { /* ignore */ }
  _decisionColumnCache.set(db, result)
  return result
}

/**
 * Calculate match percentage between opportunity and profile.
 * Uses the shared decision engine as the single source of truth.
 */
function calculateMatchPercentage(opportunity, profileContext) {
  if (!profileContext) return 0
  try {
    const profile = profileContext?.profile ?? profileContext
    const sections = profileContext?.sections ?? null
    const decision = computeMatchDecision(profile, opportunity, { profileSections: sections })
    return decision.score
  } catch {
    // Fallback to legacy scorer if decision engine fails (e.g. incomplete data)
    const { score } = calculateMatchScore(profileContext, opportunity)
    return score
  }
}

/**
 * Save opportunity to profile pipeline if match >= threshold.
 * Calls the shared decision engine and stores full match metadata.
 *
 * `minMatchThreshold` defaults to 55 to capture solid matches without being too strict.
 */
export async function saveToProfilePipeline(
  db,
  opportunity,
  profileId,
  profileContext,
  matchPercentage = null,
  minMatchThreshold = 55,
) {
  try {
    const thresholdNum = Number(minMatchThreshold)
    const threshold = Number.isFinite(thresholdNum) ? Math.max(0, Math.min(100, thresholdNum)) : 55

    // Run the full decision engine
    const rawProfile = profileContext?.profile ?? profileContext
    const profileSections = profileContext?.sections ?? null
    let decision
    try {
      decision = computeMatchDecision(rawProfile, opportunity, { profileSections })
    } catch {
      decision = null
    }

    // If decision is REJECT (hard ineligible), never save regardless of score
    if (decision?.decision === 'REJECT') {
      return {
        saved: false,
        reason: `Rejected: ${(decision.ineligibilityReasons ?? []).join('; ')}`,
        matchPercentage: decision.score ?? 0,
        threshold,
        decision: 'REJECT',
      }
    }

    // Use decision engine score when available, fall back to legacy scorer
    if (matchPercentage === null) {
      matchPercentage = decision?.score ?? calculateMatchPercentage(opportunity, profileContext)
    }

    // Only save to pipeline if match meets threshold
    if (matchPercentage < threshold) {
      return {
        saved: false,
        reason: `Match score ${matchPercentage}% below ${threshold}% threshold`,
        matchPercentage,
        threshold,
      }
    }
    
    // Resolve profile record (organization is optional; profile-scoped pipeline is canonical).
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

    // Compute fingerprints for versioning
    const profileFingerprint = computeProfileFingerprint(
      normalizeProfile(rawProfile, profileSections)
    )
    const opportunityFingerprint = computeOpportunityFingerprint(
      normalizeOpportunity(opportunity)
    )
    
    // Add to pipeline — preserve application URL, contact info, amounts, and submission method
    const grantId = crypto.randomUUID()
    const contactInfo = parseContactInfo(opportunity)

    // Detect which columns exist in the grants table (handles DBs without migration applied)
    const hasDecisionColumns = hasGrantsDecisionColumns(db)

    if (hasDecisionColumns) {
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
              amount_max,
              match_decision,
              match_explanation,
              matched_needs,
              eligibility_status,
              ineligibility_reasons,
              profile_fingerprint,
              opportunity_fingerprint,
              matcher_version,
              evaluated_at,
              match_confidence
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          decision?.decision ?? null,
          decision?.explanation ?? null,
          JSON.stringify(decision?.matchedNeeds ?? []),
          decision ? String(decision.eligible) : null,
          JSON.stringify(decision?.ineligibilityReasons ?? []),
          profileFingerprint ?? null,
          opportunityFingerprint ?? null,
          decision?.matcherVersion ?? null,
          decision?.evaluatedAt ?? null,
          decision?.confidence ?? null,
        )
    } else {
      // Legacy insert without decision columns (pre-migration DBs)
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
    }
    
    console.log(`[opportunityMatcher] Added to pipeline: ${opportunity.title} (${matchPercentage}% match for profile ${profileId}, decision: ${decision?.decision ?? 'N/A'})`)
    
    return {
      saved: true,
      matchPercentage,
      threshold,
      pipelineId: grantId,
      decision: decision?.decision ?? null,
    }
  } catch (error) {
    console.error('[opportunityMatcher] Error saving to pipeline:', error)
    // If we raced another insert (unique constraint), treat as idempotent success=false.
    const msg = String(error?.message || '')
    if (msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('duplicate')) {
      const thresholdNum = Number(minMatchThreshold)
      const threshold = Number.isFinite(thresholdNum) ? Math.max(0, Math.min(100, thresholdNum)) : 55
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
export async function processCrawledOpportunities(db, opportunities, profileId, profileContext, minMatchThreshold = 55) {
  const results = {
    total: opportunities.length,
    savedToPipeline: 0,
    savedGlobally: 0,
    matches: []
  }
  
  const profileData = extractProfileData(profileContext)

  for (const opportunity of opportunities) {
    // Calculate match percentage
    const matchPercentage = calculateMatchPercentage(opportunity, profileContext)
    
    if (matchPercentage >= minMatchThreshold) {
      // Apply hard disqualification rules as a post-filter
      const relevance = applyRelevanceFilter(opportunity, profileData)
      if (!relevance.pass) {
        console.log(`[opportunityMatcher] Filtered out "${opportunity.title}" — ${relevance.reason}`)
        continue
      }
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
  console.log(`  - ${results.savedToPipeline} saved to pipeline (>=${minMatchThreshold}% match)`)
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