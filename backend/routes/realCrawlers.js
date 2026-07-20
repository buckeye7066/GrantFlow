import express from 'express'
import { ensureAuth, ensureAdmin } from '../middleware/auth.js'
import { standardRateLimiter } from '../middleware/rateLimiting.js'
import {
  runCrawler,
  triggerAutoDiscoveryCrawlers,
  stampLastDiscoveryAt,
  loadCrawlerOsProfileResults,
} from '../services/crawlerOsCompatibility.js'
import { runProfileDiscoveryLive, isWebDiscoveryEnabled } from '../services/crawlerOsService.js'
import { ensureProfileAccess } from '../utils/accessControl.js'
import { requireTierCapability, TIER_CAPABILITIES } from '../utils/tierGating.js'
import { expandNeed, scoreNeedMatch } from '../services/shared/needTaxonomy.js'
import { loadProfileContext, computeProfileDigest } from '../services/profileHelpers.js'
import { buildProfileFacets } from '../services/profile/profileTaxonomy.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'
import { filterActionableOpportunities } from '../services/opportunityValidationLayer.js'
import { applyRelevanceFilter, extractProfileData } from '../services/relevanceFilter.js'
import {
  assessOpportunityTrust,
  buildTrustMetadata,
} from '../services/opportunityTrust.js'
import { scoreOpportunity } from '../services/matchEngine.js'
import { SCORE_FLOOR, DEFAULT_MIN_SCORE } from '../config/matchThresholds.js'
import { resolveRunSmartMinScore } from '../services/discoveryPreferences.js'
import { SURFACED_MATCHER_VERSIONS_SQL } from '../config/matchSurfacing.js'
import { searchNeedWebLeads } from '../services/shared/liveWebSearch.js'
import { ingestOpportunities } from '../services/sources/ingestionService.js'
import { canonicalizeOpportunityList } from '../services/matching/resultEnricher.js'
import {
  detectProfessionalDevelopmentIntent,
  applyProfessionalDevelopmentQueryPolicy,
} from '../services/matching/professionalDevelopmentPolicy.js'
import { allSources as allCrawlerOsSources } from '../crawler-os/sourceRegistry.js'
import { implementedAdapterIds } from '../crawler-os/adapters/index.js'
import { filterOutPipelineMembers, dedupeOpportunityList } from '../services/pipelineExclusion.js'
import { resolveUploadsDir } from '../utils/uploadsDir.js'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { createOpenAIClient } from '../utils/openaiClient.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:realCrawlers')

const router = express.Router()

async function runProfileCrawlerOs(db, profileId, options = {}) {
  const floor = Number.isFinite(Number(options?.minScore)) ? Number(options.minScore) : undefined
  const maxResults = Number(options?.maxResults) || 200
  const { run, persisted } = await runProfileDiscoveryLive({ db, profileId: String(profileId), floor })
  const results = await loadCrawlerOsProfileResults(db, profileId, maxResults)
  return {
    engine: 'crawler-os',
    crawler_type: options?.crawlerType || 'crawler-os',
    inserted: persisted?.opportunities ?? run?.stored ?? results.length,
    evaluated: persisted?.matches ?? results.length,
    total: results.length,
    results,
    sources: run?.sources ?? [],
    rejected: run?.rejected ?? 0,
    pipelinePruned: persisted?.pipelinePruned ?? 0,
    hamiltonCleaned: persisted?.hamiltonCleaned ?? 0,
  }
}

// Upload dir + OpenAI factory mirror backend/routes/crawlers.js so the
// on-demand discover-all dispatch can pass the same context the login/daily
// auto-discovery paths use to triggerAutoDiscoveryCrawlers.
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const { uploadsDir: discoverAllUploadDir } = resolveUploadsDir({ baseDir: __dirname })
function getDiscoverAllOpenAI() {
  try {
    const { openai } = createOpenAIClient({ allowMissing: true })
    return openai
  } catch {
    return null
  }
}

// Server-side time budget for the inline /run crawl. The binding constraint is
// Vercel's edge proxy: `/api/*` is a rewrite to Railway (see vercel.json), and
// Vercel drops a proxied response at ~30s with a 504 long before a full live
// crawl can finish. We bound the ENTIRE handler's wall-clock under one
// gateway-safe deadline so we ALWAYS respond in time — falling back to whatever
// DB-backed/nearby opportunities are already available (or an empty list)
// flagged with `partial: true, timed_out: true`.
//
// CRAWL_TOTAL_BUDGET_MS is the total budget for the whole request (pre-pipeline
// profile/coverage load + pipeline + post-timeout fallback + serialization),
// NOT just the pipeline. Default 26s leaves ~4s headroom under Vercel's 30s cap
// for proxy hops and JSON serialization. `CRAWL_TIME_BUDGET_MS` kept as a
// back-compat alias (HAMILTON-style env override).
const CRAWL_TOTAL_BUDGET_MS =
  Number(process.env.CRAWL_TOTAL_BUDGET_MS) ||
  Number(process.env.CRAWL_TIME_BUDGET_MS) ||
  26000

// Wall-clock reserved at the end of the budget for the post-timeout fallback
// (nearby query + pipeline-exclusion dedup + JSON serialization). Carving this
// out of the pipeline's slice guarantees the fallback itself can't push the
// response past the gateway deadline.
const CRAWL_FALLBACK_RESERVE_MS = Number(process.env.CRAWL_FALLBACK_RESERVE_MS) || 5000

// Sentinel returned when budgeted work overruns its time slice. Distinct object
// identity so the caller can branch without ambiguity vs a real result.
const CRAWL_TIMEOUT = Symbol('crawl-timeout')

/**
 * Race an async work-producing function against a time slice. Resolves to the
 * function's value, or CRAWL_TIMEOUT if the slice elapsed first. Never rejects
 * on timeout — the in-flight work is abandoned (its eventual settlement is
 * ignored) so the request can respond immediately.
 */
async function withCrawlBudget(fn, budgetMs) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(CRAWL_TIMEOUT), Math.max(1, budgetMs))
    if (typeof timer?.unref === 'function') timer.unref()
  })
  try {
    return await Promise.race([Promise.resolve().then(fn), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Milliseconds left until `startTime + total` minus a tail reserve, floored at
 * `floor` so a budgeted call always gets a usable (if small) slice even when
 * the pre-work already ate most of the budget. This is what makes pre-pipeline
 * work (profile/coverage load) count against the gateway deadline instead of
 * being free time on top of the pipeline budget.
 */
function remainingBudget(startTime, { total = CRAWL_TOTAL_BUDGET_MS, reserve = 0, floor = 1500 } = {}) {
  const elapsed = Date.now() - startTime
  return Math.max(floor, total - elapsed - reserve)
}

/**
 * Persist freshly-discovered opportunities to the shared catalog OFF the request
 * path. Catalog writes (ingestion's per-row gates + upserts) must not add
 * latency to — or contend for DB connections with — the user's discovery
 * response (see the discovery-contention history: heavy synchronous writes
 * starved the pool). We defer with setImmediate so it runs after the response
 * is queued, and swallow all errors: a storage failure must never surface to
 * the user or crash the process via an unhandled rejection.
 */
function scheduleBackgroundIngest(db, opportunities, sourceName) {
  if (!db || !Array.isArray(opportunities) || opportunities.length === 0) return
  setImmediate(() => {
    Promise.resolve()
      .then(() => ingestOpportunities(db, opportunities, sourceName))
      .then((res) => {
        const n = res?.inserted ?? 0
        const u = res?.updated ?? 0
        if (n || u) routeLogger.info(`[RealCrawlers] background ingest (${sourceName}): +${n} new, ${u} updated`)
      })
      .catch((err) => routeLogger.warn(`[RealCrawlers] background ingest (${sourceName}) failed: ${err?.message ?? err}`))
  })
}

/**
 * Query funding_opportunities table for the user's state + national opportunities.
 * Returns results mapped to the same frontend shape as curated results.
 * Deduplicates against curated results by title normalization.
 */
export async function queryNearbyOpportunities(db, analysis, curatedTitles, profileContext, limit = 50) {
  if (!db || typeof db.prepare !== 'function') return [];
  const state = analysis?.location?.state;
  try {
    const isPg = db?.dialect === 'postgres'
    // Fetch more rows than requested: curated upserts overlap with curatedTitles and
    // will be deduplicated, so we need headroom to find genuinely new records.
    const sqlLimit = Math.max(limit * 4, 200)

    // Profile isolation — mirrors discovery.js:169 and matching.js. funding_opportunities
    // is a SHARED table: rows are either global catalog (profile_id IS NULL) or tagged to
    // the profile whose crawl produced them. Without this clause, this query returns any
    // OTHER profile's crawl output that happens to share the state/national scope — i.e.
    // "funding sources leaked from a previous search". Restrict to global catalog rows plus
    // THIS profile's own results. When no profile id is resolvable, fall back to global-only
    // (never leak another profile's rows).
    const profileId = profileContext?.profile_id ?? profileContext?.profile?.id ?? null
    const params = [state || 'nationwide']
    let profileClause
    if (profileId) {
      params.push(profileId)
      profileClause = isPg
        ? `AND (profile_id IS NULL OR profile_id = $${params.length})`
        : 'AND (profile_id IS NULL OR profile_id = ?)'
    } else {
      profileClause = 'AND profile_id IS NULL'
    }
    params.push(sqlLimit)
    const statePh = isPg ? '$1' : '?'
    const limitPh = isPg ? `$${params.length}` : '?'
    const activeLit = isPg ? 'TRUE' : '1'
    const nationalLit = isPg ? 'TRUE' : '1'

    const query = `SELECT id, title, description, sponsor, source, source_url, application_url, apply_url,
             state, is_national, opportunity_type, type, deadline_type, amount_max,
             contact_info, categories, keywords, match_reasons,
             funding_type, record_origin, requires_match, match_percentage, is_loan,
             funding_category, usable_for_housing, refund_potential, eligibility_signals, verification_status
         FROM funding_opportunities
         WHERE is_active = ${activeLit} AND (state = ${statePh} OR state = 'nationwide' OR is_national = ${nationalLit})
         ${profileClause}
         AND ${trustedOriginClause()} AND ${trustedSourceClause()}
         ORDER BY last_verified_at DESC NULLS LAST
         LIMIT ${limitPh}`
    const rows = await db.prepare(query).all(...params);

    const normalizeTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const seenTitles = new Set(curatedTitles.map(normalizeTitle));

    return (rows || [])
      .filter(row => {
        const norm = normalizeTitle(row.title);
        if (seenTitles.has(norm)) return false;
        seenTitles.add(norm);
        return true;
      })
      .slice(0, limit)
      .map(row => ({
        id: row.id || `fo-${row.title?.slice(0, 20)}`,
        title: row.title,
        name: row.title,
        description: row.description,
        url: row.application_url || row.apply_url || row.source_url || null,
        application_url: row.application_url || row.apply_url || null,
        source_url: row.source_url || row.application_url || null,
        // Default to the score FLOOR (not 50) when a row can't be scored: a row with
        // no computable relevance must rank last and fall below min_match_score, never
        // masquerade as a median-strength (== DEFAULT_MIN_SCORE) match.
        match_score: profileContext ? (scoreOpportunity(profileContext, row)?.score ?? SCORE_FLOOR) : SCORE_FLOOR,
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
        requires_match: Boolean(row.requires_match),
        match_percentage: row.match_percentage || null,
        is_loan: Boolean(row.is_loan),
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

/**
 * Exclude opportunities already in (or dismissed from) this profile's pipeline,
 * then collapse intra-list duplicates. Delegates to the ONE canonical,
 * profile-scoped helper (backend/services/pipelineExclusion.js) instead of a
 * parallel local filter — so this surface matches discovery/matching on id +
 * fingerprint + normalized title+funder AND honors dismissal tombstones (which
 * the old local id/url/title-only filter ignored). Tolerant: any failure
 * returns the input unchanged so the dedup query NEVER blocks results.
 */
async function excludeExistingPipeline(db, profileId, opportunities) {
  if (!Array.isArray(opportunities) || opportunities.length === 0) return opportunities;
  if (!db || typeof db.prepare !== 'function' || !profileId) return opportunities;
  let working = opportunities;
  try {
    const filtered = await filterOutPipelineMembers(db, String(profileId), working);
    working = filtered.results;
  } catch (err) {
    routeLogger.warn(`[RealCrawlers] pipeline exclusion failed (continuing, no exclusion): ${err?.message ?? err}`);
  }
  try {
    const dd = dedupeOpportunityList(working);
    working = dd.results;
  } catch (err) {
    routeLogger.warn(`[RealCrawlers] result dedup failed (continuing): ${err?.message ?? err}`);
  }
  return working;
}

const CRAWLER_TYPES = [
  'crawler-os',
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
  'housing_funding',
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
  // CUTOVER: discovery + matching is the Crawler OS. Historical crawler_type
  // values are accepted as aliases only; every request uses the OS pipeline.
  const { crawler_type, profile_id, min_match_score: bodyMinScore } = req.body
  let min_match_score = DEFAULT_MIN_SCORE
  if (typeof bodyMinScore === 'number' && bodyMinScore >= 0 && bodyMinScore <= 100) min_match_score = bodyMinScore
  else if (typeof bodyMinScore === 'string' && /^\d+$/.test(bodyMinScore)) min_match_score = Math.min(100, Math.max(0, parseInt(bodyMinScore, 10)))
  if (!crawler_type || !CRAWLER_TYPES.includes(crawler_type)) {
    return res.status(400).json({ error: 'Invalid crawler type', message: `Invalid crawler type: ${crawler_type}`, available_crawlers: CRAWLER_TYPES })
  }
  if (!profile_id) return res.status(400).json({ error: 'Profile ID required', message: 'Crawler runs require a profile_id.' })
  if (!(await ensureProfileAccess(req, res, String(profile_id)))) return
  try {
    const db = req.db
    const { run } = await runProfileDiscoveryLive({ db, profileId: String(profile_id), floor: min_match_score, crawlerType: crawler_type })
    const rows = await db.prepare(
      `SELECT fo.id, fo.title, fo.sponsor, fo.description, fo.application_url, fo.apply_url,
              fo.source_url, fo.opportunity_kind, fo.deadline, fo.amount_min, fo.amount_max, fo.state,
              m.match_score, m.match_decision, m.match_explanation
         FROM profile_opportunity_matches m
         JOIN funding_opportunities fo ON fo.id = m.opportunity_id
        WHERE m.profile_id = ? AND m.matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}
          AND (fo.is_active IS NULL OR fo.is_active = 1)
        ORDER BY m.match_score DESC`,
    ).all(String(profile_id))
    const results = rows.map((r) => ({
      id: r.id, name: r.title, title: r.title, sponsor: r.sponsor, description: r.description,
      url: r.application_url || r.apply_url || r.source_url || null,
      deadline: r.deadline, amount_min: r.amount_min, amount_max: r.amount_max, state: r.state,
      match_score: r.match_score, match_decision: r.match_decision,
      match_explain: { why: r.match_explanation },
      is_directory: String(r.opportunity_kind || '').toUpperCase() === 'DIRECTORY',
    }))
    return res.json({
      success: true, crawler_type, profile_id, engine: 'crawler-os',
      count: results.length, total_found: results.length,
      results, opportunities: results,
      sources: run.sources, zero_result: run.zero_result?.zero_result_reason ?? null,
    })
  } catch (err) {
    routeLogger.error(`[RealCrawlers] run failed for ${profile_id}: ${err?.message || err}`)
    return res.status(500).json({ success: false, error: err?.message || String(err), crawler_type, profile_id })
  }
})


router.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'real-crawlers',
    status: 'healthy',
    endpoints: ['/api/real-crawlers/list', '/api/real-crawlers/health-check'],
  })
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
  const { profile_id, crawler_types, min_match_score = DEFAULT_MIN_SCORE } = req.body

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

        const mapped = filterActionableOpportunities(result.results.map(mapResultToFrontendShape))
        const isDirectory = (opp) => (
          Boolean(opp.is_directory_resource) ||
          String(opp.source || '').startsWith('directory') ||
          String(opp.record_origin || '').startsWith('directory')
        )
        let filtered = mapped
          .filter((opp) => {
            const rel = applyRelevanceFilter(opp, profileData)
            return rel.pass || isDirectory(opp)
          })
          .filter((opp) => typeof opp.match_score === 'number' && (opp.match_score >= Number(min_match_score) || isDirectory(opp)))
          .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
          .slice(0, 50)

        if (filtered.length === 0 && mapped.length > 0) {
          filtered = mapped
            .filter((opp) => {
              const rel = applyRelevanceFilter(opp, profileData, { mode: 'soft' })
              return rel.pass || isDirectory(opp)
            })
            .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
            .slice(0, 50)
        }

        filtered = filtered.flatMap((opp) => {
          const trust = assessOpportunityTrust(opp, { allowDirectory: true, allowExpired: false })
          if (!trust.display) return []
          const meta = buildTrustMetadata(trust) || {}
          return [{ ...opp, ...meta }]
        })

        totalFound += mapped.length
        totalInserted += filtered.length

        succeeded.push({
          crawler: crawlerType,
          found: mapped.length,
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

/**
 * Fire the FULL relevance-gated discovery fleet for a profile, on demand.
 * POST /api/real-crawlers/discover-all
 *
 * Reuses the canonical relevance selector (triggerAutoDiscoveryCrawlers) — the
 * same code path that runs on login + daily — so gating is identical: a
 * corporation never gets student/scholarship crawlers, a student never gets
 * military/fire-department crawlers, foundation_990 only fires for org/nonprofit/
 * business profiles, clinical_trials only when opted in with conditions, etc.
 *
 * Profile-scoped (ensureProfileAccess) — no cross-tenant. Returns the honest
 * enqueued summary { jobs_enqueued, crawler_types } so the UI can report exactly
 * how many relevant crawlers were dispatched (never claims crawlers that didn't
 * run). The jobs themselves run in the BACKGROUND (fire-and-forget); this route
 * returns as soon as they are enqueued + dispatched.
 */
router.post('/discover-all', ensureAuth, async (req, res) => {
  const profileId = req.body?.profile_id

  if (!profileId) {
    return res.status(400).json({
      error: 'Profile ID required',
      message: 'discover-all requires a profile_id.',
    })
  }

  if (!(await ensureProfileAccess(req, res, String(profileId)))) return

  try {
    // Throttle: don't re-dispatch the whole crawler fleet if this profile was
    // crawled very recently. Repeated Discover searches / slider changes would
    // otherwise pile fleet load onto the small Postgres and starve the
    // interactive matcher (→ statement_timeout 503 / 504). The catalog already
    // holds the fresh results; let the client just read them. Honor ?force=1
    // for an explicit re-crawl. Window is configurable.
    const isPg = req.db?.dialect === 'postgres'
    const force = req.query?.force === '1' || req.body?.force === true
    const throttleMin = Number(process.env.DISCOVER_ALL_THROTTLE_MIN) || 10
    if (!force) {
      try {
        const recent = await req.db
          .prepare(
            `SELECT parameters FROM crawler_jobs
              WHERE profile_id = ?
                AND requested_by IN ('auto-discovery','discover-all','scheduled-auto-discovery')
                AND created_at > ${isPg ? `now() - interval '${throttleMin} minutes'` : `datetime('now','-${throttleMin} minutes')`}
              ORDER BY created_at DESC LIMIT 1`,
          )
          .get(String(profileId))
        if (recent) {
          // QUALITY GUARD: only throttle when the recent crawl used the SAME
          // profile snapshot. A profile edit changes the digest → we must
          // re-crawl so results reflect the new inputs (never serve stale
          // matches for changed data). If either digest is unknown we fail OPEN
          // (re-crawl) rather than risk staleness.
          let recentDigest = null
          try {
            const params = typeof recent.parameters === 'string' ? JSON.parse(recent.parameters) : (recent.parameters || {})
            recentDigest = params?._profile_digest ?? null
          } catch { /* unparseable params → treat as unknown digest */ }
          let currentDigest = null
          try { currentDigest = await computeProfileDigest(req.db, String(profileId)) } catch { /* unknown */ }
          if (recentDigest && currentDigest && recentDigest === currentDigest) {
            routeLogger.info(`[RealCrawlers] discover-all throttled for profile ${profileId} (same profile, crawled within ${throttleMin}m)`)
            return res.json({
              success: true,
              profile_id: String(profileId),
              jobs_enqueued: 0,
              crawler_types: [],
              throttled: true,
              reason: 'recently_crawled_same_profile',
            })
          }
        }
      } catch { /* best-effort — if this fails we just proceed to crawl */ }
    }

    const summary = await triggerAutoDiscoveryCrawlers(req.db, String(profileId), {
      uploadDir: discoverAllUploadDir,
      getOpenAI: getDiscoverAllOpenAI,
      requestedBy: 'discover-all',
      trigger: 'on_demand_discover_all',
    })

    routeLogger.info(
      `[RealCrawlers] discover-all enqueued ${summary?.jobs_enqueued ?? 0} jobs for profile ${profileId}: [${(summary?.crawler_types || []).join(', ')}]`,
    )

    return res.json({
      success: true,
      profile_id: String(profileId),
      jobs_enqueued: summary?.jobs_enqueued ?? 0,
      crawler_types: summary?.crawler_types ?? [],
    })
  } catch (error) {
    routeLogger.error('[RealCrawlers] discover-all failed:', error)
    return res.status(500).json({
      success: false,
      error: 'discover-all failed',
      message: error?.message || String(error),
      jobs_enqueued: 0,
      crawler_types: [],
    })
  }
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
// Admin-only: this is a global, un-scoped profile-name lookup (returns matching
// profiles across every tenant), so it must not be reachable anonymously or by a
// regular authenticated user — that would allow cross-tenant profile enumeration
// and profile-ID harvesting for downstream IDOR.
router.get('/find-profile', ensureAdmin, async (req, res) => {
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
 * Item-funding web LEADS: minimum need-match score for a live web hit to be
 * shown, and the cap on how many leads are appended per search. These are NEW
 * constants for the need-keyed web lane only (they do not touch the canonical
 * catalog match thresholds in config/matchThresholds.js). Floor 10 ≈ "at least
 * one need synonym or two need terms appeared in the page title/snippet" —
 * below that a hit is generic web noise, not an item-funding lead.
 */
const WEB_LEAD_MIN_NEED_SCORE = Number(process.env.ITEM_WEB_LEAD_MIN_NEED_SCORE) || 10
const WEB_LEAD_MAX_RESULTS = Number(process.env.ITEM_WEB_LEAD_MAX_RESULTS) || 12

/**
 * Specific need search (the Item Funding page's live search).
 * POST /api/real-crawlers/specific-need
 *
 * Two lanes, merged and honestly labeled:
 *   1. CURATED: this profile's Crawler OS results, re-scored against the need
 *      (result_source='curated'). The live OS crawl is bounded under the
 *      gateway deadline (mirrors /run-smart) — on overrun we re-rank the
 *      already-persisted results instead of 504ing.
 *   2. LIVE WEB LEADS: need-keyed web search (SearXNG/Brave) so a concrete item
 *      ("passenger van", "PROBE ethics class") finds funders the profile-keyed
 *      catalog crawl never fetched (result_source='web_search',
 *      record_origin='web_search'). Leads are display-only: real search hits
 *      with provenance, never ingested into the shared catalog from here, and
 *      never given an application_url (canonical G0: no invented facts).
 *      `variant: 'gift'` biases queries toward donation / in-kind programs.
 */
router.post('/specific-need', ensureAuth, async (req, res) => {
  const { profile_id, need_text, min_match_score = 30, max_results = 20, variant = 'funding' } = req.body

  if (!profile_id) return res.status(400).json({ error: 'profile_id is required' })
  if (!need_text || typeof need_text !== 'string' || need_text.trim().length < 2) {
    return res.status(400).json({ error: 'need_text is required (at least 2 characters)' })
  }

  if (!(await ensureProfileAccess(req, res, String(profile_id)))) return
  // Entitlement: item-funding LIVE SEARCH is gated by the same capability as the
  // item-funding crawler queueing, so the two can't diverge (admins bypass). In
  // the canonical catalog every tier currently includes item funding, so this is
  // a no-op for normal users — but it makes server-side enforcement consistent.
  if (!(await requireTierCapability(req, res, String(profile_id), TIER_CAPABILITIES.ITEM_FUNDING))) return

  try {
    const db = req.db
    const startTime = Date.now()

    // Stamp the per-profile "discovery has run" signal (best-effort, never
    // blocks): a specific-need search is a discovery path for this profile.
    void stampLastDiscoveryAt(db, profile_id)

    const expandedNeed = expandNeed(need_text)
    const needVariant = variant === 'gift' ? 'gift' : 'funding'

    // Profile context, loaded ONCE — drives applicant-type detection and the
    // applicant/geo anchors of the need-keyed web queries. Failure-tolerant:
    // a missing context degrades to need-only web queries.
    let profileContext = null
    try {
      profileContext = await loadProfileContext(db, profile_id)
    } catch {
      profileContext = null
    }

    // 2. Kick off the need-keyed LIVE WEB lane in parallel with the curated
    // pipeline so both fit under the same gateway budget. Failure-tolerant:
    // any error degrades to zero leads, flagged in web_search.error.
    const webLaneEnabled = isWebDiscoveryEnabled()
    const webLanePromise = webLaneEnabled
      ? searchNeedWebLeads({
          needText: need_text,
          expandedNeed,
          profileContext,
          variant: needVariant,
          maxQueries: 5,
          perQueryCount: 6,
          timeoutMs: Math.min(12000, remainingBudget(startTime, { reserve: CRAWL_FALLBACK_RESERVE_MS })),
        }).catch((err) => ({ opportunities: [], debug: { queries: [], raw: 0, error: err?.message ?? String(err) } }))
      : Promise.resolve({ opportunities: [], debug: { queries: [], raw: 0, disabled: true } })

    // 1. Run curated crawler pipeline — bounded under the gateway deadline
    // (mirrors /run-smart). On overrun the abandoned crawl keeps running and
    // persists; we fall back to this profile's already-persisted OS results so
    // the user gets an answer instead of a 504.
    const osOutcome = await withCrawlBudget(
      () => runProfileCrawlerOs(db, profile_id, {
        minScore: 1,
        maxResults: 200,
        crawlerType: 'comprehensive',
      }),
      remainingBudget(startTime, { reserve: CRAWL_FALLBACK_RESERVE_MS }),
    )
    const timedOut = osOutcome === CRAWL_TIMEOUT
    let curatedResults
    if (timedOut) {
      routeLogger.warn(
        `[RealCrawlers] specific-need crawl for ${profile_id} exceeded gateway budget; re-ranking persisted results (crawl continues in background)`,
      )
      curatedResults = await loadCrawlerOsProfileResults(db, profile_id, 200).catch(() => [])
    } else {
      curatedResults = osOutcome.results
    }

    // Re-score all curated results against the specific need
    const needScored = []
    const seenUrls = new Set()
    for (const opp of curatedResults) {
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

    // Collect the live web leads, score each against the SAME expanded need,
    // drop generic noise (below the lead floor), dedupe against curated URLs.
    const webLane = await webLanePromise
    const webLeads = []
    for (const lead of webLane.opportunities ?? []) {
      const urlKey = String(lead.url || '').toLowerCase().replace(/\/$/, '')
      if (urlKey && seenUrls.has(urlKey)) continue
      const needMatch = scoreNeedMatch(
        { name: lead.title, description: lead.description, categories: lead.categories || [] },
        expandedNeed,
      )
      const score = needMatch?.score ?? 0
      if (score < WEB_LEAD_MIN_NEED_SCORE) continue
      if (urlKey) seenUrls.add(urlKey)
      webLeads.push({
        ...lead,
        match_score: score,
        combined_score: score,
        result_source: 'web_search',
        need_match: {
          score,
          matchedTerms: needMatch?.matchedTerms ?? [],
          canonicalNeed: needMatch?.canonicalNeed ?? expandedNeed?.canonicalNeed ?? null,
          expandedFrom: need_text,
          matchedKey: expandedNeed?.matchedKey ?? null,
        },
      })
    }
    webLeads.sort((a, b) => (b.combined_score ?? 0) - (a.combined_score ?? 0))
    const webIncluded = webLeads.slice(0, WEB_LEAD_MAX_RESULTS)

    let detectedApplicantType = 'crawler-os-profile'
    try {
      const enriched = buildProfileFacets(profileContext)
      const types = enriched?.signals?.applicantTypes
      if (Array.isArray(types) && types.length) detectedApplicantType = types.join(',')
    } catch {
      detectedApplicantType = 'crawler-os-profile'
    }

    needScored.sort((a, b) => (b.combined_score ?? 0) - (a.combined_score ?? 0))
    const curatedFinal = needScored.slice(0, Number(max_results))
    // Merge: curated matches + labeled web leads, ranked together by score.
    // Leads carry result_source='web_search' so the UI shows honest provenance.
    const final = [...curatedFinal, ...webIncluded].sort(
      (a, b) => (b.combined_score ?? 0) - (a.combined_score ?? 0),
    )

    const duration = Date.now() - startTime

    res.json({
      success: true,
      engine: 'crawler-os',
      need_text,
      variant: needVariant,
      expanded: {
        canonicalNeed: expandedNeed?.canonicalNeed || null,
        matchedKey: expandedNeed?.matchedKey || null,
        synonyms: expandedNeed?.synonyms?.slice(0, 10) || [],
        programCategories: expandedNeed?.programCategories || [],
      },
      count: final.length,
      total_candidates: curatedResults.length,
      web_search_results: webIncluded.length,
      // Honest web-lane telemetry: the UI can distinguish "searched the web,
      // found nothing" from "web search unavailable/disabled".
      web_search: {
        attempted: webLaneEnabled,
        queries: webLane.debug?.queries ?? [],
        raw_results: webLane.debug?.raw ?? 0,
        error: webLane.debug?.error ?? null,
      },
      partial: timedOut,
      timed_out: timedOut,
      applicant_type: detectedApplicantType,
      duration,
      opportunities: final,
    })
  } catch (error) {
    routeLogger.error('[RealCrawlers] Error in specific-need:', error)
    res.status(500).json({
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
  const adapterIds = new Set(implementedAdapterIds())
  const sources = allCrawlerOsSources().map((source) => ({
    id: source.source_id,
    name: source.name,
    engine: 'crawler-os',
    source_type: source.source_type,
    directory: Boolean(source.directory),
    adapter_present: adapterIds.has(source.source_id),
    trust_tier: source.trust_tier,
    applicant_types: source.applicant_types,
    need_categories: source.need_categories,
  }))
  res.json({
    engine: 'crawler-os',
    strategies: sources,
    sources,
    adapters: [...adapterIds].sort(),
  })
})

/**
 * Health check (simplified — no external API dependencies).
 * GET /api/real-crawlers/health-check
 */
router.get('/health-check', async (req, res) => {
  let activeOpportunityCount = 0
  let trustedOpportunityCount = 0
  try {
    const db = req.db
    if (db && typeof db.prepare === 'function') {
      const activeRow = await db.prepare(
        db.dialect === 'postgres'
          ? 'SELECT COUNT(*)::int AS count FROM funding_opportunities WHERE is_active = TRUE'
          : 'SELECT COUNT(*) AS count FROM funding_opportunities WHERE is_active = 1',
      ).get()
      activeOpportunityCount = Number(activeRow?.count ?? 0)

      const trustedRow = await db.prepare(
        db.dialect === 'postgres'
          ? `SELECT COUNT(*)::int AS count FROM funding_opportunities WHERE is_active = TRUE AND ${trustedOriginClause()} AND ${trustedSourceClause()}`
          : `SELECT COUNT(*) AS count FROM funding_opportunities WHERE is_active = 1 AND ${trustedOriginClause()} AND ${trustedSourceClause()}`,
      ).get()
      trustedOpportunityCount = Number(trustedRow?.count ?? 0)
    }
  } catch (err) {
    routeLogger.warn(`[RealCrawlers] health-check count failed: ${err?.message || String(err)}`)
  }

  res.json({
    ok: true,
    system: 'crawler-os',
    checks: [
      { source: 'Funding Opportunities Catalog', reachable: true, program_count: activeOpportunityCount },
      { source: 'Trusted Displayable Catalog', reachable: true, program_count: trustedOpportunityCount },
      { source: 'Crawler OS Sources', reachable: true, program_count: allCrawlerOsSources().length },
      { source: 'Crawler OS Adapters', reachable: true, program_count: implementedAdapterIds().length },
    ],
  })
})

/**
 * Unified "Find Real Funding For Me" — runs curated crawlers + domain engines + state waiver.
 * POST /api/real-crawlers/run-smart
 */
router.post('/run-smart', ensureAuth, standardRateLimiter, async (req, res) => {
  const {
    profile_id,
    min_match_score,
    primary_category: clientPrimaryCategory = null,
    intent_terms: clientIntentTerms = null,
    need_text = '',
  } = req.body || {}

  if (!profile_id) {
    return res.status(400).json({
      error: 'Profile ID required',
      message: 'Select a profile to run the smart funding search.',
    })
  }
  if (!(await ensureProfileAccess(req, res, String(profile_id)))) return

  const db = req.db
  // Gateway-safe deadline: Vercel drops a proxied /api/* response at ~30s (504).
  // Everything expensive below (the live crawl + open-web LLM lane) must finish
  // — or yield partial — under this budget so the client never sees a 504.
  const startTime = Date.now()
  // Stamp the per-profile "discovery has run" signal (best-effort, never blocks):
  // run-smart is a discovery path for this profile.
  void stampLastDiscoveryAt(db, profile_id)
  // Explicit request min wins (legacy `Number(x) || DEFAULT_MIN_SCORE`
  // semantics); otherwise the profile's STORED discovery preference (the
  // "Minimum match score" slider) is the default, then DEFAULT_MIN_SCORE.
  // The stored preference rides the sanctioned explicit-min path — the
  // DISPLAY floor itself is never lowered here.
  const minScore = await resolveRunSmartMinScore(db, profile_id, min_match_score)
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

  // ── Spec §1 + §5: dispatch professional-development strategies whenever
  // the client's intent OR the profile itself indicates licensed-professional
  // / CE / licensure needs. This is the routing fix that stops run-smart
  // from defaulting to local_funding + government_funding only.
  const profileSignals = smartProfileContext?.signals ?? null
  const profileNeeds = profileSignals?.needs instanceof Set
    ? profileSignals.needs
    : new Set(Array.isArray(profileSignals?.needs) ? profileSignals.needs : [])
  const profileIsLicensedProfessional = Boolean(profileSignals?.isLicensedProfessional)
    || (profileSignals?.credentials instanceof Set && profileSignals.credentials.size > 0)
  const profileHasProfDevNeed =
    profileNeeds.has('professional_development') ||
    profileNeeds.has('continuing_education') ||
    profileNeeds.has('license_reinstatement_support') ||
    profileNeeds.has('professional_remediation_funding') ||
    profileNeeds.has('workforce_reentry_training') ||
    profileNeeds.has('nursing_reentry_support')
  const intentTermsLower = Array.isArray(clientIntentTerms)
    ? clientIntentTerms.map((t) => String(t).toLowerCase())
    : []
  const intentSignalsProfDev =
    String(clientPrimaryCategory || '').toLowerCase() === 'professional_development' ||
    intentTermsLower.some((t) =>
      t.includes('continuing education') ||
      t.includes('professional development') ||
      t.includes('licensure') ||
      t.includes('license reinstatement') ||
      t.includes('cme') ||
      t.includes('ceu') ||
      t.includes('ethics training') ||
      t.includes('boundary training') ||
      t.includes('wioa') ||
      t.includes('workforce development') ||
      t.includes('vocational rehabilitation'),
    )
  const dispatchProfDev = intentSignalsProfDev || profileIsLicensedProfessional || profileHasProfDevNeed

  let sourcesUsed = ['crawler-os']
  try {
    routeLogger.info(`[run-smart] profile=${profile_id} engine=crawler-os dispatchProfDev=${dispatchProfDev} (licensed=${profileIsLicensedProfessional}, profDevNeed=${profileHasProfDevNeed}, intent=${intentSignalsProfDev})`)
    // Bound the live crawl under the gateway deadline. withCrawlBudget races the
    // crawl against the remaining budget and returns CRAWL_TIMEOUT if it overruns
    // — the in-flight crawl is abandoned by the request but keeps running and
    // persists its results, so a follow-up read picks them up. This is what stops
    // the "server took too long to respond" 504 the Discover page surfaced.
    const result = await withCrawlBudget(
      () => runProfileCrawlerOs(db, profile_id, {
        minScore,
        maxResults: 200,
        crawlerType: 'crawler-os',
        profileContext: smartProfileContext,
      }),
      remainingBudget(startTime, { reserve: CRAWL_FALLBACK_RESERVE_MS }),
    )
    if (result === CRAWL_TIMEOUT) {
      routeLogger.warn(`[run-smart] profile=${profile_id} crawl exceeded gateway budget; returning partial (work continues in background)`)
      // Return whatever the crawler-os has already persisted so the user gets
      // results instead of a 504; the abandoned crawl finishes + persists the rest.
      const partial = await loadCrawlerOsProfileResults(db, profile_id, 200).catch(() => [])
      const partialMapped = Array.isArray(partial) ? partial.map(mapResultToFrontendShape) : []
      return res.json({
        success: true,
        engine: 'crawler-os',
        partial: true,
        timed_out: true,
        count: partialMapped.length,
        total_found: partialMapped.length,
        min_match_score: minScore,
        opportunities: partialMapped,
        sources_used: ['crawler-os'],
        message: 'Search is still running in the background — showing results found so far. Check back shortly for more.',
      })
    }
    sourcesUsed = Array.isArray(result?.sources) && result.sources.length
      ? [...new Set(result.sources.map((s) => s?.source_id || s?.id).filter(Boolean))]
      : ['crawler-os']
    const mapped = Array.isArray(result?.results)
      ? result.results.map(mapResultToFrontendShape)
      : []
    for (const opp of mapped) {
      const key = String(opp.url || opp.application_url || opp.title || opp.id || '')
        .toLowerCase()
        .replace(/[^a-z0-9:/._-]+/g, ' ')
        .trim()
      if (key && !seenTitles.has(key)) {
        seenTitles.add(key)
        allOpportunities.push(opp)
      }
    }

    // Spec §3: when professional-development intent is active, exclude
    // generic cash-assistance / means-tested rows so SSI/SNAP/TANF don't
    // pad the result list (the regression case from the original PROBE
    // query). Directory-style or general funding directories survive — they
    // help the user navigate to the right funder.
    const isCashAssistanceOpportunity = (opp) => {
      // Repo policy: `eqeqeq: ['error', 'always']` — spell the nullish
      // check out explicitly so the corruption detector stays happy.
      const stringifyForCashScan = (v) => {
        if (v === null || v === undefined) return ''
        if (Array.isArray(v)) return v.join(' ')
        return String(v)
      }
      const haystack = [
        opp?.title,
        opp?.name,
        opp?.description,
        opp?.categories,
        opp?.funding_category,
        opp?.opportunity_type,
        opp?.type,
      ]
        .map(stringifyForCashScan)
        .join(' ')
        .toLowerCase()
      if (!haystack) return false
      return [
        'supplemental security income',
        'ssi ',
        ' ssi',
        ' ssdi',
        'tanf',
        'snap benefits',
        'food stamps',
        'general assistance',
        'cash assistance',
        'income support',
        'liheap',
        'wic ',
      ].some((kw) => haystack.includes(kw))
    }

    const filtered = filterActionableOpportunities(allOpportunities)
      .filter((opp) => { const rel = applyRelevanceFilter(opp, smartProfileData); return rel.pass; })
      .filter((opp) => {
        if (!dispatchProfDev) return true
        if (opp.is_directory_resource) return true
        return !isCashAssistanceOpportunity(opp)
      })
      .filter((opp) => typeof opp.match_score !== 'number' || opp.match_score >= minScore || opp.is_directory_resource)
      .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
      .slice(0, 100)

    const pdIntent = detectProfessionalDevelopmentIntent({
      searchTerms: need_text ? [String(need_text)] : [],
      freeText: String(need_text || ''),
      profileContext: smartProfileContext,
    })

    let working = filtered
    if (pdIntent.active) {
      // No curated injection here: run-smart must return only profile-specific
      // Crawler OS results. The query policy may narrow/reorder OS rows.
      working = applyProfessionalDevelopmentQueryPolicy(working, pdIntent)
        .filter((opp) => (opp.match_score ?? 0) >= minScore || opp.is_directory_resource)
        .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
        .slice(0, 100)
    }

    // Canonical trust decoration — same vocabulary everywhere.
    const decoratedSmart = working.map((opp) => {
      const trust = assessOpportunityTrust(opp, { allowDirectory: true, allowExpired: false })
      const meta = buildTrustMetadata(trust) || {}
      return {
        ...opp,
        trust_tier: opp.trust_tier ?? meta.trust_tier,
        source_trust: opp.source_trust ?? meta.source_trust,
        trust_flags: opp.trust_flags ?? meta.trust_flags,
        trust_reasons: opp.trust_reasons ?? meta.trust_reasons,
        trust_downgrade: opp.trust_downgrade ?? meta.trust_downgrade,
        trust_downgrade_reason: opp.trust_downgrade_reason ?? meta.trust_downgrade_reason,
        actionable_url: opp.actionable_url ?? meta.actionable_url,
      }
    })

    return res.json({
      success: true,
      engine: 'crawler-os',
      count: decoratedSmart.length,
      total_found: allOpportunities.length,
      min_match_score: minScore,
      opportunities: decoratedSmart,
      sources_used: sourcesUsed,
      dispatch_profile_development: dispatchProfDev,
      profile_credentials: profileSignals?.credentials instanceof Set
        ? Array.from(profileSignals.credentials)
        : Array.isArray(profileSignals?.credentials) ? profileSignals.credentials : [],
      professional_development_intent: pdIntent.active || undefined,
      branded_program: pdIntent.branded?.label || undefined,
    })
  } catch (err) {
    routeLogger.error('[RealCrawlers] run-smart error:', err)
    return res.status(500).json({
      success: false,
      error: err?.message || 'Smart search failed',
      opportunities: [],
    })
  }
})

// ---------------------------------------------------------------------------
// POST /api/real-crawlers/run-housing
// Seed housing-usable funding opportunities (Tennessee, faith-based, talent, stipend, COA).
// Admin or authenticated user. URL validation optional (validateUrls=false skips HEAD checks).
// ---------------------------------------------------------------------------
router.post('/run-housing', ensureAuth, async (req, res) => {
  try {
    const { getDb } = await import('../db/index.js')
    const db = getDb()
    const { runHousingScholarshipCrawler } = await import('../services/housingScholarshipCrawler.js')

    const validateUrls = req.body?.validateUrls !== false
    const onProgress = null

    const summary = await runHousingScholarshipCrawler(db, { validateUrls, onProgress })

    return res.json({
      success: true,
      message: `Housing scholarship crawler complete: ${summary.inserted} inserted, ${summary.skipped} skipped, ${summary.errors} errors`,
      ...summary,
    })
  } catch (err) {
    routeLogger.error('[run-housing] Error:', err?.message || String(err))
    return res.status(500).json({ error: err?.message || 'Housing crawler failed' })
  }
})

export default router
