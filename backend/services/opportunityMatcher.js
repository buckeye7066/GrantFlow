/**
 * Opportunity Matcher and Pipeline Manager
 * Evaluates opportunity matches and saves to appropriate pipelines
 * Delegates to matchDecisionEngine for one shared decision pipeline.
 *
 * MATCHER_VERSION 2.0.0: Legacy calculateMatchScore fallback removed.
 * computeMatchDecision() is the sole authority for all pipeline decisions.
 */

import crypto from 'crypto'
import { applyRelevanceFilter, extractProfileData } from './relevanceFilter.js'
import { computeMatchDecision, normalizeProfile, computeProfileFingerprint, normalizeOpportunity, computeOpportunityFingerprint } from './matchDecisionEngine.js'
import { isPipelineSourceAllowed } from '../config/pipelineAllowedSources.js'

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

    // ── Source allowlist enforcement ──────────────────────────────────────
    // Block pipeline inserts from non-approved sources regardless of score.
    // This is the hard gate that prevents synthetic/template/spam sources
    // from entering any profile's pipeline via any code path.
    const oppSource = opportunity?.source ? String(opportunity.source).trim() : null
    if (oppSource && !isPipelineSourceAllowed(oppSource)) {
      return {
        saved: false,
        reason: `Source "${oppSource}" is not in the pipeline allowed sources list`,
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

    // Apply hard disqualification rules — always enforced regardless of caller.
    // This ensures paths that call saveToProfilePipeline directly (localCrawler,
    // anyaAutonomousFunctionRunner, backfill scripts) cannot bypass the filter.
    if (profileContext) {
      const profileData = extractProfileData(profileContext)
      const relevance = applyRelevanceFilter(opportunity, profileData)
      if (!relevance.pass) {
        console.log(`[opportunityMatcher] saveToProfilePipeline filtered out "${opportunity.title}" — ${relevance.reason}`)
        return { saved: false, reason: relevance.reason, matchPercentage, threshold }
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
    // Skip non-allowed sources entirely (avoid computing match score)
    if (!isPipelineSourceAllowed(opportunity.source)) {
      continue
    }

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

// ---------------------------------------------------------------------------
// Opportunity freshness decoration (display layer only)
// ---------------------------------------------------------------------------

/**
 * Derive a freshness tier from an opportunity's updated_at timestamp.
 *
 * Returns:
 *   'fresh'       — verified/crawled within last 30 days
 *   'recent'      — 30-90 days old
 *   'stale'       — 90-180 days old
 *   'unverified'  — no updated_at, or older than 180 days
 */
export function computeFreshness(updatedAt) {
  if (!updatedAt) return 'unverified'
  const updated = new Date(updatedAt)
  if (Number.isNaN(updated.getTime())) return 'unverified'
  const now = Date.now()
  const ageMs = now - updated.getTime()
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24))
  if (ageDays <= 30) return 'fresh'
  if (ageDays <= 90) return 'recent'
  if (ageDays <= 180) return 'stale'
  return 'unverified'
}

/**
 * Decorate an opportunity object with freshness fields for API responses.
 * Adds:
 *   freshness           — 'fresh' | 'recent' | 'stale' | 'unverified'
 *   days_since_verified — number (null if unknown)
 *   freshness_warning   — boolean (true when stale or unverified)
 *
 * Non-destructive: returns a shallow-merged new object.
 */
export function decorateOpportunityFreshness(opp) {
  const updatedAt = opp?.updated_at ?? null
  const freshness = computeFreshness(updatedAt)

  let days_since_verified = null
  if (updatedAt) {
    const updated = new Date(updatedAt)
    if (!Number.isNaN(updated.getTime())) {
      days_since_verified = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24))
    }
  }

  return {
    ...opp,
    freshness,
    days_since_verified,
    freshness_warning: freshness === 'stale' || freshness === 'unverified',
  }
}

// ---------------------------------------------------------------------------
// Opportunity deduplication (display layer only — never deletes DB records)
// ---------------------------------------------------------------------------

const DEDUPE_STRIP_WORDS = /\b(program|grant|grants|assistance|for|the|a|an|of|in|and|or|fund|funding)\b/g
const DEDUPE_PUNCT = /[^a-z0-9 ]/g

/**
 * Normalize a title for deduplication comparison.
 * Lowercases, strips punctuation, and removes common filler words.
 */
function normalizeTitleForDedupe(title) {
  if (!title || typeof title !== 'string') return ''
  return title
    .toLowerCase()
    .replace(DEDUPE_PUNCT, ' ')
    .replace(DEDUPE_STRIP_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Calculate simple character-level Jaccard similarity between two normalized strings.
 * Returns 0..1.
 */
function titleSimilarity(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const setA = new Set(a.split(' ').filter(Boolean))
  const setB = new Set(b.split(' ').filter(Boolean))
  if (setA.size === 0 && setB.size === 0) return 1
  let intersection = 0
  for (const w of setA) {
    if (setB.has(w)) intersection++
  }
  const union = setA.size + setB.size - intersection
  return union > 0 ? intersection / union : 0
}

/**
 * Source trust rank for deduplication — higher = more preferred.
 * Mirrors the logic in matchDecisionEngine.calculateSourceTrust() at a coarser level.
 */
function getSourceRank(opp) {
  const url = String(
    opp?.application_url || opp?.apply_url || opp?.source_url || opp?.url || ''
  ).toLowerCase()
  if (url.includes('.gov')) return 4
  if (url.includes('.edu')) return 3
  if (url.includes('.org')) return 2
  const origin = opp?.record_origin ?? ''
  if (origin === 'grants_gov' || origin === 'verified_real') return 4
  if (origin === 'curated_verified') return 3
  if (origin === 'curated_benefits' || origin === 'curated_program') return 2
  return 1
}

/**
 * Build a dedupe key for exact-match elimination.
 * Combines source_id+source (same crawl record re-inserted) and
 * normalized title + scope (state or 'national').
 */
function buildDedupeKey(opp) {
  // Exact same record from a re-crawl
  if (opp?.source_id && opp?.source) {
    return `srcid:${String(opp.source_id).toLowerCase()}|${String(opp.source).toLowerCase()}`
  }
  const scope = opp?.state ? String(opp.state).toLowerCase() : 'national'
  const normTitle = normalizeTitleForDedupe(opp?.title ?? opp?.program_name ?? '')
  return `title:${normTitle}|scope:${scope}`
}

/**
 * Deduplicate a list of opportunity objects for display purposes.
 * Does NOT mutate the DB. Keeps the highest-source-trust record when duplicates collide.
 *
 * Strategy:
 * 1. Exact source_id+source match → same physical record
 * 2. Same normalized title + scope (state/national) → semantic duplicate
 * 3. Near-duplicate title (>85% word Jaccard) + same scope → fuzzy duplicate
 *
 * @param {Object[]} opportunities
 * @returns {Object[]} Deduplicated list preserving insertion order for first-seen entries.
 */
export function deduplicateOpportunities(opportunities) {
  if (!Array.isArray(opportunities) || opportunities.length === 0) return opportunities

  // Phase 1: exact key deduplication
  const seen = new Map() // key → best opportunity
  for (const opp of opportunities) {
    const key = buildDedupeKey(opp)
    if (!seen.has(key)) {
      seen.set(key, opp)
    } else {
      const existing = seen.get(key)
      if (getSourceRank(opp) > getSourceRank(existing)) {
        seen.set(key, opp)
      }
    }
  }

  // Phase 2: fuzzy title deduplication within same scope
  const candidates = Array.from(seen.values())
  const kept = []
  const dropped = new Set()

  for (let i = 0; i < candidates.length; i++) {
    if (dropped.has(i)) continue
    const oppI = candidates[i]
    const normI = normalizeTitleForDedupe(oppI?.title ?? oppI?.program_name ?? '')
    const scopeI = oppI?.state ? String(oppI.state).toLowerCase() : 'national'

    for (let j = i + 1; j < candidates.length; j++) {
      if (dropped.has(j)) continue
      const oppJ = candidates[j]
      const scopeJ = oppJ?.state ? String(oppJ.state).toLowerCase() : 'national'
      if (scopeI !== scopeJ) continue

      const normJ = normalizeTitleForDedupe(oppJ?.title ?? oppJ?.program_name ?? '')
      const sim = titleSimilarity(normI, normJ)
      if (sim >= 0.85) {
        // Keep the higher-trust one; drop the other
        if (getSourceRank(oppJ) > getSourceRank(oppI)) {
          dropped.add(i)
          break // i is already dropped; no need to compare it further
        } else {
          dropped.add(j)
        }
      }
    }

    if (!dropped.has(i)) kept.push(oppI)
  }

  return kept
}