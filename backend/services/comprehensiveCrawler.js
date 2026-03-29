/**
 * Comprehensive Crawler - Uses real funding opportunities
 * 
 * This crawler matches real funding opportunities to user profiles
 * based on demographics, location, and other criteria.
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
import { applyRelevanceFilter, extractProfileData } from './relevanceFilter.js'
import { calculateMatchScore } from './matchingEngine.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (e) {
    if (e && (e.code === 'ENOENT' || /ENOENT/i.test(String(e.message || '')))) {
      console.info(
        `[comprehensiveCrawler] Curated opportunities dataset not present at ${filePath}; continuing with empty curated dataset`,
      )
      return null
    }
    console.warn(`[comprehensiveCrawler] Could not load ${filePath}:`, e.message)
    return null
  }
}

/**
 * Load real funding opportunities from verified data files
 */
function loadRealOpportunities(dataDir) {
  const dataPath = join(dataDir, 'real_funding_opportunities.json')
  const data = loadJSON(dataPath)
  
  if (!data) {
    console.warn('[comprehensiveCrawler] No real opportunities data found')
    return []
  }
  
  const allOpps = []
  const categories = [
    'federal_grants',
    'foundation_grants',
    'state_programs',
    'disability_assistance',
    'veteran_assistance',
    'nonprofit_grants'
  ]
  
  for (const cat of categories) {
    if (data[cat]) {
      allOpps.push(...data[cat])
    }
  }
  
  return allOpps
}

/**
 * Process comprehensive crawler job using real opportunities
 */
export async function processComprehensiveCrawlerJob({ db, job, dataDir, profileContext }) {
  console.log('[comprehensiveCrawler] Starting with real opportunities...')
  
  const parameters = job.parameters ?? {}
  const matchThreshold = parameters.match_threshold || 50
  const maxResults = parameters.max_results || 50
  
  // Build profile signals
  const signals = buildProfileSignals(profileContext)
  const profileState = profileContext?.profile?.state || 
                       profileContext?.sections?.location_focus?.state ||
                       parameters.state
  
  console.log('[comprehensiveCrawler] Profile signals:', summarizeProfileSignals(signals))
  console.log('[comprehensiveCrawler] Profile state:', profileState)
  
  // Load real opportunities
  const realOpps = loadRealOpportunities(dataDir)
  console.log(`[comprehensiveCrawler] Loaded ${realOpps.length} real opportunities from data files`)
  
  // Also load from database
  const dbOppsQuery =
    db?.dialect === 'postgres'
      ? `
          SELECT *
          FROM funding_opportunities
          WHERE is_active IS TRUE
            AND (requires_match IS FALSE OR requires_match IS NULL)
            AND ${trustedOriginClause()}
            AND ${trustedSourceClause()}
          ORDER BY created_at DESC
          LIMIT 200
        `
      : `
          SELECT *
          FROM funding_opportunities
          WHERE is_active = 1
            AND (requires_match = 0 OR requires_match IS NULL)
            AND ${trustedOriginClause()}
            AND ${trustedSourceClause()}
          ORDER BY created_at DESC
          LIMIT 200
        `

  let dbOpps = []
  try {
    dbOpps = await db.prepare(dbOppsQuery).all() || []
  } catch (err) {
    console.error('[comprehensiveCrawler] Error querying database for opportunities:', err.message)
  }
  
  console.log(`[comprehensiveCrawler] Found ${dbOpps.length} real opportunities in database`)
  
  // Combine and dedupe
  const seenTitles = new Set()
  const allOpps = []
  
  for (const opp of realOpps) {
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
  
  // Score and filter opportunities
  const scoredOpps = []
  const profileData = extractProfileData(profileContext)
  
  for (const opp of allOpps) {
    // Skip if requires matching funds
    if (opp.requires_match) continue
    
    const { score, reasons: matchReasons } = calculateMatchScore(profileContext, opp)
    
    if (score >= matchThreshold) {
      // Apply hard disqualification rules as a post-filter
      const relevance = applyRelevanceFilter(opp, profileData)
      if (!relevance.pass) {
        console.log(`[comprehensiveCrawler] Filtered out "${opp.title}" — ${relevance.reason}`)
        continue
      }
      scoredOpps.push({
        ...opp,
        match_score: score,
        match_reasons: matchReasons
      })
    }
  }
  
  // Sort by score and limit
  scoredOpps.sort((a, b) => b.match_score - a.match_score)
  const topOpps = scoredOpps.slice(0, maxResults)
  
  console.log(`[comprehensiveCrawler] Found ${topOpps.length} matching opportunities (threshold: ${matchThreshold}%)`)
  
  // Insert into database
  let insertedCount = 0
  for (const opp of topOpps) {
    try {
      const result = await upsertFundingOpportunity(db, {
        title: opp.title,
        sponsor: opp.sponsor,
        description: opp.description,
        amount_min: opp.amount_min,
        amount_max: opp.amount_max,
        amount_description: opp.amount_description,
        deadline: opp.deadline,
        application_url: opp.application_url,
        categories: opp.categories,
        keywords: opp.keywords,
        eligibility_bullets: opp.eligibility_bullets,
        requires_match: false,
        requires_501c3: opp.requires_501c3,
        state: opp.state,
        source: 'verified_real',
        source_id: opp.id || opp.source_id,
        match_reasons: opp.match_reasons
      })
      
      if (result.inserted) {
        insertedCount++
      }
    } catch (err) {
      console.error(`[comprehensiveCrawler] Error inserting ${opp.title}:`, err.message)
    }
  }
  
  return {
    evaluated: allOpps.length,
    inserted: insertedCount,
    matched: topOpps.length,
    opportunityLogs: topOpps.map(o => ({
      title: o.title,
      sponsor: o.sponsor,
      score: o.match_score,
      reasons: o.match_reasons
    }))
  }
}

export default processComprehensiveCrawlerJob
