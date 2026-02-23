/**
 * Item Crawler - Matches equipment/item funding sources to profiles
 * 
 * Finds grants for specific items like vehicles, computers, equipment, etc.
 */

import fs from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { upsertFundingOpportunity } from './opportunityInserter.js'
import {
  buildProfileSignals,
  summarizeProfileSignals,
  safeParseArrayField,
} from './profileHelpers.js'

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
 * Calculate match score between item funding source and profile/item request
 */
function calculateItemMatch(opp, itemKeywords, profileState, signals) {
  let score = 30
  const matchReasons = []
  
  const oppText = `${opp.title} ${opp.description}`.toLowerCase()
  const oppKeywords = new Set([
    ...(opp.keywords || []).map(k => k.toLowerCase()),
    ...(opp.keywords_extra || []).map(k => k.toLowerCase()),
    ...(opp.categories || []).map(c => c.toLowerCase())
  ])
  
  // Item keyword matching (most important)
  let itemMatches = 0
  for (const keyword of itemKeywords) {
    const kw = keyword.toLowerCase()
    if (oppKeywords.has(kw) || oppText.includes(kw)) {
      itemMatches++
      matchReasons.push(`Item match: ${keyword}`)
    }
  }
  score += Math.min(40, itemMatches * 15)
  
  // State match
  if (opp.states?.includes('ALL') || opp.states?.includes(profileState) || opp.state === 'nationwide') {
    score += 10
    if (opp.states?.includes(profileState)) {
      matchReasons.push(`Available in ${profileState}`)
    }
  } else if (opp.states && !opp.states.includes('ALL') && !opp.states.includes(profileState)) {
    // Wrong state
    score -= 20
  }
  
  // Profile signals bonus
  if (signals.keywords) {
    let profileMatches = 0
    for (const keyword of signals.keywords) {
      if (oppKeywords.has(keyword) || oppText.includes(keyword)) {
        profileMatches++
      }
    }
    score += Math.min(10, profileMatches * 3)
  }
  
  // 501c3 check
  if (opp.requires_501c3 && !signals.is_nonprofit) {
    score -= 15
    matchReasons.push('Note: Requires 501(c)(3) status')
  }
  
  score = Math.max(0, Math.min(100, score))
  
  return { score, matchReasons }
}

/**
 * Process item crawler job - finds funding for specific items/equipment
 */
export async function processItemCrawlerJob({ db, job, dataDir, profileContext }) {
  console.log('[itemCrawler] Starting item funding search...')
  
  const parameters = job.parameters ?? {}
  const matchThreshold = parameters.match_threshold || 50
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
  
  console.log('[itemCrawler] Searching for:', itemKeywords.join(', '))
  
  // Build profile signals
  const signals = buildProfileSignals(profileContext)
  const profileState = profileContext?.profile?.state || 
                       profileContext?.sections?.location_focus?.state ||
                       parameters.state
  
  console.log('[itemCrawler] Profile state:', profileState)
  
  // Load item funding sources
  const itemSources = loadJSON(join(dataDir, 'item_funding_sources.json'))
  console.log(`[itemCrawler] Loaded ${itemSources.length} item funding sources`)
  
  // Also check database for equipment grants
  const keywordConditions = itemKeywords.map(() => 
    '(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(keywords) LIKE ?)'
  ).join(' OR ')
  
  const keywordParams = itemKeywords.flatMap(k => {
    const pattern = `%${k.toLowerCase()}%`
    return [pattern, pattern, pattern]
  })
  
  const dbOpps = db.prepare(`
    SELECT * FROM funding_opportunities 
    WHERE is_active = 1 
    AND (requires_match = 0 OR requires_match IS NULL)
    AND source NOT IN ('comprehensive_crawler', 'synthetic', 'template')
    AND (${keywordConditions})
    LIMIT 50
  `).all(...keywordParams)
  
  console.log(`[itemCrawler] Found ${dbOpps.length} matching opportunities in database`)
  
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
  
  for (const opp of allOpps) {
    if (opp.requires_match) continue
    
    const { score, matchReasons } = calculateItemMatch(opp, itemKeywords, profileState, signals)
    
    scoredOpps.push({
      ...opp,
      match_score: score,
      match_reasons: matchReasons
    })
  }
  
  // Sort and filter by requested threshold only — no fallback relaxation
  scoredOpps.sort((a, b) => b.match_score - a.match_score)
  const requestedThreshold = Number(matchThreshold) || 0
  const filteredOpps = scoredOpps.filter((opp) => (opp.match_score ?? 0) >= requestedThreshold)

  const topOpps = filteredOpps.slice(0, maxResults)
  
  console.log(
    `[itemCrawler] Found ${topOpps.length} matching item funding sources (threshold: ${requestedThreshold}%)`,
  )
  
  // Insert into database
  let upsertedCount = 0
  let insertedCount = 0
  let updatedCount = 0
  for (const opp of topOpps) {
    try {
      const result = await upsertFundingOpportunity(db, {
        title: opp.title,
        sponsor: opp.sponsor,
        description: opp.description,
        amount_min: opp.amount_min,
        amount_max: opp.amount_max,
        deadline: opp.deadline,
        application_url: opp.application_url ?? null,
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
      console.error(`[itemCrawler] Error inserting ${opp.title}:`, err.message)
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
      match_threshold: requestedThreshold,
      match_threshold_requested: requestedThreshold,
      match_threshold_used: requestedThreshold,
      match_threshold_fallback_applied: false,
    },
    opportunityLogs: topOpps.map(o => ({
      title: o.title,
      sponsor: o.sponsor,
      score: o.match_score,
      reasons: o.match_reasons
    }))
  }
}

export default processItemCrawlerJob
