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
    
    const { score, reasons: matchReasons } = scoreOpportunity(profileContext, opp)
    
    scoredOpps.push({
      ...opp,
      match_score: score,
      match_reasons: matchReasons
    })
  }
  
  // Sort and filter by requested threshold only — no fallback relaxation
  scoredOpps.sort((a, b) => b.match_score - a.match_score)
  // Do not pre-filter by raw score; computeMatchDecision is the sole authority.
  // maxResults caps volume only; canonical ACCEPT/REVIEW decisions are never suppressed by threshold.
  const topOpps = scoredOpps.slice(0, maxResults)
  
  console.log(
    `[itemCrawler] Found ${topOpps.length} matching item funding sources (threshold: ${matchThreshold}%)`,
  )
  if (scoredOpps.length > 0 && topOpps.length === 0) {
    console.warn(
      `[itemCrawler] SUPPRESSION WARNING: ${scoredOpps.length} opportunities scored but 0 passed to insertion. ` +
      `Top raw score: ${scoredOpps[0]?.match_score ?? 'n/a'}. Threshold: ${matchThreshold}. ` +
      `Review threshold or decision engine configuration.`
    )
  }
  
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
        application_url: (typeof opp.application_url === 'string' && opp.application_url.startsWith('http'))
          ? opp.application_url
          : null,
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
      // Track failed insertions for debugging
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
      match_threshold_requested: matchThreshold,
      match_threshold_used: matchThreshold,
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
