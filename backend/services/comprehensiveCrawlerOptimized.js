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
import { runNationalZipCrawl } from './crawlers/nationalZipCrawler.js'

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
  const keywordIterable = signals?.keywords || signals?.keywordSet || signals?.keyword_set || null
  if (keywordIterable) {
    for (const keywordRaw of keywordIterable) {
      const keyword = String(keywordRaw ?? '').toLowerCase().trim()
      if (!keyword) continue
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

    // Geo crawl mode: run a small ZIP-scoped discovery crawl to populate the opportunity catalog.
    // This is used by the Geo Crawl admin UI. It is intentionally separate from profile matching.
    if (String(params.mode || '').toLowerCase() === 'geo') {
      const state = params.state ? String(params.state).toUpperCase() : null
      const maxZips = Number(params.max_zips ?? params.maxZips ?? 50)
      const batchSize = Number(params.batch_size ?? Math.min(50, Math.max(1, maxZips || 50)))
      const rateLimitMs = Number(params.rate_limit_ms ?? 250)
      const minSources = Number(params.min_sources_per_zip ?? 3)
      const zipList =
        Array.isArray(params.zip_list) && params.zip_list.length > 0
          ? params.zip_list
          : Array.isArray(params.zips) && params.zips.length > 0
            ? params.zips
            : null
      const discoverLocal =
        params.discover_local_resources ?? params.discoverLocalResources ?? true
      const overpassRadiusKm = Number(params.overpass_radius_km ?? 12)
      const overpassMaxResults = Number(params.overpass_max_results ?? 60)

      console.log('[comprehensiveCrawler] GEO mode starting', { state, maxZips, batchSize })
      const result = await runNationalZipCrawl(db, {
        state: state && /^[A-Z]{2}$/.test(state) ? state : undefined,
        zip_list: zipList || undefined,
        max_zips: Number.isFinite(maxZips) ? maxZips : 50,
        batch_size: Number.isFinite(batchSize) ? batchSize : 25,
        rate_limit_ms: Number.isFinite(rateLimitMs) ? rateLimitMs : 250,
        min_sources_per_zip: Number.isFinite(minSources) ? minSources : 1,
        discover_local_resources: Boolean(discoverLocal),
        overpass_radius_km: Number.isFinite(overpassRadiusKm) ? overpassRadiusKm : 12,
        overpass_max_results: Number.isFinite(overpassMaxResults) ? overpassMaxResults : 60,
        resume: false,
      })

      return {
        success: true,
        inserted: Number(result?.sources ?? 0),
        evaluated: Number(result?.processed ?? 0),
        result_meta: {
          mode: 'geo',
          state: state ?? null,
          processed: result?.processed ?? 0,
          sources: result?.sources ?? 0,
          failed: result?.failed ?? 0,
          skipped: result?.skipped ?? 0,
          total_zips: result?.total_zips ?? null,
        },
        message: `Geo crawl completed: processed ${result?.processed ?? 0} ZIPs`,
      }
    }

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
    
    scoredOpps.push({
      ...opp,
      match_score: score,
      match_reasons: matchReasons
    })
  }
  
  // Sort by score and limit
  scoredOpps.sort((a, b) => b.match_score - a.match_score)
  const targetMin = Math.min(10, maxResults)
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
    `[comprehensiveCrawler] Found ${topOpps.length} matching opportunities (requested: ${requestedThreshold}%, used: ${thresholdUsed}%)`,
  )
  
  // Save to database if requested
  let upsertedCount = 0
  let insertedCount = 0
  let updatedCount = 0
  if (saveToDatabase) {
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
          application_url: opp.application_url ?? null,
          source_url: opp.source_url ?? opp.application_url ?? null,
          categories: opp.categories,
          keywords: opp.keywords,
          eligibility_bullets: opp.eligibility_bullets,
          requires_match: false,
          requires_501c3: opp.requires_501c3,
          state: opp.state,
          source: 'verified_real',
          source_id: opp.id || opp.source_id,
          record_origin: 'curated_verified',
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
    inserted: upsertedCount,
    inserted_new: insertedCount,
    updated_existing: updatedCount,
    savedToProfile,
    result_meta: {
      total_scored: scoredOpps.length,
      match_threshold_requested: requestedThreshold,
      match_threshold_used: thresholdUsed,
      match_threshold_fallback_applied: thresholdFallbackApplied,
    },
    message: `Found ${topOpps.length} real funding opportunities matching your profile.`
  }
}

// Export for backward compatibility
export default runComprehensiveCrawler
