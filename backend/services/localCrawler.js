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
import {
  buildProfileSignals,
  summarizeProfileSignals,
} from './profileHelpers.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'
import { calculateMatchScore } from './matchingEngine.js'

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
  console.log('[localCrawler] Starting local opportunity search...')

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
  
  console.log('[localCrawler] Profile state:', profileState)
  console.log('[localCrawler] Profile signals:', summarizeProfileSignals(signals))
  
  // Load local opportunities from data file
  let localOpps = []
  try {
    localOpps = loadJSON(join(dataDir, 'local_opportunities.json'))
    console.log(`[localCrawler] Loaded ${localOpps.length} local opportunities`)
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
    
    console.log(`[localCrawler] Found ${dbOpps.length} local opportunities in database`)
  } catch (error) {
    console.error('[localCrawler] Error querying database for opportunities:', error.message)
    // Continue with localOpps only - don't fail if DB query fails
  }
  
  // Combine and dedupe
  const seenTitles = new Set()
  const allOpps = []
  
  for (const opp of localOpps) {
    const title = opp?.title ? String(opp.title) : ''
    if (!title) continue
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
  
  for (const opp of allOpps) {
    if (opp.requires_match) continue
    
    const { score, reasons: matchReasons } = calculateMatchScore(profileContext, opp)
    
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
  
  console.log(
    `[localCrawler] Found ${topOpps.length} matching local opportunities (requested: ${requestedThreshold}%, used: ${thresholdUsed}%)`,
  )
  
  // Insert into database
  let upsertedCount = 0
  let insertedCount = 0
  let updatedCount = 0
  let savedToPipeline = 0
  const profileId = profileContext?.profile?.id
  
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
      
      // Save to profile pipeline if match meets the effective threshold used to select topOpps
      if (profileId && opp.match_score >= thresholdUsed) {
        const oppWithId = { ...opp, id: result.id, source: 'local_foundation' }
        const pipelineResult = await saveToProfilePipeline(db, oppWithId, profileId, profileContext, opp.match_score, thresholdUsed)
        if (pipelineResult.saved) {
          savedToPipeline++
        }
      }
    } catch (err) {
      console.error(`[localCrawler] Error inserting ${opp.title}:`, err.message)
    }
  }
  
  console.log(`[localCrawler] Saved ${savedToPipeline} opportunities to profile pipeline (≥${thresholdUsed}% match)`)
  
  return {
    evaluated: allOpps.length,
    inserted: upsertedCount,
    inserted_new: insertedCount,
    updated_existing: updatedCount,
    matched: topOpps.length,
    savedToPipeline,
    result_meta: {
      total_scored: scoredOpps.length,
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
