import fs from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { upsertFundingOpportunity } from './opportunityInserter.js'
import {
  buildProfileSignals,
  summarizeProfileSignals,
  safeParseArrayField,
} from './profileHelpers.js'
import { saveToProfilePipeline } from './opportunityMatcher.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (e) {
    console.warn(`[comprehensiveCrawler] Could not load ${filePath}:`, e.message)
    return null
  }
}

/**
 * Load real funding opportunities from verified data files
 */
function loadRealOpportunities() {
  const dataPath = join(__dirname, '../data/crawlers/real_funding_opportunities.json')
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
 * Calculate match score between opportunity and profile signals
 */
function calculateOpportunityMatch(opp, signals, profileState) {
  let score = 40 // Base score
  const matchReasons = []
  
  const oppKeywords = new Set([
    ...(opp.keywords || []).map(k => k.toLowerCase()),
    ...(opp.categories || []).map(c => c.toLowerCase())
  ])
  
  const oppText = `${opp.title} ${opp.description}`.toLowerCase()
  
  // State match (15 points)
  if (opp.state === 'nationwide' || opp.state === profileState) {
    score += 15
    if (opp.state === profileState) {
      matchReasons.push(`Location: ${profileState}`)
    }
  } else if (opp.state && opp.state !== profileState) {
    // Wrong state - significantly reduce score
    score -= 20
  }
  
  // Keyword matching (up to 25 points)
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
  score += Math.min(25, keywordMatches * 5)
  
  // Demographics matching (up to 15 points)
  if (signals.demographics) {
    let demoMatches = 0
    for (const demo of signals.demographics) {
      if (oppText.includes(demo)) {
        demoMatches++
        matchReasons.push(`Demographic: ${demo}`)
      }
    }
    score += Math.min(15, demoMatches * 5)
  }
  
  // Disability/health matching (up to 15 points)
  if (signals.health) {
    for (const health of signals.health) {
      if (oppText.includes(health) || oppKeywords.has(health)) {
        score += 5
        matchReasons.push(`Health: ${health}`)
      }
    }
  }
  
  // Veteran matching (up to 15 points)
  if (signals.military) {
    for (const mil of signals.military) {
      if (oppText.includes(mil) || oppKeywords.has('veteran')) {
        score += 10
        matchReasons.push(`Veteran status`)
        break
      }
    }
  }
  
  // Education matching
  if (signals.education && oppKeywords.has('education')) {
    score += 5
    matchReasons.push('Education focus')
  }
  
  // Ensure score is within bounds
  score = Math.max(0, Math.min(100, score))
  
  return { score, matchReasons }
}

/**
 * Run comprehensive search using real funding opportunities
 * Matches opportunities to profile based on signals
 */
export async function runComprehensiveCrawler(contextOrDb, profileContextArg = {}, options = {}) {
  // Support both dispatcher context object and direct (db, profileContext, options) calls
  let db, profileContext, matchThreshold, maxResults, saveToDatabase
  
  if (contextOrDb && typeof contextOrDb === 'object' && contextOrDb.db) {
    // Called from dispatcher with context object
    db = contextOrDb.db
    profileContext = contextOrDb.profileContext || {}
    const params = contextOrDb.job?.parameters || {}
    matchThreshold = params.match_threshold || 70
    maxResults = params.max_results || 50
    saveToDatabase = params.save_to_database !== false
  } else {
    // Called directly with (db, profileContext, options)
    db = contextOrDb
    profileContext = profileContextArg
    matchThreshold = options.matchThreshold || 70
    maxResults = options.maxResults || 50
    saveToDatabase = options.saveToDatabase !== false
  }
  
  console.log('[comprehensiveCrawler] Starting with real opportunities...')
  
  // Build profile signals
  const signals = buildProfileSignals(profileContext)
  const profileState = profileContext.state || profileContext.signals?.location?.state
  const profileId = profileContext.id
  
  console.log('[comprehensiveCrawler] Profile signals:', summarizeProfileSignals(signals))
  console.log('[comprehensiveCrawler] Profile state:', profileState)
  
  // Load real opportunities
  const realOpps = loadRealOpportunities()
  console.log(`[comprehensiveCrawler] Loaded ${realOpps.length} real opportunities`)
  
  // Also load from database
  const dbOpps = db.prepare(`
    SELECT * FROM funding_opportunities 
    WHERE is_active = 1 
    AND (requires_match = 0 OR requires_match IS NULL)
    ORDER BY created_at DESC
    LIMIT 200
  `).all()
  
  console.log(`[comprehensiveCrawler] Found ${dbOpps.length} opportunities in database`)
  
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
  
  for (const opp of allOpps) {
    // Skip if requires matching funds
    if (opp.requires_match) continue
    
    const { score, matchReasons } = calculateOpportunityMatch(opp, signals, profileState)
    
    if (score >= matchThreshold) {
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
  
  // Save to database if requested
  let insertedCount = 0
  if (saveToDatabase) {
    for (const opp of topOpps) {
      try {
        const result = upsertFundingOpportunity(db, {
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
  }
  
  // Save high matches to profile pipeline if profileId provided
  let savedToProfile = 0
  if (profileId) {
    for (const opp of topOpps.filter(o => o.match_score >= 80)) {
      try {
        // Find the inserted opportunity ID
        const insertedOpp = db.prepare(`
          SELECT id FROM funding_opportunities 
          WHERE source = 'verified_real' AND source_id = ?
          LIMIT 1
        `).get(opp.id || opp.source_id)
        
        if (insertedOpp) {
          const oppWithId = { ...opp, id: insertedOpp.id }
          const result = await saveToProfilePipeline(db, oppWithId, profileId, profileContext, opp.match_score)
          if (result.saved) {
            savedToProfile++
          }
        }
      } catch (err) {
        // Ignore duplicates
        console.warn(`[comprehensiveCrawler] Could not save to pipeline: ${err.message}`)
      }
    }
  }
  
  console.log(`[comprehensiveCrawler] Saved ${savedToProfile} opportunities to profile pipeline (≥80% match)`)
  
  return {
    success: true,
    opportunities: topOpps.map(opp => ({
      id: opp.id,
      title: opp.title,
      sponsor: opp.sponsor,
      description: opp.description,
      amount_min: opp.amount_min,
      amount_max: opp.amount_max,
      amount_description: opp.amount_description,
      deadline: opp.deadline,
      application_url: opp.application_url,
      state: opp.state,
      match_score: opp.match_score,
      match_reasons: opp.match_reasons,
      requires_match: false,
      eligibility_bullets: opp.eligibility_bullets,
      categories: opp.categories
    })),
    total: topOpps.length,
    inserted: insertedCount,
    savedToProfile,
    message: `Found ${topOpps.length} real funding opportunities matching your profile.`
  }
}

// Export for backward compatibility
export default runComprehensiveCrawler
