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
export function processItemCrawlerJob({ db, job, dataDir, profileContext }) {
  console.log('[itemCrawler] Starting item funding search...')
  
  const parameters = job.parameters ?? {}
  const matchThreshold = parameters.match_threshold || 50
  const maxResults = parameters.max_results || 20
  
  // Get item keywords from job parameters
  let itemKeywords = parameters.item_keywords || parameters.keywords || []
  if (typeof itemKeywords === 'string') {
    itemKeywords = itemKeywords.split(',').map(k => k.trim()).filter(Boolean)
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
    
    const { score, matchReasons } = calculateItemMatch(opp, itemKeywords, profileState, signals)
    
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
  
  console.log(`[itemCrawler] Found ${topOpps.length} matching item funding sources`)
  
  // Insert into database
  let insertedCount = 0
  for (const opp of topOpps) {
    try {
      const result = upsertFundingOpportunity(db, {
        title: opp.title,
        sponsor: opp.sponsor,
        description: opp.description,
        amount_min: opp.amount_min,
        amount_max: opp.amount_max,
        deadline: opp.deadline,
        application_url: opp.application_url,
        categories: opp.categories,
        keywords: [...(opp.keywords || []), ...(opp.keywords_extra || [])],
        eligibility_bullets: opp.eligibility_bullets,
        requires_match: false,
        requires_501c3: opp.requires_501c3,
        state: opp.states?.includes('ALL') ? 'nationwide' : (opp.states?.[0] || 'nationwide'),
        source: 'item_funding',
        source_id: opp.id,
        match_reasons: opp.match_reasons
      })
      
      if (result.inserted) {
        insertedCount++
      }
    } catch (err) {
      console.error(`[itemCrawler] Error inserting ${opp.title}:`, err.message)
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

export default processItemCrawlerJob
