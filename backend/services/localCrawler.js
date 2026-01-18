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
 * Calculate match score between local opportunity and profile
 */
function calculateLocalMatch(opp, profileState, signals) {
  let score = 40
  const matchReasons = []
  
  // State match is critical for local opportunities
  if (opp.state === profileState) {
    score += 30
    matchReasons.push(`State match: ${profileState}`)
  } else if (opp.state && opp.state !== profileState) {
    // Different state - not a good match for local funding
    return { score: 0, matchReasons: [] }
  }
  
  const oppText = `${opp.title || ''} ${opp.description || ''}`.toLowerCase()
  const oppKeywords = new Set([
    ...(Array.isArray(opp.keywords) ? opp.keywords : []).map((k) => String(k || '').toLowerCase()).filter(Boolean),
    ...(Array.isArray(opp.categories) ? opp.categories : []).map((c) => String(c || '').toLowerCase()).filter(Boolean),
  ])
  
  // Keyword matching
  let keywordMatches = 0
  if (signals.keywords) {
    for (const keyword of signals.keywords) {
      if (oppKeywords.has(keyword) || oppText.includes(keyword)) {
        keywordMatches++
        if (keywordMatches <= 3) {
          matchReasons.push(`Keyword: ${keyword}`)
        }
      }
    }
  }
  score += Math.min(20, keywordMatches * 5)
  
  // 501c3 check
  if (opp.requires_501c3 && !signals.is_nonprofit) {
    score -= 20
    matchReasons.push('Note: Requires 501(c)(3) status')
  }
  
  score = Math.max(0, Math.min(100, score))
  
  return { score, matchReasons }
}

/**
 * Process local crawler job - matches local community grants to profile
 */
export async function processLocalCrawlerJob({ db, job, dataDir, profileContext }) {
  console.log('[localCrawler] Starting local opportunity search...')

  if (!profileContext?.profile) {
    throw new Error('Local crawler requires a profile context')
  }
  
  const parameters = job.parameters ?? {}
  const matchThreshold = parameters.match_threshold || 60
  const maxResults = parameters.max_results || 30
  
  // Build profile signals
  const signals = buildProfileSignals(profileContext)
  const profileState =
    profileContext?.profile?.state ||
    signals?.location?.state ||
    profileContext?.sections?.location_focus?.state ||
    parameters.state
  
  if (!profileState) {
    console.warn('[localCrawler] No state specified - cannot find local opportunities')
    return { evaluated: 0, inserted: 0, opportunityLogs: [] }
  }
  
  console.log('[localCrawler] Profile state:', profileState)
  console.log('[localCrawler] Profile signals:', summarizeProfileSignals(signals))
  
  // Load local opportunities from data file
  const localOpps = loadJSON(join(dataDir, 'local_opportunities.json'))
  console.log(`[localCrawler] Loaded ${localOpps.length} local opportunities`)
  
  // Also check database for local opportunities
  const activePredicate = db?.dialect === 'postgres' ? 'is_active = TRUE' : 'is_active = 1'
  const noMatchPredicate =
    db?.dialect === 'postgres'
      ? '(requires_match IS NULL OR requires_match = FALSE)'
      : '(requires_match = 0 OR requires_match IS NULL)'

  const dbOpps = await db
    .prepare(
      `
        SELECT * FROM funding_opportunities 
        WHERE ${activePredicate}
        AND state = ?
        AND ${noMatchPredicate}
        AND source NOT IN ('comprehensive_crawler', 'synthetic', 'template')
        LIMIT 100
      `,
    )
    .all(profileState)
  
  console.log(`[localCrawler] Found ${dbOpps.length} local opportunities in database`)
  
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
    
    const { score, matchReasons } = calculateLocalMatch(opp, profileState, signals)
    
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
      
      // Save to profile pipeline if match >= 80%
      if (profileId && opp.match_score >= 80) {
        const oppWithId = { ...opp, id: result.id }
        const pipelineResult = await saveToProfilePipeline(db, oppWithId, profileId, profileContext, opp.match_score)
        if (pipelineResult.saved) {
          savedToPipeline++
        }
      }
    } catch (err) {
      console.error(`[localCrawler] Error inserting ${opp.title}:`, err.message)
    }
  }
  
  console.log(`[localCrawler] Saved ${savedToPipeline} opportunities to profile pipeline (≥80% match)`)
  
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
