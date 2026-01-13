/**
 * Real Web Crawler API Routes
 * Handles execution of specialized funding crawlers
 * Production version - uses only real data sources
 */

import express from 'express'
import { ensureAuth } from '../middleware/auth.js'
import { getProfileWithLocation } from '../services/crawlers/crawlerHelpers.js'
import { calculateMatchScore } from '../services/matchingEngine.js'

const router = express.Router()

// Crawler types
const CRAWLER_TYPES = [
  'local_funding',
  'government_funding', 
  'student_grants',
  'ecf_benefits',
  'item_matching',
  'special_needs'
]

const LOAN_TYPES = new Set(['loan', 'loan_program', 'microloan'])

function normalizeString(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

function safeParseJSON(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (Array.isArray(value)) return value
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function buildSearchTokens(profileContext) {
  const signals = profileContext?.signals
  const tokens = new Set()

  // Prefer richer signals when present.
  if (signals?.phrases && typeof signals.phrases[Symbol.iterator] === 'function') {
    for (const phrase of signals.phrases) {
      const normalized = normalizeString(String(phrase))
      if (normalized.length >= 4) tokens.add(normalized)
      if (tokens.size >= 12) break
    }
  }

  if (tokens.size < 12 && signals?.keywordSet && typeof signals.keywordSet[Symbol.iterator] === 'function') {
    for (const kw of signals.keywordSet) {
      const normalized = normalizeString(String(kw))
      if (normalized.length >= 4) tokens.add(normalized)
      if (tokens.size >= 12) break
    }
  }

  // Fallback to tags/focus areas if signals missing.
  const profile = profileContext?.profile
  const fallback = []
  if (Array.isArray(profile?.tags)) fallback.push(...profile.tags)
  if (Array.isArray(profile?.interests)) fallback.push(...profile.interests)
  fallback.forEach((value) => {
    const normalized = normalizeString(String(value))
    if (normalized.length >= 4) tokens.add(normalized)
  })

  return Array.from(tokens).slice(0, 12)
}

function isOpportunityCurrent(row) {
  const deadlineType = normalizeString(row?.deadline_type)
  if (deadlineType === 'rolling' || deadlineType === 'ongoing') return true

  const deadline = row?.deadline
  if (!deadline) return true

  const parsed = new Date(deadline)
  if (Number.isNaN(parsed.getTime())) {
    // Unknown format; don't exclude automatically.
    return true
  }

  const now = new Date()
  // Expired deadlines are not relevant in 2026 (unless rolling/ongoing).
  return parsed >= new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function formatDbOpportunity(row) {
  if (!row) return null
  const keywords = safeParseJSON(row.keywords, [])
  const categories = safeParseJSON(row.categories, [])
  const eligibility_bullets = safeParseJSON(row.eligibility_bullets, [])
  const match_reasons = safeParseJSON(row.match_reasons, [])

  return {
    ...row,
    keywords,
    categories,
    eligibility_bullets,
    match_reasons,
    // Normalize url fields used by frontend.
    url: row.application_url ?? row.source_url ?? null,
  }
}

function buildCandidateOpportunityQuery({ crawlerType, profileContext, tokens, itemRequest }) {
  const conditions = ['is_active = 1']
  const params = []

  // Avoid obviously non-grant programs by default.
  conditions.push("(requires_match IS NULL OR requires_match = 0 OR requires_match = '0' OR requires_match = 'false')")
  conditions.push("(match_percentage IS NULL OR match_percentage = 0 OR match_percentage = '0')")
  conditions.push("(opportunity_type IS NULL OR LOWER(opportunity_type) NOT IN ('loan','loan_program','microloan'))")

  // Exclude expired deadlines by default (rolling/ongoing/NULL are allowed).
  conditions.push('(deadline_type IN ("rolling","ongoing") OR deadline IS NULL OR deadline >= date("now"))')

  // Geography: state + national.
  const state = profileContext?.signals?.location?.state ?? profileContext?.profile?.state ?? null
  if (state && typeof state === 'string' && state.trim().length === 2) {
    conditions.push('(state = ? OR is_national = 1 OR state IS NULL)')
    params.push(state.trim().toUpperCase())
  }

  // Crawler-type hints (lightweight pre-filter).
  if (crawlerType === 'student_grants') {
    conditions.push('(LOWER(opportunity_type) IN ("scholarship","grant") OR LOWER(title) LIKE "%scholar%" OR LOWER(description) LIKE "%scholar%")')
  }
  if (crawlerType === 'ecf_benefits') {
    conditions.push('(LOWER(source) = "ecf_choices_discovery" OR LOWER(title) LIKE "%ecf%" OR LOWER(description) LIKE "%ecf%")')
  }
  if (crawlerType === 'special_needs') {
    conditions.push('(LOWER(title) LIKE "%disab%" OR LOWER(description) LIKE "%disab%" OR LOWER(title) LIKE "%cancer%" OR LOWER(description) LIKE "%cancer%")')
  }
  if (crawlerType === 'government_funding') {
    conditions.push('(LOWER(source) IN ("grants.gov","usaspending.gov","grants_gov","usa_spending","state_portal","hud_cdbg","liheap","snap_et") OR LOWER(title) LIKE "%federal%" OR LOWER(description) LIKE "%federal%")')
  }

  // Keyword narrowing from profile (kept small to avoid huge SQL).
  if (tokens.length > 0) {
    const tokenClauses = tokens
      .map(() => '(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(keywords) LIKE ? OR LOWER(categories) LIKE ?)')
      .join(' OR ')
    conditions.push(`(${tokenClauses})`)
    tokens.forEach((token) => {
      const pattern = `%${token}%`
      params.push(pattern, pattern, pattern, pattern)
    })
  }

  // Item-specific narrowing if provided.
  if (crawlerType === 'item_matching' && itemRequest && typeof itemRequest === 'string') {
    const itemTokens = itemRequest
      .split(/[^a-z0-9]+/gi)
      .map((t) => normalizeString(t))
      .filter((t) => t.length >= 3)
      .slice(0, 6)
    if (itemTokens.length > 0) {
      const itemClauses = itemTokens
        .map(() => '(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(keywords) LIKE ?)')
        .join(' OR ')
      conditions.push(`(${itemClauses})`)
      itemTokens.forEach((token) => {
        const pattern = `%${token}%`
        params.push(pattern, pattern, pattern)
      })
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  // Prefer recent/updated opportunities so we don’t “drift” back into 2024-only data.
  const sql = `
    SELECT *
    FROM funding_opportunities
    ${where}
    ORDER BY
      CASE WHEN deadline IS NULL OR deadline = '' THEN 1 ELSE 0 END,
      deadline ASC,
      updated_at DESC
    LIMIT 1500
  `

  return { sql, params }
}

/**
 * Run a specific crawler
 * POST /api/real-crawlers/run
 */
router.post('/run', ensureAuth, async (req, res) => {
  const {
    crawler_type,
    profile_id,
    profile_data,
    item_request,
    min_match_score = 50, // Lowered to 50; crawlers now use 100% of profile signals
  } = req.body
  
  if (!crawler_type || !CRAWLER_TYPES.includes(crawler_type)) {
    return res.status(400).json({ 
      error: 'Invalid crawler type',
      message: `Invalid crawler type: ${crawler_type}`,
      available_crawlers: CRAWLER_TYPES
    })
  }
  
  // Hard guard: we will not run crawlers unless we can load the full profile context
  // (all profile_sections + derived signals) from the database.
  if (!profile_id) {
    return res.status(400).json({
      error: 'Profile ID required',
      message: 'Crawler runs require a profile_id so we can use 100% of the profile sections/signals.',
    })
  }
  
  try {
    const db = req.db
    
    // Prefer DB-backed profile_id so we always use the full 22-page profile_sections context.
    let profile = null
    if (profile_id) {
      profile = getProfileWithLocation(db, profile_id)
    } else {
      profile = profile_data
    }

    if (!profile) {
      return res.status(404).json({
        error: 'Profile not found',
        message: `Profile with ID ${profile_id} does not exist`,
      })
    }

    const profileContext =
      profile && profile.sections && profile.signals
        ? { profile, sections: profile.sections, signals: profile.signals }
        : { profile, sections: profile?.sections ?? {}, signals: profile?.signals ?? null }

    const coveragePct = profileContext?.signals?.coverage?.pct ?? 0
    if (!profileContext?.sections || Object.keys(profileContext.sections).length === 0 || coveragePct < 1) {
      return res.status(400).json({
        error: 'Profile context incomplete',
        message:
          'Refusing to run: crawler requires 100% profile coverage (all sections loaded and included in signals). Please complete/save the profile sections and retry.',
        coverage: profileContext?.signals?.coverage ?? null,
      })
    }
    
    console.log(`[RealCrawlers] Running ${crawler_type} for profile ${profile_id || 'custom'}`)
    
    // Match against the live ingested opportunity database (fast, stable, always uses full profile data).
    const startTime = Date.now()
    let candidates = []
    
    try {
      const tokens = buildSearchTokens(profileContext)
      const { sql, params } = buildCandidateOpportunityQuery({
        crawlerType: crawler_type,
        profileContext,
        tokens,
        itemRequest: item_request,
      })
      candidates = db.prepare(sql).all(...params).map(formatDbOpportunity).filter(Boolean)
    } catch (crawlerError) {
      console.error(`[RealCrawlers] Crawler ${crawler_type} failed:`, crawlerError)
      
      // Return detailed error information
      let errorMessage = crawlerError.message || 'Unknown crawler error'
      let errorDetails = null
      
      // Check for common error patterns and provide helpful messages
      if (errorMessage.includes('SAM_GOV_API_KEY') || errorMessage.includes('API key')) {
        errorMessage = 'SAM_GOV_API_KEY missing - government funding crawler requires API configuration'
      } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('network')) {
        errorMessage = 'Network error - unable to reach external funding sources'
      } else if (errorMessage.includes('timeout')) {
        errorMessage = 'Request timeout - external service is not responding'
      }
      
      return res.status(500).json({
        error: 'Crawler execution failed',
        message: errorMessage,
        crawler: crawler_type,
        status: 500,
        timestamp: new Date().toISOString()
      })
    }
    
    const duration = Date.now() - startTime
    
    // Score all candidates using the deterministic engine (uses full sections/signals).
    const scored = candidates
      .filter((row) => isOpportunityCurrent(row))
      .map((row) => {
        const { score, reasons } = calculateMatchScore(profileContext, row)
        return {
          ...row,
          match_score: score,
          match_reasons: reasons,
          // Normalize sponsor/title for UI
          sponsor: row.sponsor ?? row.funder ?? null,
        }
      })

    const totalFound = scored.length

    // Filter by minimum match score (default lowered; UI can adjust).
    const filteredOpportunities = scored
      .filter((opp) => typeof opp.match_score === 'number' && opp.match_score >= Number(min_match_score))
      .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
      .slice(0, 50)

    console.log(
      `[RealCrawlers] ${crawler_type} evaluated ${totalFound} candidates; returning ${filteredOpportunities.length} (min_score=${min_match_score}) in ${duration}ms`,
    )
    
    res.json({
      success: true,
      crawler_type,
      count: filteredOpportunities.length,
      total_found: totalFound,
      filtered_count: filteredOpportunities.length,
      min_match_score,
      duration,
      opportunities: filteredOpportunities
    })
    
  } catch (error) {
    console.error(`[RealCrawlers] Error in ${crawler_type}:`, error)
    res.status(500).json({ 
      error: 'Crawler execution failed',
      message: error.message,
      crawler_type
    })
  }
})

/**
 * Get all available crawlers
 * GET /api/real-crawlers/list
 */
router.get('/list', ensureAuth, (req, res) => {
  const crawlers = CRAWLER_TYPES.map(type => ({
    id: type,
    name: type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
    description: getCrawlerDescription(type),
    available: true
  }))
  
  res.json({
    crawlers,
    total: crawlers.length
  })
})

/**
 * Run multiple crawlers for a profile
 * POST /api/real-crawlers/run-multiple
 */
router.post('/run-multiple', ensureAuth, async (req, res) => {
  const { profile_id, crawler_types, min_match_score = 60 } = req.body
  
  if (!profile_id) {
    return res.status(400).json({ 
      error: 'Profile ID required',
      message: 'profile_id is required for running multiple crawlers'
    })
  }
  
  if (!crawler_types || !Array.isArray(crawler_types)) {
    return res.status(400).json({ 
      error: 'Crawler types array required',
      message: 'crawler_types must be an array of crawler type strings'
    })
  }
  
  const db = req.db
  const profile = getProfileWithLocation(db, profile_id)
  
  if (!profile) {
    return res.status(404).json({ 
      error: 'Profile not found',
      message: `Profile with ID ${profile_id} does not exist`
    })
  }
  
  const succeeded = []
  const failed = []
  let totalFound = 0
  let totalInserted = 0

  const profileContextBase =
    profile && profile.sections && profile.signals
      ? { profile, sections: profile.sections, signals: profile.signals }
      : { profile, sections: profile?.sections ?? {}, signals: profile?.signals ?? null }

  const coveragePct = profileContextBase?.signals?.coverage?.pct ?? 0
  if (!profileContextBase?.sections || Object.keys(profileContextBase.sections).length === 0 || coveragePct < 1) {
    return res.status(400).json({
      error: 'Profile context incomplete',
      message:
        'Refusing to run: crawlers require 100% profile coverage (all sections loaded and included in signals). Please complete/save the profile sections and retry.',
      coverage: profileContextBase?.signals?.coverage ?? null,
    })
  }
  
  for (const crawlerType of crawler_types) {
    if (!CRAWLER_TYPES.includes(crawlerType)) {
      failed.push({
        crawler: crawlerType,
        error: 'Invalid crawler type',
        status: 400
      })
      continue
    }
    
    try {
      const profileContext = profileContextBase

      const tokens = buildSearchTokens(profileContext)
      const { sql, params } = buildCandidateOpportunityQuery({
        crawlerType,
        profileContext,
        tokens,
      })

      const candidates = db.prepare(sql).all(...params).map(formatDbOpportunity).filter(Boolean)
      const scored = candidates
        .filter((row) => isOpportunityCurrent(row))
        .map((row) => {
          const { score, reasons } = calculateMatchScore(profileContext, row)
          return { ...row, match_score: score, match_reasons: reasons }
        })

      const filtered = scored
        .filter((opp) => typeof opp.match_score === 'number' && opp.match_score >= Number(min_match_score))
        .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
        .slice(0, 50)

      totalFound += scored.length
      totalInserted += filtered.length
      
      succeeded.push({
        crawler: crawlerType,
        found: scored.length,
        inserted: filtered.length
      })
    } catch (error) {
      console.error(`[RealCrawlers] Error in ${crawlerType}:`, error)
      
      // Provide helpful error messages
      let errorMessage = error.message || 'Unknown error'
      if (errorMessage.includes('SAM_GOV_API_KEY')) {
        errorMessage = 'SAM_GOV_API_KEY missing'
      } else if (errorMessage.includes('network') || errorMessage.includes('ENOTFOUND')) {
        errorMessage = 'Network error - unable to reach external sources'
      }
      
      failed.push({
        crawler: crawlerType,
        error: errorMessage,
        status: 500
      })
    }
  }
  
  res.json({
    totalSelected: crawler_types.length,
    succeeded,
    failed,
    totalFound,
    totalInserted
  })
})

/**
 * Get crawler description
 */
function getCrawlerDescription(type) {
  const descriptions = {
    local_funding: 'Searches for funding opportunities within 50 miles of your location',
    government_funding: 'Finds federal, state, and local government grants and programs',
    student_grants: 'Discovers scholarships, grants, and financial aid for students',
    ecf_benefits: 'Locates ECF CHOICES benefits and disability support services',
    item_matching: 'Matches specific item requests with funding sources',
    special_needs: 'Identifies funding for special needs, disabilities, and unique circumstances'
  }
  
  return descriptions[type] || 'Specialized funding crawler'
}

/**
 * Save opportunities to database
 */
// NOTE:
// We intentionally do not write crawler matches back into funding_opportunities here.
// funding_opportunities is maintained by the ingestion pipeline; "crawler runs" should
// query + score existing live opportunities for the selected profile.

export default router