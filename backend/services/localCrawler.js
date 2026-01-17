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
  
  const oppText = `${opp.title} ${opp.description}`.toLowerCase()
  const oppKeywords = new Set([
    ...(opp.keywords || []).map(k => k.toLowerCase()),
    ...(opp.categories || []).map(c => c.toLowerCase())
  ])
  
  // Keyword matching
  let keywordMatches = 0
  const profileKeywords = signals?.keywordSet ? Array.from(signals.keywordSet) : []
  if (profileKeywords.length > 0) {
    for (const keyword of profileKeywords) {
      const normalized = String(keyword).toLowerCase()
      if (oppKeywords.has(normalized) || oppText.includes(normalized)) {
        keywordMatches++
        if (keywordMatches <= 3) {
          matchReasons.push(`Keyword: ${normalized}`)
        }
      }
    }
  }
  score += Math.min(20, keywordMatches * 5)
  
  // 501c3 check
  const isNonprofit =
    Boolean(signals?.keywordSet?.has?.('nonprofit')) ||
    Boolean(signals?.keywordSet?.has?.('501c3')) ||
    Boolean(signals?.keywordSet?.has?.('501(c)(3)'))
  if (opp.requires_501c3 && !isNonprofit) {
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
  const profileState = profileContext?.profile?.state || 
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
  const dbOpps = await db.prepare(`
    SELECT * FROM funding_opportunities 
    WHERE is_active = 1 
    AND state = ?
    AND (requires_match = 0 OR requires_match IS NULL)
    AND source NOT IN ('comprehensive_crawler', 'synthetic', 'template')
    LIMIT 100
  `).all(profileState)
  
  console.log(`[localCrawler] Found ${dbOpps.length} local opportunities in database`)
  
  // Combine and dedupe
  const seenTitles = new Set()
  const allOpps = []
  
  for (const opp of localOpps) {
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
        keywords: JSON.parse(opp.keywords || '[]'),
        categories: JSON.parse(opp.categories || '[]'),
        eligibility_bullets: JSON.parse(opp.eligibility_bullets || '[]')
      })
    }
  }
  
  // Score opportunities
  const scoredOpps = []
  
  for (const opp of allOpps) {
    if (opp.requires_match) continue
    
    const { score, matchReasons } = calculateLocalMatch(opp, profileState, signals)
    
    if (score >= matchThreshold) {
      scoredOpps.push({
        ...opp,
        match_score: score,
        match_reasons: matchReasons
      })
    }
  }
  
  // Sort and limit
  scoredOpps.sort((a, b) => b.match_score - a.match_score)
  const topOpps = scoredOpps.slice(0, maxResults)
  
  console.log(`[localCrawler] Found ${topOpps.length} matching local opportunities`)
  
  // Insert into database
  let insertedCount = 0
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
      
      if (result.inserted) {
        insertedCount++
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
    inserted: insertedCount,
    matched: topOpps.length,
    savedToPipeline,
    opportunityLogs: topOpps.map(o => ({
      title: o.title,
      sponsor: o.sponsor,
      score: o.match_score,
      reasons: o.match_reasons
    }))
  }
}

export default processLocalCrawlerJob
