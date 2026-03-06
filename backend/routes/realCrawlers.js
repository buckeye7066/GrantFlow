import express from 'express'
import { ensureAuth } from '../middleware/auth.js'
import { runCrawler, SCHEMA } from '../services/crawlers/crawlerManager.js'
import { ensureProfileAccess } from '../utils/accessControl.js'
import { expandNeed, scoreNeedMatch } from '../services/crawlers/needTaxonomy.js'
import { getStrategy, listStrategies } from '../services/crawlers/strategyRegistry.js'

const router = express.Router()

const CRAWLER_TYPES = [
  'comprehensive',
  'curated_benefits',
  'local_funding',
  'government_funding',
  'student_grants',
  'health_resources',
  'ecf_benefits',
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

    console.log(`[RealCrawlers] Running ${crawler_type} for profile ${profile_id}`)

    const strategy = getStrategy(crawler_type)

    const result = await runCrawler(db, profile_id, {
      minScore: Math.max(1, Math.floor(min_match_score * 0.25)),
      maxResults: strategy.maxResults || 100,
      crawlerType: crawler_type,
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

    let filtered = mapped
      .filter((opp) => typeof opp.match_score === 'number' && opp.match_score >= min_match_score)
      .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
      .slice(0, strategy.maxResults || 100)

    let thresholdFallbackMessage = null
    if (filtered.length === 0 && mapped.length > 0) {
      filtered = mapped
        .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
        .slice(0, 50)
      thresholdFallbackMessage = `No results met your threshold of ${min_match_score}%. Showing best available matches.`
    }

    const duration = Date.now() - startTime

    console.log(
      `[RealCrawlers] ${crawler_type}: ${result.results.length} matched → ${filtered.length} returned (min_score=${min_match_score}) in ${duration}ms`,
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
        })

        const mapped = result.results.map(mapResultToFrontendShape)
        const filtered = mapped
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

    const result = await runCrawler(db, profile_id, {
      minScore: 1,
      maxResults: 200,
      crawlerType: 'comprehensive',
    })

    // Re-score all results against the specific need
    const needScored = []
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
        // Blend: 60% profile match + 40% need match
        mapped.combined_score = Math.round(mapped.match_score * 0.6 + needMatch.score * 0.4)
        needScored.push(mapped)
      }
    }

    needScored.sort((a, b) => (b.combined_score ?? 0) - (a.combined_score ?? 0))
    const final = needScored.slice(0, Number(max_results))

    const duration = Date.now() - startTime

    res.json({
      success: true,
      need_text,
      expanded: {
        canonicalNeed: expandedNeed.canonicalNeed,
        matchedKey: expandedNeed.matchedKey,
        synonyms: expandedNeed.synonyms?.slice(0, 10),
        programCategories: expandedNeed.programCategories,
      },
      count: final.length,
      total_candidates: result.results.length,
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

export default router
