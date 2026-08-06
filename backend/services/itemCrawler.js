/**
 * Item Crawler - Matches equipment/item funding sources to profiles
 * 
 * Finds grants for specific items like vehicles, computers, equipment, etc.
 */

import fs from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { upsertFundingOpportunity } from './opportunityInserter.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'
import {
  buildProfileSignals,
  summarizeProfileSignals,
  safeParseArrayField,
} from './profileHelpers.js'
import { scoreOpportunity, computeMatchDecision } from './matchEngine.js'
import {
  DEFAULT_MIN_SCORE,
  SCORE_SCALE_ID,
  translateLegacyMinScore,
} from '../config/matchThresholds.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('itemCrawler')

/**
 * Explicit mapper from the canonical camelCase decision object returned by
 * computeMatchDecision() to the snake_case column names persisted by
 * upsertFundingOpportunity(). Exported so tests can verify that no field is
 * silently dropped when the canonical engine changes shape.
 *
 * Accepts either the current camelCase names or (defensively) pre-mapped
 * snake_case names so future callers can hand us either.
 *
 * @param {Object} decision - output of computeMatchDecision
 * @param {Object} [opts]
 * @param {string} [opts.effectiveDecision] - final ACCEPT/REVIEW/REJECT after URL guard
 * @returns {Object} snake_case persistence fields
 */
export function mapDecisionToPersistedFields(decision, opts = {}) {
  const { effectiveDecision } = opts
  return {
    match_decision: effectiveDecision ?? decision?.decision ?? null,
    match_explanation: decision?.explanation ?? null,
    matched_needs: decision?.matchedNeeds ?? decision?.matched_needs ?? [],
    eligibility_status:
      decision?.eligible ?? decision?.eligibility_status ?? null,
    ineligibility_reasons:
      decision?.ineligibilityReasons ?? decision?.ineligibility_reasons ?? [],
    // Confidence describes source/actionability certainty; it is orthogonal to
    // the match score. Never substitute a precomputed match score when the
    // canonical decision has no confidence receipt.
    match_confidence: decision?.confidence ?? null,
    matcher_version:
      decision?.matcherVersion ?? decision?.matcher_version ?? null,
    evaluated_at:
      decision?.evaluatedAt ?? decision?.evaluated_at ?? new Date().toISOString(),
  }
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (e) {
    console.warn(`[itemCrawler] Could not load ${filePath}:`, e.message)
    return []
  }
}

/**
 * Process item crawler job - finds funding for specific items/equipment
 */
export async function processItemCrawlerJob({ db, job, dataDir, profileContext }) {
  log.info('[itemCrawler] Starting item funding search...')
  
  const parameters = job.parameters ?? {}
  const requestedThresholdValue = Number(parameters.match_threshold)
  const hasRequestedThreshold = parameters.match_threshold !== null &&
    parameters.match_threshold !== undefined &&
    parameters.match_threshold !== '' &&
    Number.isFinite(requestedThresholdValue)
  const matchThresholdRequested = hasRequestedThreshold
    ? requestedThresholdValue
    : DEFAULT_MIN_SCORE
  const requestedScaleId = parameters.score_scale_id ?? null
  const matchThreshold = requestedScaleId === SCORE_SCALE_ID
    ? Math.max(0, Math.min(100, matchThresholdRequested))
    : Math.max(0, Math.min(100, translateLegacyMinScore(matchThresholdRequested)))
  const thresholdTranslated = matchThreshold !== matchThresholdRequested
  const maxResults = parameters.max_results || 20
  
  // Get item keywords from job parameters
  // Back-compat: older callers used `item_keywords`/`keywords`, newer callers use `item`.
  let itemKeywords = parameters.item_keywords || parameters.keywords || parameters.item || parameters.search || []
  if (typeof itemKeywords === 'string') {
    const raw = itemKeywords.trim()
    // Accept both comma-delimited keyword lists and a single phrase like "wheelchair van".
    itemKeywords = raw.includes(',')
      ? raw.split(',').map((k) => k.trim()).filter(Boolean)
      : raw
        ? [raw]
        : []
  }

  // Expand phrases into tokens too (score-based matching; no hard exclusion).
  if (Array.isArray(itemKeywords) && itemKeywords.length > 0) {
    const expanded = new Set()
    for (const entry of itemKeywords) {
      const phrase = String(entry || '').trim()
      if (!phrase) continue
      expanded.add(phrase)
      phrase
        .split(/\s+/g)
        .map((t) => t.trim())
        .filter(Boolean)
        .forEach((t) => expanded.add(t))
    }
    itemKeywords = Array.from(expanded)
  }
  
  if (itemKeywords.length === 0) {
    console.warn('[itemCrawler] No item keywords specified')
    return { evaluated: 0, inserted: 0, opportunityLogs: [] }
  }
  
  log.info('[itemCrawler] Searching for:', itemKeywords.join(', '))
  
  // Build profile signals
  const signals = buildProfileSignals(profileContext)
  const profileState = profileContext?.profile?.state || 
                       profileContext?.sections?.location_focus?.state ||
                       parameters.state
  
  log.info('[itemCrawler] Profile state:', profileState)
  
  // Load item funding sources
  const itemSources = loadJSON(join(dataDir, 'item_funding_sources.json'))
  log.info(`[itemCrawler] Loaded ${itemSources.length} item funding sources`)
  
  // Also check database for equipment grants
  const keywordConditions = itemKeywords.map(() => 
    '(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(keywords) LIKE ?)'
  ).join(' OR ')
  
  const keywordParams = itemKeywords.flatMap(k => {
    const sanitized = String(k || '').replace(/[%_\\]/g, '\\$&').toLowerCase()
    const pattern = `%${sanitized}%`
    return [pattern, pattern, pattern]
  })
  
  const isPostgres = db?.dialect === 'postgres'
  const activePredicate = isPostgres ? 'is_active = TRUE' : 'is_active = 1'
  const noMatchPredicate = isPostgres
    ? '(requires_match IS NULL OR requires_match = FALSE)'
    : '(requires_match = 0 OR requires_match IS NULL)'

  let dbOpps = []
  try {
    dbOpps = await db.prepare(`
      SELECT * FROM funding_opportunities 
      WHERE ${activePredicate}
      AND ${noMatchPredicate}
      AND (record_origin IN ('curated_verified', 'official_api', 'verified_scrape', 'item_funding', 'foundation_portal'))
      AND (${keywordConditions})
      LIMIT 50
    `).all(...keywordParams) || []
  } catch (err) {
    console.error('[itemCrawler] Error querying database for opportunities:', err.message)
    // Continue with empty dbOpps array but track the error
    dbOpps = []
  }
  
  log.info(`[itemCrawler] Found ${dbOpps.length} matching opportunities in database`)
  
  // Combine and dedupe
  const seenTitles = new Set()
  const allOpps = []
  
  for (const opp of itemSources) {
    if (!seenTitles.has(opp.title)) {
      seenTitles.add(opp.title)
      allOpps.push(opp)
    }
  }
  
  for (const opp of dbOpps) {
    if (!seenTitles.has(opp.title)) {
      seenTitles.add(opp.title)
      allOpps.push({
        ...opp,
        keywords: safeParseArrayField(opp.keywords, []),
        categories: safeParseArrayField(opp.categories, []),
        eligibility_bullets: safeParseArrayField(opp.eligibility_bullets, [])
      })
    }
  }
  
  // Score opportunities
  const scoredOpps = []
  
  let requiresMatchSkipped = 0
  for (const opp of allOpps) {
    if (opp.requires_match) {
      requiresMatchSkipped++
      continue
    }
    
    const { score, reasons: matchReasons } = scoreOpportunity(profileContext, opp)
    
    scoredOpps.push({
      ...opp,
      match_score: score,
      match_reasons: matchReasons
    })
  }
  if (requiresMatchSkipped > 0) {
    log.info(
      `[itemCrawler] Pre-score skip: ${requiresMatchSkipped} opportunities omitted because requires_match=true (needs separate match flow).`,
    )
  }
  
  // Sort for bounded processing volume. The legacy match_threshold parameter
  // is advisory metadata only; computeMatchDecision remains the sole authority
  // and no canonical ACCEPT/REVIEW is suppressed by a numeric second trial.
  scoredOpps.sort((a, b) => b.match_score - a.match_score)
  // Do not pre-filter by raw score; computeMatchDecision is the sole authority.
  // maxResults caps volume only; canonical ACCEPT/REVIEW decisions are never suppressed by threshold.
  const topOpps = scoredOpps.slice(0, maxResults)
  
  log.info(
    `[itemCrawler] Evaluating ${topOpps.length} item funding sources ` +
      `(advisory score setting: ${matchThreshold}, scale: ${SCORE_SCALE_ID})`,
  )

  // Insert into database
  let upsertedCount = 0
  let insertedCount = 0
  let updatedCount = 0
  for (const opp of topOpps) {
    try {
      // Goal 4: computeMatchDecision is the sole acceptance authority
      // before any insertion. Canonical signature is (rawProfile, rawOpportunity, opts),
      // NOT (profile, opp, score, reasons) -- the old extra args were silently
      // ignored, and that shape wrongly suggested the caller's score/reasons
      // were authoritative inputs. scoreOpportunity is invoked inside
      // computeMatchDecision, so passing pre-computed score/reasons has no effect.
      const decision = computeMatchDecision(profileContext, opp)

      // Goal 3: hard-reject anything the decision engine rejects
      if (decision.decision === 'REJECT') {
        log.info(
          `[itemCrawler] REJECTED "${opp.title}" - ${decision.explanation ?? 'decision engine reject'}`,
        )
        continue
      }

      // Goal 1: require a real application URL for ACCEPT; downgrade to REVIEW otherwise
      const validUrl =
        typeof opp.application_url === 'string' && opp.application_url.startsWith('http')
          ? opp.application_url
          : null
      const effectiveDecision =
        decision.decision === 'ACCEPT' && !validUrl ? 'REVIEW' : decision.decision

      // computeMatchDecision returns camelCase fields (matchedNeeds,
      // ineligibilityReasons, matcherVersion, eligible). upsertFundingOpportunity
      // persists snake_case columns, so without an explicit mapping layer every
      // row was being written with matched_needs=[], ineligibility_reasons=[],
      // eligibility_status=null, and matcher_version=null regardless of what
      // the decision engine actually returned. mapDecisionToPersistedFields
      // does the explicit camelCase->snake_case mapping and is unit-tested.
      const decisionMeta = mapDecisionToPersistedFields(decision, {
        effectiveDecision,
      })

      const result = await upsertFundingOpportunity(db, {
        title: opp.title,
        sponsor: opp.sponsor,
        description: opp.description,
        amount_min: opp.amount_min,
        amount_max: opp.amount_max,
        deadline: opp.deadline,
        application_url: validUrl,
        source_url: opp.source_url ?? opp.application_url ?? null,
        categories: opp.categories,
        keywords: [...(opp.keywords || []), ...(opp.keywords_extra || [])],
        eligibility_bullets: opp.eligibility_bullets,
        requires_match: false,
        requires_501c3: opp.requires_501c3,
        state: opp.states?.includes('ALL') ? 'nationwide' : (opp.states?.[0] || 'nationwide'),
        source: 'item_funding',
        source_id: opp.id,
        record_origin: 'curated_verified',
        // Goal 8: persist all canonical decision metadata (mapped above so
        // camelCase -> snake_case never silently drops fields).
        ...decisionMeta,
        match_reasons: opp.match_reasons,
      })

      if (result.id) {
        upsertedCount++
      }
      if (result.inserted) {
        insertedCount++
      }
      if (result.updated) {
        updatedCount++
      }
    } catch (err) {
      console.error(`[itemCrawler] Error inserting ${opp.title}:`, err.message)
      continue
    }
  }
  
  return {
    evaluated: allOpps.length,
    inserted: upsertedCount,
    inserted_new: insertedCount,
    updated_existing: updatedCount,
    matched: topOpps.length,
    result_meta: {
      total_scored: scoredOpps.length,
      match_threshold: matchThreshold,
      match_threshold_requested: matchThresholdRequested,
      match_threshold_used: matchThreshold,
      match_threshold_fallback_applied: false,
      match_threshold_applied: false,
      match_threshold_translated: thresholdTranslated,
      requested_score_scale_id: requestedScaleId,
      score_scale_id: SCORE_SCALE_ID,
    },
    opportunityLogs: topOpps.map(o => ({
      title: o.title,
      sponsor: o.sponsor,
      score: o.match_score,
      score_scale_id: SCORE_SCALE_ID,
      reasons: o.match_reasons
    }))
  }
}

export default processItemCrawlerJob
