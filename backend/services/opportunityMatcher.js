/**
 * Opportunity Matcher and Pipeline Manager
 * Evaluates opportunity matches and saves to appropriate pipelines.
 * Delegates to matchEngine.js (v3.0.0) for all scoring and decisions.
 *
 * Pipeline gates (in order):
 *   1. SOURCE_ALLOWLIST  — blocks non-approved sources
 *   2. DECISION_ENGINE   — REJECT = hard ineligible
 *   3. EXCLUSION_ENGINE   — custom suppression rules
 *   4. THRESHOLD          — numeric floor (bypassed when engine returns ACCEPT/REVIEW)
 *   5. RELEVANCE_FILTER   — hard disqualification rules
 *   6. IDEMPOTENCY        — dedup by profile + opportunity
 *
 * computeMatchDecision() is the sole scoring/decision authority.
 */

import crypto from 'crypto'
import { applyRelevanceFilter, extractProfileData } from './relevanceFilter.js'
import { computeMatchDecision, normalizeProfile, computeProfileFingerprint, normalizeOpportunity, computeOpportunityFingerprint } from './matchEngine.js'
import { isPipelineSourceAllowed } from '../config/pipelineAllowedSources.js'
import { evaluateExclusion } from './exclusionEngine.js'

// Cache the result of the decision-columns PRAGMA check per DB instance to avoid
// running PRAGMA table_info(grants) on every saveToProfilePipeline call.
const _decisionColumnCache = new WeakMap()

async function hasGrantsDecisionColumns(db) {
  if (_decisionColumnCache.has(db)) return _decisionColumnCache.get(db)
  let result = false
  try {
    const dialect = db?.dialect || 'sqlite'
    if (dialect === 'postgres') {
      const row = await db
        .prepare(
          `SELECT 1 AS ok FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = ? AND column_name = ? LIMIT 1`,
        )
        .get('grants', 'match_decision')
      result = Boolean(row?.ok)
    } else {
      const cols = db.prepare('PRAGMA table_info(grants)').all()
      result = cols.some((c) => c.name === 'match_decision')
    }
  } catch { /* ignore */ }
  _decisionColumnCache.set(db, result)
  return result
}

/**
 * Calculate match percentage between opportunity and profile.
 * Uses the shared decision engine as the single source of truth.
 * No legacy fallback — computeMatchDecision() is the sole authority.
 */
function calculateMatchPercentage(opportunity, profileContext) {
  if (!profileContext) return 0
  try {
    const profile = profileContext?.profile ?? profileContext
    const sections = profileContext?.sections ?? null
    const decision = computeMatchDecision(profile, opportunity, { profileSections: sections })
    return decision.score
  } catch {
    // If the decision engine fails entirely (e.g. null inputs), return 0 — never save.
    return 0
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

    // Gate 1: Source allowlist — blocks non-approved sources entirely
    const oppSource = opportunity?.source ? String(opportunity.source).trim() : null
    if (oppSource && !isPipelineSourceAllowed(oppSource)) {
      console.log(`[opportunityMatcher] Gate:SOURCE_ALLOWLIST suppressed "${opportunity.title}" — source "${oppSource}" not allowed`)
      return {
        saved: false,
        reason: `Source "${oppSource}" is not in the pipeline allowed sources list`,
        gate: 'SOURCE_ALLOWLIST',
        matchPercentage: null,
        threshold,
      }
    }

    // Run the full decision engine
    const rawProfile = profileContext?.profile ?? profileContext
    const profileSections = profileContext?.sections ?? null
    let decision
    try {
      decision = computeMatchDecision(rawProfile, opportunity, { profileSections })
    } catch {
      decision = null
    }

    // Gate 2: Canonical decision engine — REJECT means hard ineligible
    if (decision?.decision === 'REJECT') {
      console.log(`[opportunityMatcher] Gate:DECISION_ENGINE rejected "${opportunity.title}" — ${(decision.ineligibilityReasons ?? []).join('; ')}`)
      return {
        saved: false,
        reason: `Rejected: ${(decision.ineligibilityReasons ?? []).join('; ')}`,
        gate: 'DECISION_ENGINE',
        matchPercentage: decision.score ?? 0,
        threshold,
        decision: 'REJECT',
      }
    }

    // Gate 3: Exclusion engine — custom suppression rules
    let exclusion = { decision: 'ALLOW' }
    try {
      const exclusionRules = await db.prepare(`SELECT * FROM exclusion_rules WHERE action IS NOT NULL`).all()
      exclusion = evaluateExclusion(opportunity, exclusionRules || [])
    } catch { /* table may not exist yet; treat as ALLOW */ }

    if (exclusion.decision === 'SUPPRESS') {
      console.log(`[opportunityMatcher] Gate:EXCLUSION_ENGINE suppressed "${opportunity.title}" — rule ${exclusion.rule_id}`)
      return {
        saved: false,
        reason: `Excluded by rule ${exclusion.rule_id}`,
        gate: 'EXCLUSION_ENGINE',
        matchPercentage,
        threshold,
      }
    }

    // Use decision engine score when available, fall back to legacy scorer
    if (matchPercentage === null) {
      matchPercentage = decision?.score ?? calculateMatchPercentage(opportunity, profileContext)
    }

    // Apply WATCH penalty before threshold comparison
    let adjustedScore = matchPercentage
    if (exclusion?.decision === 'WATCH') {
      adjustedScore = Math.max(0, matchPercentage - 15)
    }

    // Threshold gate — respects canonical decisions from the engine.
    // If the decision engine produced ACCEPT or REVIEW, its authority takes precedence
    // over the numeric threshold. The threshold only applies as a fallback when the
    // decision engine did not run (decision is null) or for edge-case WATCH penalties.
    const canonicalDecision = decision?.decision
    const bypassThreshold = canonicalDecision === 'ACCEPT' || canonicalDecision === 'REVIEW'

    // Gate 4: Score threshold — only applies when decision engine did not produce ACCEPT/REVIEW
    if (!bypassThreshold && adjustedScore < threshold) {
      console.log(`[opportunityMatcher] Gate:THRESHOLD suppressed "${opportunity.title}" — score ${adjustedScore}% < ${threshold}%, decision was ${canonicalDecision ?? 'null'}`)
      return {
        saved: false,
        reason: `Match score ${adjustedScore}% below ${threshold}% threshold`,
        gate: 'THRESHOLD',
        matchPercentage,
        threshold,
      }
    }

    // Gate 5: Relevance filter — hard disqualification rules (always enforced)
    if (profileContext) {
      const profileData = extractProfileData(profileContext)
      const relevance = applyRelevanceFilter(opportunity, profileData)
      if (!relevance.pass) {
        console.log(`[opportunityMatcher] Gate:RELEVANCE_FILTER suppressed "${opportunity.title}" — ${relevance.reason}`)
        return { saved: false, reason: relevance.reason, gate: 'RELEVANCE_FILTER', matchPercentage, threshold }
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

    // Compute fingerprints for versioning
    const profileFingerprint = computeProfileFingerprint(
      normalizeProfile(rawProfile, profileSections)
    )
    const opportunityFingerprint = computeOpportunityFingerprint(
      normalizeOpportunity(opportunity)
    )
    
    // Canonical match_reasons: prefer the decision engine's scoring reasons.
    // Falls back to caller-supplied reasons only when the engine didn't run.
    const canonicalReasons = decision?.reasons?.length
      ? decision.reasons
      : (profileContext?.match_reasons ?? opportunity.match_reasons ?? [])

    // Add to pipeline — preserve application URL, contact info, amounts, and submission method
    const grantId = crypto.randomUUID()
    const contactInfo = parseContactInfo(opportunity)

    // Detect which columns exist in the grants table (handles DBs without migration applied)
    const hasDecisionColumns = await hasGrantsDecisionColumns(db)

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
          JSON.stringify(canonicalReasons),
          `Auto-added: ${matchPercentage}% match for profile ${profileId} (decision: ${decision?.decision ?? 'N/A'})`,
          opportunity.application_url || opportunity.applicationUrl || opportunity.url || null,
          opportunity.application_method || opportunity.submission_method || guessMethodFromOpportunity(opportunity) || null,
          contactInfo.name,
          contactInfo.email,
          contactInfo.phone,
          opportunity.amount_requested || opportunity.requestedAmount || null,
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
          JSON.stringify(canonicalReasons),
          `Auto-added: ${matchPercentage}% match for profile ${profileId} (decision: ${decision?.decision ?? 'N/A'})`,
          opportunity.application_url || opportunity.applicationUrl || opportunity.url || null,
          opportunity.application_method || opportunity.submission_method || guessMethodFromOpportunity(opportunity) || null,
          contactInfo.name,
          contactInfo.email,
          contactInfo.phone,
          opportunity.amount_requested || opportunity.requestedAmount || null,
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
export async function processCrawledOpportunities(db, opportunities, profileId, profileContext, minMatchThreshold = 55) {
  const results = {
    total: opportunities.length,
    savedToPipeline: 0,
    savedGlobally: 0,
    matches: []
  }

  for (const opportunity of opportunities) {
    if (!isPipelineSourceAllowed(opportunity.source)) {
      continue
    }

    // Delegate fully to saveToProfilePipeline — it runs the canonical decision engine,
    // threshold gate, relevance filter, and idempotency check as one unified pipeline.
    // No pre-filtering here; that was duplicating logic and could diverge from the
    // canonical authority in saveToProfilePipeline.
    const pipelineResult = await saveToProfilePipeline(db, opportunity, profileId, profileContext, null, minMatchThreshold)
    if (pipelineResult.saved) {
      results.savedToPipeline++
      results.matches.push({
        title: opportunity.title,
        matchPercentage: pipelineResult.matchPercentage,
        pipelineId: pipelineResult.pipelineId
      })
    }
    
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