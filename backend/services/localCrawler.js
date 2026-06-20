/**
 * Local Crawler - Matches local community foundation grants to profiles
 * 
 * Uses real local opportunities data from verified sources.
 */

import fs from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { upsertFundingOpportunity } from './opportunityInserter.js'
import { saveToProfilePipeline } from './opportunityMatcher.js'
import { discoveryAutoAddAllowedForProfile } from './discoveryAutoAddGate.js'
import {
  buildProfileSignals,
  summarizeProfileSignals,
} from './profileHelpers.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'
import { scoreOpportunity } from './matchEngine.js'
import { RELEVANCE_FLOOR } from '../startup/enforceInvariants.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('localCrawler')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (e) {
    console.warn(`[localCrawler] Could not load ${filePath}:`, e.message)
    return []
  }
}

function safeJsonArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  const trimmed = value.trim()
  if (!trimmed) return []

  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed
    if (typeof parsed === 'string' && parsed.trim()) return [parsed.trim()]
  } catch {
    // fall through to delimited parsing
  }

  // Common legacy formats: "a,b,c" or "a; b; c"
  return trimmed
    .split(/[,;\n]+/)
    .map((v) => v.trim())
    .filter(Boolean)
}

/**
 * Process local crawler job - matches local community grants to profile
 */
export async function processLocalCrawlerJob({ db, job, dataDir, profileContext }) {
  log.info('[localCrawler] Starting local opportunity search...')

  // Validate required inputs
  if (!db) {
    throw new Error('Database connection is required for local crawler')
  }
  
  if (!profileContext?.profile) {
    throw new Error('Local crawler requires a profile context with profile data')
  }
  
  if (!dataDir || typeof dataDir !== 'string') {
    throw new Error('Data directory path is required for local crawler')
  }
  
  const parameters = job.parameters ?? {}
  const matchThreshold = parameters.match_threshold || 60
  const maxResults = parameters.max_results || 30
  
  // Build profile signals with error handling
  let signals
  try {
    signals = buildProfileSignals(profileContext)
  } catch (error) {
    console.error('[localCrawler] Error building profile signals:', error)
    throw new Error(`Failed to build profile signals: ${error.message}`)
  }
  
  // Extract state with multiple fallback options
  const profileState =
    profileContext?.profile?.state ||
    signals?.location?.state ||
    profileContext?.sections?.location_focus?.state ||
    parameters.state
  
  if (!profileState) {
    console.warn('[localCrawler] No state specified - cannot find local opportunities')
    return { 
      evaluated: 0, 
      inserted: 0, 
      opportunityLogs: [],
      error: 'No state information available in profile'
    }
  }
  
  // Validate state format
  if (typeof profileState !== 'string' || profileState.trim().length !== 2) {
    console.warn('[localCrawler] Invalid state format:', profileState)
    return { 
      evaluated: 0, 
      inserted: 0, 
      opportunityLogs: [],
      error: `Invalid state format: ${profileState} (expected 2-letter state code)`
    }
  }
  
  log.info('[localCrawler] Profile state:', profileState)
  log.info('[localCrawler] Profile signals:', summarizeProfileSignals(signals))
  
  // Load local opportunities from data file
  let localOpps = []
  try {
    localOpps = loadJSON(join(dataDir, 'local_opportunities.json'))
    log.info(`[localCrawler] Loaded ${localOpps.length} local opportunities`)
  } catch (error) {
    console.warn('[localCrawler] Could not load local opportunities file:', error.message)
    // Continue with empty array - will try database next
  }
  
  // Also check database for local opportunities
  let dbOpps = []
  try {
    const activePredicate = db?.dialect === 'postgres' ? 'is_active = TRUE' : 'is_active = 1'
    const noMatchPredicate =
      db?.dialect === 'postgres'
        ? '(requires_match IS NULL OR requires_match = FALSE)'
        : '(requires_match = 0 OR requires_match IS NULL)'

    dbOpps = await db
      .prepare(
        `
          SELECT * FROM funding_opportunities 
          WHERE ${activePredicate}
          AND state = ?
          AND ${noMatchPredicate}
          AND ${trustedOriginClause()}
          AND ${trustedSourceClause()}
          LIMIT 100
        `,
      )
      .all(profileState)
    
    log.info(`[localCrawler] Found ${dbOpps.length} local opportunities in database`)
  } catch (error) {
    console.error('[localCrawler] Error querying database for opportunities:', error.message)
    // Database failure is critical for local matching - return partial results with warning
    return {
      evaluated: localOpps.length,
      inserted: 0,
      opportunityLogs: [],
      error: `Database query failed: ${error.message}`,
      warning: 'Only file-based opportunities processed due to database error'
    }
  }
  
  // Combine and dedupe
  const seenTitles = new Set()
  const allOpps = []
  
  for (const opp of localOpps) {
    const title = opp?.title ? String(opp.title) : ''
    if (!title) continue
    if (!opp?.application_url || typeof opp.application_url !== 'string' || !opp.application_url.trim()) {
      console.warn(`[localCrawler] Skipping "${title}" â missing application_url (Goal 1)`)
      continue
    }
    if (!seenTitles.has(title)) {
      seenTitles.add(title)
      allOpps.push({
        ...opp,
        title,
        keywords: safeJsonArray(opp?.keywords),
        categories: safeJsonArray(opp?.categories),
        eligibility_bullets: safeJsonArray(opp?.eligibility_bullets),
      })
    }
  }

  for (const opp of dbOpps) {
    const title = opp?.title ? String(opp.title) : ''
    if (!title) continue
    if (!opp?.application_url || typeof opp.application_url !== 'string' || !opp.application_url.trim()) {
      console.warn(`[localCrawler] Skipping DB opp "${title}" â missing application_url (Goal 1)`)
      continue
    }
    if (!seenTitles.has(title)) {
      seenTitles.add(title)
      allOpps.push({
        ...opp,
        title,
        keywords: safeJsonArray(opp?.keywords),
        categories: safeJsonArray(opp?.categories),
        eligibility_bullets: safeJsonArray(opp?.eligibility_bullets),
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
  
  // Sort and limit
  scoredOpps.sort((a, b) => b.match_score - a.match_score)
  const targetMin = Math.min(8, maxResults)
  const requestedThreshold = Number(matchThreshold) || 0
  const thresholdCandidates = Array.from(
    new Set([requestedThreshold, 70, 60, 50, 40, 30, 0].filter((v) => Number.isFinite(v))),
  ).sort((a, b) => b - a)

  let thresholdUsed = requestedThreshold
  let filteredOpps = scoredOpps.filter((opp) => (opp.match_score ?? 0) >= thresholdUsed)
  for (const threshold of thresholdCandidates) {
    const subset = scoredOpps.filter((opp) => (opp.match_score ?? 0) >= threshold)
    if (subset.length >= targetMin || (threshold === 0 && subset.length > 0)) {
      thresholdUsed = threshold
      filteredOpps = subset
      break
    }
  }

  const topOpps = filteredOpps.slice(0, maxResults)
  const thresholdFallbackApplied = thresholdUsed !== requestedThreshold
  
  log.info(
    `[localCrawler] Found ${topOpps.length} matching local opportunities (requested: ${requestedThreshold}%, used: ${thresholdUsed}%)`,
  )
  
  // Insert into database
  let upsertedCount = 0
  let insertedCount = 0
  let updatedCount = 0
  let savedToPipeline = 0
  const profileId = profileContext?.profile?.id
  // Per-profile automation toggle: only auto-add to the pipeline when
  // discovery_auto_add is on. Off → opportunities are still cataloged and
  // surface in Discovery for manual add, but don't enter the pipeline
  // unattended. Checked once (not per-opportunity). Absent pref defaults ON.
  const autoAddOk = profileId ? await discoveryAutoAddAllowedForProfile(db, profileId) : false
  if (profileId && !autoAddOk) {
    console.info(`[localCrawler] discovery_auto_add OFF for profile ${profileId} — cataloging only, no pipeline auto-add`)
  }

  for (const opp of topOpps) {
    try {
      const result = await upsertFundingOpportunity(db, {
        title: opp.title,
        sponsor: opp.sponsor,
        description: opp.description,
        amount_min: opp.amount_min,
        amount_max: opp.amount_max,
        deadline: opp.deadline,
        application_url: opp.application_url,
        categories: opp.categories,
        keywords: opp.keywords,
        eligibility_bullets: opp.eligibility_bullets,
        requires_match: false,
        requires_501c3: opp.requires_501c3,
        state: opp.state,
        source: 'local_foundation',
        source_id: opp.id,
        record_origin: 'live_crawl',
        match_reasons: opp.match_reasons
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
      
      // Save to profile pipeline using the relaxed threshold (topOpps already passed it)
      if (profileId && autoAddOk) {
        const oppWithId = { ...opp, id: result.id, source: 'local_foundation' }
        // Do NOT pass pre-computed score â let saveToProfilePipeline run
        // computeMatchDecision() as the single canonical authority (Goal 4).
        // relevanceFilter hard-rejection, audit metadata, and ACCEPT/REVIEW
        // decisions are all produced inside that call (Goals 3, 8).
        // Pass the crawler's already-chosen threshold (thresholdUsed) so
        // saveToProfilePipeline does not silently apply its own 55% default
        // and drop everything the crawler legitimately surfaced. The saver
        // still re-runs computeMatchDecision and still treats the numeric
        // floor as authoritative (ACCEPT/REVIEW does NOT bypass it).
        //
        // BUT the relaxation loop above can drop thresholdUsed all the way to
        // 0 when results are scarce. Never ask the saver to persist below the
        // canonical pipeline relevance floor — that is the "this is junk for
        // this profile" line (docs/canonical_rules.md). Clamp here so a sparse
        // local crawl can't smuggle sub-floor rows into the pipeline; the
        // saver's own hard floor is the net behind this.
        const saveThreshold = Math.max(thresholdUsed, RELEVANCE_FLOOR)
        const pipelineResult = await saveToProfilePipeline(
          db,
          oppWithId,
          profileId,
          profileContext,
          null,
          saveThreshold,
        )
        if (pipelineResult.saved) {
          savedToPipeline++
        }
      }
    } catch (err) {
      console.error(`[localCrawler] Error inserting ${opp.title}:`, err.message)
    }
  }
  
  log.info(`[localCrawler] Saved ${savedToPipeline} opportunities to profile pipeline (≥${thresholdUsed}% match)`)
  
  return {
    evaluated: allOpps.length,
    inserted: upsertedCount,
    inserted_new: insertedCount,
    updated_existing: updatedCount,
    matched: topOpps.length,
    savedToPipeline,
    result_meta: {
      total_scored: scoredOpps.length,
      skipped_requires_match: requiresMatchSkipped,
      match_threshold_requested: requestedThreshold,
      match_threshold_used: thresholdUsed,
      match_threshold_fallback_applied: thresholdFallbackApplied,
    },
    opportunityLogs: topOpps.map(o => ({
      title: o.title,
      sponsor: o.sponsor,
      score: o.match_score,
      reasons: o.match_reasons
    }))
  }
}

export default processLocalCrawlerJob
