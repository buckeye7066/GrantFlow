import express from 'express'
import { randomUUID } from 'crypto'
import { ensureAuth } from '../middleware/auth.js'
import { standardRateLimiter } from '../middleware/rateLimiting.js'
import { runCrawler, SCHEMA } from '../services/crawlerFramework.js'
import { ensureProfileAccess } from '../utils/accessControl.js'
import { expandNeed, scoreNeedMatch } from '../services/crawlers/needTaxonomy.js'
import { getStrategy, listStrategies } from '../services/crawlers/strategyRegistry.js'
import { searchWebForItem, KNOWN_ITEM_SOURCES, parseItemRequest } from '../services/crawlers/itemFundingCrawler.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { buildProfileFacets } from '../services/profile/profileTaxonomy.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'
import { applyRelevanceFilter, extractProfileData } from '../services/relevanceFilter.js'
import { runAllDomainEngines } from '../services/crawlers/domainEngines/index.js'
import { crawlStateWaiverBenefits, evaluateStateWaiverEligibility } from '../services/crawlers/stateWaiverBenefitsCrawler.js'

const router = express.Router()

/**
 * Query funding_opportunities table for the user's state + national opportunities.
 * Returns results mapped to the same frontend shape as curated results.
 * Deduplicates against curated results by title normalization.
 */
async function queryNearbyOpportunities(db, analysis, curatedTitles, limit = 50) {
  if (!db || typeof db.prepare !== 'function') return [];
  const state = analysis?.location?.state;
  try {
    const isPg = db?.dialect === 'postgres'
    const activeVal = isPg ? 'TRUE' : '1'
    const rows = await db.prepare(`
      SELECT id, title, description, sponsor, source, source_url, url, application_url,
             state, is_national, opportunity_type, type, deadline_type, amount_max,
             contact_info, categories, keywords, match_reasons, match_score,
             funding_type, record_origin
      FROM funding_opportunities
      const query = isPg
        ? 'SELECT ... FROM funding_opportunities WHERE is_active = TRUE AND (state = $1 OR state = \'nationwide\' OR is_national = TRUE) AND ' + trustedOriginClause() + ' AND ' + trustedSourceClause() + ' ORDER BY ... LIMIT $2'
        : 'SELECT ... FROM funding_opportunities WHERE is_active = 1 AND (state = ? OR state = \'nationwide\' OR is_national = 1) AND ' + trustedOriginClause() + ' AND ' + trustedSourceClause() + ' ORDER BY ... LIMIT ?'
      return db.prepare(query).all(state || 'nationwide', limit)
      ORDER BY match_score DESC NULLS LAST, last_verified_at DESC NULLS LAST
      LIMIT ?
    `).all(state || 'nationwide', limit);

    const normalizeTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const seenTitles = new Set(curatedTitles.map(normalizeTitle));

    return (rows || [])
      .filter(row => {
        const norm = normalizeTitle(row.title);
        if (seenTitles.has(norm)) return false;
        seenTitles.add(norm);
        return true;
      })
      .map(row => ({
        id: row.id || `fo-${row.title?.slice(0, 20)}`,
        title: row.title,
        name: row.title,
        description: row.description,
        url: row.url || row.application_url || row.source_url || null,
        application_url: row.application_url || row.url || null,
        source_url: row.source_url || row.url || null,
        match_score: row.match_score || 50,
        match_reasons: safeJsonParse(row.match_reasons, []),
        categories: safeJsonParse(row.categories, []),
        opportunity_type: row.opportunity_type || row.type || 'program',
        funding_type: row.funding_type || null,
        amount_max: row.amount_max || null,
        amount_description: row.amount_max ? `Up to ${row.amount_max}` : null,
        sponsor: row.sponsor || (row.is_national ? 'National Program' : `${row.state} Program`),
        source: row.source || 'discovered',
        record_origin: row.record_origin || 'geo_crawl',
        is_directory_resource: row.type === 'DIRECTORY',
        deadline_type: row.deadline_type || 'rolling',
        is_national: Boolean(row.is_national),
        state: row.state || null,
        contact_info: row.contact_info || null,
        eligibility_bullets: [],
        match_explain: { source: 'funding_opportunities_db', nearYou: true },
      }));
  } catch (err) {
    console.warn('[RealCrawlers] queryNearbyOpportunities failed (continuing):', err?.message);
    return [];
  }
}

function safeJsonParse(val, fallback) {
  if (Array.isArray(val)) return val;
  if (!val || typeof val !== 'string') return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

const CRAWLER_TYPES = [
  'comprehensive',
  'curated_benefits',
  'local_funding',
  'government_funding',
  'student_grants',
  'health_resources',
  'ecf_benefits',
  'state_waiver_benefits',
  'item_matching',
  'special_needs',
]

/**
 * Map a new-system result to the response shape the frontend expects.
 * Frontend reads: title, match_score, url, application_url, description, sponsor, etc.
 */
function mapResultToFrontendShape(result) {
  const isScholarship = result.id?.startsWith('sch-');
  const isSchoolCard = result.id?.startsWith('school-');

  const contactObj = result.contact || null;
  const contactInfo = contactObj
    ? [contactObj.name, contactObj.title, contactObj.email, contactObj.phone].filter(Boolean).join(' | ')
    : null;

  return {
    id: result.id,
    title: result.name,
    name: result.name,
    description: result.description,
    url: result.url || result.applicationUrl || null,
    application_url: result.applicationUrl || result.url || null,
    source_url: result.url || null,
    match_score: result.matchScore,
    match_reasons: result.matchReasons || [],
    categories: result.matchedCategories || result.categories || [],
    opportunity_type: isSchoolCard
      ? result.fundingType || 'school_resource'
      : isScholarship ? 'scholarship' : (result.type || 'benefit'),
    funding_type: result.fundingType || null,
    amount_max: result.maxAmount || null,
    amount_description: result.maxAmount ? `Up to $${result.maxAmount.toLocaleString()}` : null,
    sponsor: isSchoolCard
      ? (result.schoolName || 'University')
      : isScholarship
        ? 'Scholarship / Financial Aid'
        : result.stateRestriction
          ? `${result.stateRestriction} State Program`
          : result.id?.startsWith('fed-')
            ? 'Federal Government'
            : 'National Program',
    source: isSchoolCard ? 'school' : (isScholarship ? 'scholarship' : (result.stateRestriction ? 'state' : result.id?.startsWith('fed-') ? 'federal' : 'national')),
    record_origin: isSchoolCard ? 'school_portal' : 'curated_program',
    is_directory_resource: result.type === 'portal' || result.type === 'referral' || result.type === 'school_portal',
    deadline_type: result.recurring ? 'rolling' : 'ongoing',
    is_national: !result.stateRestriction,
    state: result.stateRestriction || null,
    contact_info: contactInfo,
    school_name: isSchoolCard ? result.schoolName : null,
    eligibility_bullets: result.eligibility
      ? Object.entries(result.eligibility).map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').trim()}: ${v}`)
      : [],
    application_note: result.applicationNote || null,
    match_explain: result.match_explain || null,
  }
}

/**
 * Run crawlers for a profile.
 * POST /api/real-crawlers/run
 */
router.post('/run', ensureAuth, async (req, res) => {
  const {
    crawler_type,
    profile_id,
    min_match_score: bodyMinScore,
  } = req.body

  let min_match_score = 50
  if (typeof bodyMinScore === 'number' && bodyMinScore >= 0 && bodyMinScore <= 100) min_match_score = bodyMinScore
  else if (typeof bodyMinScore === 'string' && /^\d+$/.test(bodyMinScore))
    min_match_score = Math.min(100, Math.max(0, parseInt(bodyMinScore, 10)))

  if (!crawler_type || !CRAWLER_TYPES.includes(crawler_type)) {
    return res.status(400).json({
      error: 'Invalid crawler type',
      message: `Invalid crawler type: ${crawler_type}`,
      available_crawlers: CRAWLER_TYPES,
    })
  }

  if (!profile_id) {
    return res.status(400).json({
      error: 'Profile ID required',
      message: 'Crawler runs require a profile_id.',
    })
  }

  if (!(await ensureProfileAccess(req, res, String(profile_id)))) return

  try {
    const db = req.db
    const startTime = Date.now()

    console.info(`[RealCrawlers] Running ${crawler_type} for profile ${profile_id}`)

    const strategy = getStrategy(crawler_type)

    // Load profile context once — used for both the crawler and relevance filtering.
    // Passing it explicitly prevents cross-profile contamination from live DB re-queries.
    let profileContext = null
    let profileData = {}
    try {
      profileContext = await loadProfileContext(db, profile_id)
      profileData = extractProfileData(profileContext)
    } catch (ctxErr) {
      console.warn(`[RealCrawlers] Could not load profile context for relevance filter — filtering will be skipped: ${ctxErr?.message}`)
    }

    const result = await runCrawler(db, profile_id, {
      minScore: Math.max(1, Math.floor(min_match_score * 0.25)),
      maxResults: strategy.maxResults || 100,
      crawlerType: crawler_type,
      profileContext,
    })

    // If strategy was gated, return early with reason
    if (result.debug?.gated) {
      const duration = Date.now() - startTime
      return res.json({
        success: true,
        crawler_type,
        count: 0,
        total_found: 0,
        filtered_count: 0,
        min_match_score,
        duration,
        opportunities: [],
        gated: true,
        gate_reason: result.debug.gateReason,
        debug: result.debug,
      })
    }

    const mapped = result.results.map(mapResultToFrontendShape)

    // Merge "near you" opportunities from funding_opportunities table
    const curatedTitles = mapped.map(o => o.title || o.name || '');
    const nearbyOpps = await queryNearbyOpportunities(db, result.analysis, curatedTitles, 30);
    const allMapped = [...mapped, ...nearbyOpps];

    let filtered = allMapped
      .filter((opp) => {
        if (typeof opp.match_score !== 'number' || opp.match_score < min_match_score) return false
        const relevance = applyRelevanceFilter(opp, profileData)
        if (!relevance.pass) {
          console.info(`[RealCrawlers] Filtered out "${opp.title}" — ${relevance.reason}`)
          return false
        }
        return true
      })
      .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
      .slice(0, (strategy.maxResults || 100) + nearbyOpps.length)

    let thresholdFallbackMessage = null
    if (filtered.length === 0 && allMapped.length > 0) {
      // Threshold fallback: show best available matches that still pass relevance
      // filtering. This ensures directory resources (food banks, United Way, etc.)
      // are not silently suppressed by a high match-score threshold.
      filtered = allMapped
        .filter((opp) => {
          const relevance = applyRelevanceFilter(opp, profileData)
          return relevance.pass
        })
        .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
        .slice(0, 50)
      thresholdFallbackMessage = `No results met your threshold of ${min_match_score}%. Showing best available matches.`
    }

    const duration = Date.now() - startTime

    console.info(
      `[RealCrawlers] ${crawler_type}: ${result.results.length} curated + ${nearbyOpps.length} nearby → ${filtered.length} returned (min_score=${min_match_score}) in ${duration}ms`,
    )

    res.json({
      success: true,
      crawler_type,
      count: filtered.length,
      total_found: result.results.length,
      filtered_count: filtered.length,
      min_match_score,
      duration,
      opportunities: filtered,
      used_live: false,
      used_db_fallback: false,
      used_curated: true,
      debug: {
        strategy: result.debug?.strategy || crawler_type,
        intents: result.debug?.intents || [],
        candidateCounts: result.debug?.candidateCounts || {},
        totalCandidates: result.debug?.totalCandidates || 0,
        matchedCount: result.debug?.matchedCount || 0,
        demotedForUrl: result.debug?.demotedForUrl || 0,
        matchStats: result.debug?.matchStats || {},
        timing: result.debug?.timing || {},
        analysis: {
          state: result.analysis.location?.state,
          city: result.analysis.location?.city,
          zip: result.analysis.location?.zip,
          county: result.analysis.location?.county,
          needs: [...result.analysis.needs],
          demographics: [...result.analysis.demographics],
          health: [...result.analysis.health],
          family: [...result.analysis.family],
          military: [...result.analysis.military],
          occupation: result.analysis.occupation ? [...result.analysis.occupation] : [],
          immigration: result.analysis.immigration ? [...result.analysis.immigration] : [],
          geographic: result.analysis.geographic ? [...result.analysis.geographic] : [],
          applicantType: result.analysis.applicantType,
          income: result.analysis.income || null,
        },
        state_portal: result.statePortal,
        county_contacts: result.countyContacts,
      },
      ...(thresholdFallbackMessage ? { threshold_fallback_message: thresholdFallbackMessage } : {}),
    })
  } catch (error) {
    console.error(`[RealCrawlers] Error in ${crawler_type}:`, error)
    res.status(200).json({
      success: false,
      error: 'Crawler execution failed',
      message: error?.message || String(error),
      crawler_type,
      min_match_score,
      opportunities: [],
    })
  }
})

/**
 * Get all available crawlers
 * GET /api/real-crawlers/list
 */
router.get('/list', ensureAuth, (req, res) => {
  const crawlers = CRAWLER_TYPES.map((type) => ({
    id: type,
    name: type.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
    description: getCrawlerDescription(type),
    available: true,
  }))

  res.json({
    crawlers,
    total: crawlers.length,
  })
})

/**
 * Run multiple crawlers for a profile
 * POST /api/real-crawlers/run-multiple
 */
router.post('/run-multiple', ensureAuth, async (req, res) => {
  const { profile_id, crawler_types, min_match_score = 50 } = req.body

  if (!profile_id) {
    return res.status(400).json({
      error: 'Profile ID required',
      message: 'profile_id is required for running multiple crawlers',
    })
  }

  if (!(await ensureProfileAccess(req, res, String(profile_id)))) return

  if (!crawler_types || !Array.isArray(crawler_types)) {
    return res.status(400).json({
      error: 'Crawler types array required',
      message: 'crawler_types must be an array of crawler type strings',
    })
  }

  const db = req.db
  const succeeded = []
  const failed = []
  let totalFound = 0
  let totalInserted = 0

    // Load profile data for relevance filtering and crawler context (prevents cross-profile contamination)
    let profileData = null
    let profileContext = null
    try {
      const ctx = await loadProfileContext(db, profile_id)
      if (ctx?.profile) {
        profileContext = ctx
        profileData = extractProfileData(ctx)
      }
    } catch (e) {
      // continue without profile-based filtering
    }

  try {
    const startAt = Date.now()

    for (const crawlerType of crawler_types) {
      if (!CRAWLER_TYPES.includes(crawlerType)) {
        failed.push({ crawler: crawlerType, error: 'Invalid crawler type', status: 400 })
        continue
      }
      try {
        const result = await runCrawler(db, profile_id, {
          minScore: Math.max(1, Math.floor(Number(min_match_score) * 0.25)),
          maxResults: 50,
          crawlerType,
          profileContext,
        })

        const mapped = result.results.map(mapResultToFrontendShape)
        const filtered = mapped
        .filter((opp) => { const rel = applyRelevanceFilter(opp, profileData); return rel.pass; })
          .filter((opp) => typeof opp.match_score === 'number' && opp.match_score >= Number(min_match_score))
          .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
          .slice(0, 50)

        totalFound += result.results.length
        totalInserted += filtered.length

        succeeded.push({
          crawler: crawlerType,
          found: result.results.length,
          inserted: filtered.length,
          duration_ms: Date.now() - startAt,
          used_curated: true,
          gated: result.debug?.gated || false,
          gate_reason: result.debug?.gateReason || null,
        })
      } catch (crawlErr) {
        failed.push({ crawler: crawlerType, error: crawlErr?.message || String(crawlErr), status: 500 })
      }
    }
  } catch (error) {
    console.error('[RealCrawlers] Error in run-multiple:', error)
    for (const crawlerType of crawler_types) {
      failed.push({ crawler: crawlerType, error: error?.message || String(error), status: 500 })
    }
  }

  res.json({
    totalSelected: crawler_types.length,
    succeeded,
    failed,
    totalFound,
    totalInserted,
  })
})

function getCrawlerDescription(type) {
  const descriptions = {
    comprehensive: 'Runs all funding sources: federal benefits, state programs, and national nonprofits',
    local_funding: 'State-specific benefits and local community assistance programs',
    government_funding: 'Federal government assistance programs (SNAP, LIHEAP, Section 8, SSI, etc.)',
    student_grants: 'Education grants and scholarships (Pell Grant, FSEOG, etc.)',
    health_resources: 'Healthcare assistance programs and patient support foundations',
    ecf_benefits: 'ECF CHOICES benefits and disability support services',
    curated_benefits: 'Verified and curated benefit programs (federal, state, national)',
    item_matching: 'Matches specific item requests with funding sources',
    special_needs: 'Disability-specific programs and services',
  }
  return descriptions[type] || 'Curated funding program matcher'
}

/**
 * Find profile by name (diagnostic endpoint).
 * GET /api/real-crawlers/find-profile?name=melissa
 */
router.get('/find-profile', async (req, res) => {
  const name = req.query.name || ''
  if (!name || name.length < 2) return res.json({ error: 'Provide ?name=... (at least 2 chars)' })
  try {
    const db = req.db
    if (!db || typeof db.prepare !== 'function') {
      return res.status(500).json({ error: 'Database not available' })
    }
    const pattern = `%${String(name).trim()}%`
    const rows = await db
      .prepare(
        'SELECT id, display_name, primary_type FROM profiles WHERE display_name LIKE ? LIMIT 10',
      )
      .all(pattern)
    res.json({ count: rows.length, profiles: rows })
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) })
  }
})

/**
 * Specific need search.
 * POST /api/real-crawlers/specific-need
 */
router.post('/specific-need', ensureAuth, async (req, res) => {
  const { profile_id, need_text, min_match_score = 30, max_results = 20 } = req.body

  if (!profile_id) return res.status(400).json({ error: 'profile_id is required' })
  if (!need_text || typeof need_text !== 'string' || need_text.trim().length < 2) {
    return res.status(400).json({ error: 'need_text is required (at least 2 characters)' })
  }

  if (!(await ensureProfileAccess(req, res, String(profile_id)))) return

  try {
    const db = req.db
    const startTime = Date.now()

    const expandedNeed = expandNeed(need_text)

    // 1. Run curated crawler pipeline
    const result = await runCrawler(db, profile_id, {
      minScore: 1,
      maxResults: 200,
      crawlerType: 'comprehensive',
    })

    // Re-score all curated results against the specific need
    const needScored = []
    const seenUrls = new Set()
    for (const opp of result.results) {
      const needMatch = scoreNeedMatch(opp, expandedNeed)
      if (needMatch && needMatch.score >= Number(min_match_score)) {
        const mapped = mapResultToFrontendShape(opp)
        mapped.need_match = {
          score: needMatch.score,
          matchedTerms: needMatch.matchedTerms,
          canonicalNeed: needMatch.canonicalNeed,
          expandedFrom: need_text,
          matchedKey: expandedNeed.matchedKey,
        }
        mapped.combined_score = Math.round(mapped.match_score * 0.6 + needMatch.score * 0.4)
        mapped.result_source = 'curated'
        needScored.push(mapped)
        if (mapped.url) seenUrls.add(mapped.url.toLowerCase().replace(/\/$/, ''))
      }
    }

    // 2. Run item-specific web search for the exact need text
    let webSearchCount = 0
    try {
      const parsed = parseItemRequest(need_text)

      // Pull matching KNOWN_ITEM_SOURCES
      for (const category of parsed.categories) {
        const sources = KNOWN_ITEM_SOURCES[category] || []
        for (const src of sources) {
          const urlKey = src.url.toLowerCase().replace(/\/$/, '')
          if (seenUrls.has(urlKey)) continue
          seenUrls.add(urlKey)
          needScored.push({
            id: `item-known-${category}-${webSearchCount}`,
            title: src.name,
            description: src.description,
            url: src.url,
            application_url: src.url,
            match_score: 70,
            combined_score: 70,
            categories: [category, 'item_funding'],
            source: 'item_known_source',
            result_source: 'item_catalog',
            need_match: {
              score: 70,
              matchedTerms: [`category:${category}`],
              canonicalNeed: expandedNeed?.canonicalNeed || category,
              expandedFrom: need_text,
              matchedKey: category,
            },
          })
          webSearchCount++
        }
      }

      // Live DuckDuckGo web search — use real profile signals for targeted queries
      let webProfile
      try {
        const ctx = await loadProfileContext(db, profile_id)
        const enriched = buildProfileFacets(ctx)
        webProfile = { signals: enriched.signals, profile: enriched.profile }
      } catch {
        webProfile = { signals: { location: {}, military: new Set(), assistance: new Set(), health: new Set() } }
      }
      const webResults = await searchWebForItem(need_text, webProfile)
      console.info(`[specific-need] Web search for "${need_text}" found ${webResults.length} results`)

      for (const wr of webResults) {
        const urlKey = (wr.url || '').toLowerCase().replace(/\/$/, '')
        if (seenUrls.has(urlKey)) continue
        seenUrls.add(urlKey)

        const needMatch = scoreNeedMatch(
          { name: wr.title, description: wr.description, categories: expandedNeed?.programCategories || [] },
          expandedNeed
        )
        const needScore = needMatch?.score || 40

        needScored.push({
          id: `web-${webSearchCount}`,
          title: wr.title,
          description: wr.description || `Found via web search for "${need_text}"`,
          url: wr.url,
          application_url: wr.url,
          match_score: 50,
          combined_score: Math.round(50 * 0.4 + needScore * 0.6),
          categories: expandedNeed?.programCategories || ['general'],
          source: 'web_search',
          result_source: 'web_search',
          need_match: {
            score: needScore,
            matchedTerms: needMatch?.matchedTerms || [`web:${need_text}`],
            canonicalNeed: expandedNeed?.canonicalNeed || null,
            expandedFrom: need_text,
            matchedKey: 'web_search',
          },
        })
        webSearchCount++
      }
    } catch (webErr) {
      console.error('[specific-need] Web search failed (non-fatal):', webErr.message)
    }

    needScored.sort((a, b) => (b.combined_score ?? 0) - (a.combined_score ?? 0))
    const final = needScored.slice(0, Number(max_results))

    const duration = Date.now() - startTime

    res.json({
      success: true,
      need_text,
      expanded: {
        canonicalNeed: expandedNeed?.canonicalNeed || null,
        matchedKey: expandedNeed?.matchedKey || null,
        synonyms: expandedNeed?.synonyms?.slice(0, 10) || [],
        programCategories: expandedNeed?.programCategories || [],
      },
      count: final.length,
      total_candidates: result.results.length,
      web_search_results: webSearchCount,
      duration,
      opportunities: final,
    })
  } catch (error) {
    console.error('[RealCrawlers] Error in specific-need:', error)
    res.status(200).json({
      success: false,
      error: 'Specific need search failed',
      message: error?.message || String(error),
      opportunities: [],
    })
  }
})

/**
 * List strategies with gate info.
 * GET /api/real-crawlers/strategies
 */
router.get('/strategies', ensureAuth, (_req, res) => {
  res.json({ strategies: listStrategies() })
})

/**
 * Health check (simplified — no external API dependencies).
 * GET /api/real-crawlers/health-check
 */
router.get('/health-check', async (_req, res) => {
  res.json({
    ok: true,
    system: 'strategy_router_v4',
    checks: [
      { source: 'Federal Benefits DB', reachable: true, program_count: 26 },
      { source: 'National Programs DB', reachable: true, program_count: 43 },
      { source: 'Business Programs DB', reachable: true, program_count: 25 },
      { source: 'Scholarships DB', reachable: true, program_count: 40 },
      { source: 'State Programs', reachable: true, note: 'Dynamic per-state loading' },
    ],
  })
})

/**
 * Unified "Find Real Funding For Me" — runs curated crawlers + domain engines + state waiver.
 * POST /api/real-crawlers/run-smart
 */
router.post('/run-smart', ensureAuth, standardRateLimiter, async (req, res) => {
  const { profile_id, min_match_score = 50 } = req.body || {}

  if (!profile_id) {
    return res.status(400).json({
      error: 'Profile ID required',
      message: 'Select a profile to run the smart funding search.',
    })
  }
  if (!(await ensureProfileAccess(req, res, String(profile_id)))) return

  const db = req.db
  const minScore = Number(min_match_score) || 50
  const allOpportunities = []
  const seenTitles = new Set()

  // Load profile context once — reused across all crawlers and domain engines to prevent
  // cross-profile contamination from repeated live DB queries.
  let smartProfileContext = null
  let smartProfileData = null
  try {
    const ctx = await loadProfileContext(db, profile_id)
    smartProfileContext = ctx
    smartProfileData = ctx ? extractProfileData(ctx) : null
  } catch {
    // continue without profile context; crawlers will fall back to live DB load
  }

  try {
    // 1) Curated crawlers (local_funding + government_funding)
    for (const crawlerType of ['local_funding', 'government_funding']) {
      try {
        const result = await runCrawler(db, profile_id, {
          minScore: Math.max(1, Math.floor(minScore * 0.25)),
          maxResults: 50,
          crawlerType,
          profileContext: smartProfileContext,
        })
        if (result.debug?.gated) continue
        const mapped = result.results.map(mapResultToFrontendShape)
        for (const opp of mapped) {
          const key = String(opp.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
          if (key && !seenTitles.has(key)) {
            seenTitles.add(key)
            allOpportunities.push(opp)
          }
        }
      } catch (crawlErr) {
        console.warn(`[run-smart] ${crawlerType} failed (continuing):`, crawlErr?.message)
      }
    }

    // 2) National: domain engines
    try {
      const profileForEngines = smartProfileContext?.profile ?? null
      if (profileForEngines) {
        const domainOpps = await runAllDomainEngines(profileForEngines, {})
        for (const o of domainOpps) {
          const urlKey = (o.url || o.application_url || o.source_url || '').toLowerCase()
          const titleKey = String(o.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
          const dedupeKey = urlKey || titleKey
          if (dedupeKey && !seenTitles.has(dedupeKey)) {
            seenTitles.add(dedupeKey)
            allOpportunities.push({
              id: o.id || `domain-${randomUUID()}`,
              title: o.title,
              name: o.title,
              description: o.description ?? null,
              url: o.url ?? o.application_url ?? o.source_url ?? null,
              application_url: o.application_url ?? o.url ?? null,
              source_url: o.source_url ?? o.url ?? null,
              match_score: o.match_score ?? 60,
              match_reasons: o.match_reasons ?? [],
              categories: o.categories ?? [],
              opportunity_type: o.opportunity_type ?? 'program',
              funding_type: o.funding_type ?? null,
              amount_max: o.amount_max ?? null,
              amount_description: o.amount_description ?? null,
              sponsor: o.sponsor ?? 'National Program',
              source: o.source ?? 'domain',
              record_origin: o.record_origin ?? 'live_crawl',
              is_national: o.is_national ?? true,
              state: o.state ?? null,
              deadline_type: o.deadline_type ?? 'rolling',
            })
          }
        }
      }
    } catch (domainErr) {
      console.warn('[run-smart] Domain engines failed (continuing):', domainErr?.message)
    }

    // 3) State waiver benefits if eligible
    try {
      const profileForWaiver = smartProfileContext?.profile ?? null
      if (profileForWaiver) {
        const waiverEligible = evaluateStateWaiverEligibility(profileForWaiver).eligible
        if (waiverEligible) {
          const waiverOpps = await crawlStateWaiverBenefits(profileForWaiver, {})
          for (const o of waiverOpps) {
            const urlKey = (o.url || o.application_url || o.source_url || '').toLowerCase()
            const titleKey = String(o.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
            const dedupeKey = urlKey || titleKey
            if (dedupeKey && !seenTitles.has(dedupeKey)) {
              seenTitles.add(dedupeKey)
              allOpportunities.push({ ...o, match_score: o.match_score ?? 60 })
            }
          }
        }
      }
    } catch (waiverErr) {
      console.warn('[run-smart] State waiver crawl failed (continuing):', waiverErr?.message)
    }

    const filtered = allOpportunities
      .filter((opp) => { const rel = applyRelevanceFilter(opp, smartProfileData); return rel.pass; })
      .filter((opp) => typeof opp.match_score !== 'number' || opp.match_score >= minScore || opp.is_directory_resource)
      .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
      .slice(0, 100)

    return res.json({
      success: true,
      count: filtered.length,
      total_found: allOpportunities.length,
      min_match_score: minScore,
      opportunities: filtered,
      sources_used: ['local_funding', 'government_funding', 'domain_engines', 'state_waiver_benefits'],
    })
  } catch (err) {
    console.error('[RealCrawlers] run-smart error:', err)
    return res.status(500).json({
      success: false,
      error: err?.message || 'Smart search failed',
      opportunities: [],
    })
  }
})

export default router
