import express from 'express'
import { ensureAuth, ensureAdmin } from '../middleware/auth.js'
import { standardRateLimiter } from '../middleware/rateLimiting.js'
import { runProfileDiscoveryLive } from '../services/crawlerOsService.js'
import { ensureProfileAccess } from '../utils/accessControl.js'
import { requireTierCapability, TIER_CAPABILITIES } from '../utils/tierGating.js'
import { expandNeed, scoreNeedMatch } from '../services/shared/needTaxonomy.js'
import { listStrategies } from '../services/legacyCrawlSuperseded.js'
import { loadProfileContext, computeProfileDigest } from '../services/profileHelpers.js'
import { buildProfileFacets } from '../services/profile/profileTaxonomy.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'
import { filterActionableOpportunities } from '../services/opportunityValidationLayer.js'
import {
  assessOpportunityTrust,
  buildTrustMetadata,
} from '../services/opportunityTrust.js'
import { scoreOpportunity } from '../services/matchEngine.js'
import { SCORE_FLOOR, DEFAULT_MIN_SCORE } from '../config/matchThresholds.js'
import { searchLiveFederalByProfile } from '../services/shared/liveFederalSearch.js'
import { searchLocalWebByProfile } from '../services/shared/liveWebSearch.js'
import { ingestOpportunities } from '../services/sources/ingestionService.js'
import { canonicalizeOpportunityList } from '../services/matching/resultEnricher.js'
import {
  detectProfessionalDevelopmentIntent,
  loadCuratedProfessionalDevelopmentPrograms,
  applyProfessionalDevelopmentQueryPolicy,
} from '../services/matching/professionalDevelopmentPolicy.js'
import { planCoverage, buildCoverageReport, buildGrantsGovQueryTerms, getSource, loadCrawlerSourceRuntimeStatus } from '../services/sourceRegistry.js'
import { deriveCoverageOutcomes, summariseOutcomes } from '../services/coverageOutcomes.js'
import { filterOutPipelineMembers, dedupeOpportunityList } from '../services/pipelineExclusion.js'
import { triggerAutoDiscoveryCrawlers, stampLastDiscoveryAt } from '../services/legacyCrawlSuperseded.js'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs'
import { createOpenAIClient } from '../utils/openaiClient.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:realCrawlers')

const router = express.Router()

// Upload dir + OpenAI factory mirror backend/routes/crawlers.js so the
// on-demand discover-all dispatch can pass the same context the login/daily
// auto-discovery paths use to triggerAutoDiscoveryCrawlers.
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const discoverAllUploadDir = join(__dirname, '..', 'uploads')
try {
  if (!fs.existsSync(discoverAllUploadDir)) fs.mkdirSync(discoverAllUploadDir, { recursive: true })
} catch { /* best-effort; dispatcher tolerates a missing uploadDir */ }
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
 * Persist per-source crawler outcomes so missionHealth can answer
 * "did we actually query Grants.gov for this profile, or just plan
 * to?". Best-effort: never throws, never blocks the user response.
 * Schema: see backend/db/migrations/072_crawler_source_runs.sql.
 */
async function persistCoverageOutcomes(db, { crawlerRunId, profileId, crawlerType, outcomes }) {
  if (!db || typeof db.prepare !== 'function') return
  if (!Array.isArray(outcomes) || outcomes.length === 0) return
  const isPg = db?.dialect === 'postgres'
  const sql = isPg
    ? `INSERT INTO crawler_source_runs
        (crawler_run_id, profile_id, crawler_type, source_id, source_label,
         planned, queried, failed, found, directory, duration_ms, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`
    : `INSERT INTO crawler_source_runs
        (crawler_run_id, profile_id, crawler_type, source_id, source_label,
         planned, queried, failed, found, directory, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  // Schema may not exist on older databases (migrations not yet
  // applied); a single try/catch on the first insert tells us to skip
  // the rest of the batch silently.
  let firstFailure = null
  for (const outcome of outcomes) {
    if (!outcome?.source_id) continue
    try {
      const stmt = db.prepare(sql)
      await stmt.run(
        crawlerRunId,
        profileId ?? null,
        crawlerType ?? null,
        outcome.source_id,
        outcome.source_label ?? null,
        isPg ? !!outcome.planned : (outcome.planned ? 1 : 0),
        isPg ? !!outcome.queried : (outcome.queried ? 1 : 0),
        isPg ? !!outcome.failed : (outcome.failed ? 1 : 0),
        Number(outcome.found ?? 0) | 0,
        isPg ? !!outcome.directory : (outcome.directory ? 1 : 0),
        outcome.duration_ms ?? null,
        outcome.error ?? null,
      )
    } catch (err) {
      if (!firstFailure) firstFailure = err
      // If the table is missing the very first insert will fail; abort
      // the rest so we don't spam logs with the same error.
      if (String(err?.message || '').toLowerCase().includes('no such table')) return
      if (String(err?.message || '').toLowerCase().includes('does not exist')) return
    }
  }
  if (firstFailure) throw firstFailure
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
  const filtered = await filterOutPipelineMembers(db, String(profileId), working);
  working = filtered.results;
  try {
    const dd = dedupeOpportunityList(working);
    working = dd.results;
  } catch (err) {
    routeLogger.warn(`[RealCrawlers] result dedup failed (continuing): ${err?.message ?? err}`);
  }
  return working;
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
  'housing_funding',
]

function mapCrawlerOsRow(row) {
  const categories = safeJsonParse(row.categories, [])
  const matchReasons = safeJsonParse(row.match_reasons, [])
  const kind = String(row.opportunity_kind || row.opportunity_type || row.type || '').toUpperCase()
  const isDirectory = kind === 'DIRECTORY'
  return {
    id: row.id,
    opportunity_id: row.id,
    funding_opportunity_id: row.id,
    title: row.title,
    name: row.title,
    sponsor: row.sponsor,
    funder: row.sponsor,
    description: row.description,
    url: row.application_url || row.apply_url || row.source_url || null,
    application_url: row.application_url || row.apply_url || null,
    source_url: row.source_url || row.application_url || row.apply_url || null,
    source: row.source || row.record_origin || 'crawler-os',
    source_id: row.source_id || null,
    record_origin: row.record_origin || 'crawler_os',
    opportunity_type: row.opportunity_type || row.type || row.opportunity_kind || 'program',
    opportunity_kind: row.opportunity_kind || null,
    funding_type: row.funding_type || null,
    deadline: row.deadline || null,
    deadline_type: row.deadline_type || null,
    amount_min: row.amount_min ?? null,
    amount_max: row.amount_max ?? null,
    state: row.state || null,
    is_national: Boolean(row.is_national),
    categories,
    keywords: safeJsonParse(row.keywords, []),
    match_reasons: matchReasons.length > 0 ? matchReasons : ['crawler_os_match'],
    match_score: Number(row.match_score ?? 0),
    match_decision: row.match_decision || 'REVIEW',
    decision: row.match_decision || 'REVIEW',
    match_explanation: row.match_explanation || null,
    match_decision_explanation: row.match_explanation || null,
    match_explain: { why: row.match_explanation || null },
    canonical_opportunity_key: row.canonical_opportunity_key || null,
    fingerprint: row.fingerprint || null,
    is_directory: isDirectory,
    is_directory_resource: isDirectory,
  }
}

async function loadCrawlerOsOpportunities(db, profileId, opts = {}) {
  const minScore = Number.isFinite(Number(opts.minScore))
    ? Math.max(0, Math.min(100, Number(opts.minScore)))
    : DEFAULT_MIN_SCORE
  const limit = Number.isFinite(Number(opts.limit)) ? Math.max(1, Math.min(Number(opts.limit), 250)) : 100
  const includePipeline = opts.includePipeline === true
  const includeAdjacentMatches = opts.includeAdjacentMatches === true
  const profileContext = opts.profileContext || buildProfileFacets(await loadProfileContext(db, String(profileId)))
  const runResult = await runProfileDiscoveryLive({ db, profileId: String(profileId), floor: minScore })
  const isPg = db?.dialect === 'postgres'
  const activeLit = isPg ? 'TRUE' : '1'
  const matcherVersions = includeAdjacentMatches
    ? ['crawler-os', 'crawler-os-xmatch', 'web-llm', 'web_search']
    : ['crawler-os']
  const versionPlaceholders = matcherVersions.map(() => '?').join(', ')
  const rows = await db.prepare(
    `SELECT fo.id, fo.title, fo.sponsor, fo.description, fo.application_url, fo.apply_url,
            fo.source_url, fo.source, fo.source_id, fo.record_origin, fo.opportunity_kind,
            fo.opportunity_type, fo.type, fo.funding_type, fo.deadline, fo.deadline_type,
            fo.amount_min, fo.amount_max, fo.state, fo.is_national, fo.categories, fo.keywords,
            fo.match_reasons, fo.canonical_opportunity_key, fo.fingerprint,
            m.match_score, m.match_decision, m.match_explanation
       FROM profile_opportunity_matches m
       JOIN funding_opportunities fo ON fo.id = m.opportunity_id
      WHERE m.profile_id = ?
        AND m.matcher_version IN (${versionPlaceholders})
        AND (fo.is_active IS NULL OR fo.is_active = ${activeLit})
        AND LOWER(COALESCE(m.match_decision, '')) <> 'reject'
        AND COALESCE(m.match_score, 0) >= ?
      ORDER BY m.match_score DESC
      LIMIT ?`,
  ).all(String(profileId), ...matcherVersions, minScore, limit * 4)

  let opportunities = rows.map(mapCrawlerOsRow)
  const canonical = await canonicalDisplayResults(db, profileContext, String(profileId), opportunities, {
    minScore,
    limit,
    includePipeline,
  })
  opportunities = canonical.opportunities
  return {
    ...runResult,
    opportunities,
    duplicateCount: canonical.duplicateCount,
    dropped: canonical.dropped,
    adjacent_matches_included: includeAdjacentMatches,
  }
}

function pushUniqueTerm(terms, value) {
  const v = String(value || '').trim()
  if (!v) return
  const key = v.toLowerCase()
  if (!terms.some((t) => t.toLowerCase() === key)) terms.push(v)
}

function buildNeedSearchTerms(needText, expandedNeed) {
  const terms = []
  pushUniqueTerm(terms, needText)
  pushUniqueTerm(terms, expandedNeed?.canonicalNeed)
  for (const term of expandedNeed?.mustTerms || []) pushUniqueTerm(terms, term)
  for (const term of (expandedNeed?.synonyms || []).slice(0, 6)) pushUniqueTerm(terms, term)
  for (const term of expandedNeed?.programCategories || []) pushUniqueTerm(terms, term)
  return terms.slice(0, 10)
}

function appendSignalTerms(value, terms) {
  const out = []
  if (value instanceof Set) out.push(...Array.from(value))
  else if (Array.isArray(value)) out.push(...value)
  else if (value) out.push(value)
  for (const term of terms) {
    if (!out.some((v) => String(v).toLowerCase() === String(term).toLowerCase())) out.push(term)
  }
  return out
}

function profileContextWithNeedTerms(profileContext, needTerms) {
  const signals = { ...(profileContext?.signals || {}) }
  signals.needs = appendSignalTerms(signals.needs, needTerms)
  signals.primary_keywords = appendSignalTerms(signals.primary_keywords, needTerms.slice(0, 6))
  signals.focus_areas = appendSignalTerms(signals.focus_areas, needTerms.slice(0, 6))
  return { ...profileContext, signals }
}

async function canonicalDisplayResults(db, profileContext, profileId, opportunities, opts = {}) {
  const minScore = Number.isFinite(Number(opts.minScore)) ? Number(opts.minScore) : DEFAULT_MIN_SCORE
  const limit = Number.isFinite(Number(opts.limit)) ? Math.max(1, Math.min(Number(opts.limit), 250)) : 100
  const { kept, dropped } = canonicalizeOpportunityList(profileContext, opportunities, {
    preserveDirectories: true,
    rejectHardIneligible: true,
  })
  let working = filterActionableOpportunities(kept)
    .filter((opp) => {
      if (opp.is_directory_resource) return true
      return Number(opp.match_score ?? 0) >= minScore
    })
  const beforeDedupe = working.length
  working = dedupeOpportunityList(working).results
  if (opts.includePipeline !== true) {
    working = await excludeExistingPipeline(db, String(profileId), working)
  }
  working = working
    .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
    .slice(0, limit)
  return {
    opportunities: working,
    dropped,
    duplicateCount: beforeDedupe - working.length,
  }
}

function scoreSpecificNeedOpportunity(opp, expandedNeed, needText, minNeedScore) {
  const needMatch = scoreNeedMatch(
    {
      name: opp.title || opp.name,
      description: opp.description,
      categories: Array.isArray(opp.categories) ? opp.categories : safeJsonParse(opp.categories, []),
    },
    expandedNeed,
  )
  const needScore = Number(needMatch?.score ?? 0)
  if (needScore < minNeedScore) return null
  const profileScore = Number(opp.match_score ?? 0)
  const combinedScore = Math.round((profileScore * 0.4) + (needScore * 0.6))
  return {
    ...opp,
    need_match: {
      score: needScore,
      matchedTerms: needMatch?.matchedTerms || [],
      canonicalNeed: needMatch?.canonicalNeed || expandedNeed?.canonicalNeed || null,
      expandedFrom: needText,
      matchedKey: expandedNeed?.matchedKey || null,
    },
    combined_score: combinedScore,
    match_score: Math.max(profileScore, combinedScore),
  }
}

/**
 * Run crawlers for a profile.
 * POST /api/real-crawlers/run
 */
router.post('/run', ensureAuth, async (req, res) => {
  // CUTOVER: discovery + matching is the Crawler OS. This endpoint now runs the
  // OS pipeline for the profile and returns its per-profile matches (the legacy
  // strategy/crawlerManager pipeline is superseded — see legacyCrawlSuperseded.js).
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
    const { run, opportunities: results, duplicateCount } = await loadCrawlerOsOpportunities(db, String(profile_id), {
      minScore: min_match_score,
      limit: 100,
      includeAdjacentMatches: req.body?.include_adjacent_matches === true || req.body?.include_adjacent_matches === '1',
    })
    return res.json({
      success: true, crawler_type, profile_id, engine: 'crawler-os',
      count: results.length, total_found: results.length,
      results, opportunities: results,
      duplicates_removed: duplicateCount,
      sources: run.sources, zero_result: run.zero_result?.reason ?? null,
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

  try {
    const invalid = crawler_types.filter((crawlerType) => !CRAWLER_TYPES.includes(crawlerType))
    if (invalid.length > 0) {
      return res.status(400).json({
        error: 'Invalid crawler type',
        invalid,
        available_crawlers: CRAWLER_TYPES,
      })
    }

    const startAt = Date.now()
    const { run, persisted, opportunities, duplicateCount } = await loadCrawlerOsOpportunities(req.db, String(profile_id), {
      minScore: Number(min_match_score),
      limit: 100,
      includeAdjacentMatches: req.body?.include_adjacent_matches === true || req.body?.include_adjacent_matches === '1',
    })

    return res.json({
      engine: 'crawler-os',
      totalSelected: crawler_types.length,
      succeeded: [{
        crawler: 'crawler-os',
        requested_crawler_types: crawler_types,
        found: opportunities.length,
        inserted: persisted?.opportunities ?? run?.stored ?? 0,
        duration_ms: Date.now() - startAt,
        gated: false,
        gate_reason: null,
      }],
      failed: [],
      totalFound: opportunities.length,
      totalInserted: persisted?.opportunities ?? run?.stored ?? 0,
      duplicates_removed: duplicateCount,
      opportunities,
    })
  } catch (error) {
    routeLogger.error('[RealCrawlers] Error in run-multiple:', error)
    return res.status(500).json({
      engine: 'crawler-os',
      totalSelected: crawler_types.length,
      succeeded: [],
      failed: crawler_types.map((crawlerType) => ({
        crawler: crawlerType,
        error: error?.message || String(error),
        status: 500,
      })),
      totalFound: 0,
      totalInserted: 0,
    })
  }
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

    const needTerms = buildNeedSearchTerms(need_text, expandedNeed)
    const profileContext = await loadProfileContext(db, profile_id)
    const needProfileContext = profileContextWithNeedTerms(profileContext, needTerms)
    const minNeedScore = Math.max(1, Number(min_match_score) || 1)
    const osMinScore = Math.max(SCORE_FLOOR, Math.min(DEFAULT_MIN_SCORE, minNeedScore))

    const [osResult, federalResult, localResult] = await Promise.all([
      loadCrawlerOsOpportunities(db, String(profile_id), {
        minScore: osMinScore,
        limit: Math.max(50, Number(max_results) * 4),
      }).catch((err) => {
        routeLogger.warn(`[specific-need] Crawler OS search failed (continuing): ${err?.message || err}`)
        return { opportunities: [], run: null, persisted: null, duplicateCount: 0 }
      }),
      searchLiveFederalByProfile(needProfileContext, {
        searchTerms: needTerms,
        maxTerms: Math.min(needTerms.length || 1, 8),
        perTermLimit: 10,
        timeoutMs: 7000,
      }).catch((err) => {
        routeLogger.warn(`[specific-need] Federal live search failed (continuing): ${err?.message || err}`)
        return { opportunities: [], debug: { error: err?.message || String(err) } }
      }),
      searchLocalWebByProfile(needProfileContext, {
        maxQueries: 8,
        perQueryCount: 5,
        timeoutMs: 7000,
      }).catch((err) => {
        routeLogger.warn(`[specific-need] Local web search failed (continuing): ${err?.message || err}`)
        return { opportunities: [], debug: { error: err?.message || String(err) } }
      }),
    ])

    scheduleBackgroundIngest(db, federalResult.opportunities, 'specific_need_federal')

    const rawCandidates = [
      ...osResult.opportunities.map((opp) => ({ ...opp, result_source: opp.result_source || 'crawler_os' })),
      ...federalResult.opportunities.map((opp) => ({ ...opp, result_source: opp.result_source || 'live_federal' })),
      ...localResult.opportunities.map((opp) => ({ ...opp, result_source: opp.result_source || 'web_search' })),
    ]

    const canonical = await canonicalDisplayResults(db, needProfileContext, String(profile_id), rawCandidates, {
      minScore: SCORE_FLOOR,
      limit: Math.max(50, Number(max_results) * 5),
    })

    const needScored = []
    for (const opp of canonical.opportunities) {
      const scored = scoreSpecificNeedOpportunity(opp, expandedNeed, need_text, minNeedScore)
      if (scored) needScored.push(scored)
    }
    const final = dedupeOpportunityList(needScored)
      .results
      .sort((a, b) => (b.combined_score ?? b.match_score ?? 0) - (a.combined_score ?? a.match_score ?? 0))
      .slice(0, Number(max_results))

    const duration = Date.now() - startTime

    res.json({
      success: true,
      engine: 'crawler-os',
      need_text,
      expanded: {
        canonicalNeed: expandedNeed?.canonicalNeed || null,
        matchedKey: expandedNeed?.matchedKey || null,
        synonyms: expandedNeed?.synonyms?.slice(0, 10) || [],
        programCategories: expandedNeed?.programCategories || [],
      },
      count: final.length,
      total_candidates: rawCandidates.length,
      web_search_results: localResult.opportunities.length,
      federal_search_results: federalResult.opportunities.length,
      os_results: osResult.opportunities.length,
      duplicates_removed: (osResult.duplicateCount || 0) + (canonical.duplicateCount || 0),
      dropped: canonical.dropped,
      applicant_type: profileContext?.profile?.primary_type || profileContext?.profile?.applicant_type || 'unknown',
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
  res.json({ strategies: listStrategies() })
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
    system: 'strategy_router_v4',
    checks: [
      { source: 'Funding Opportunities Catalog', reachable: true, program_count: activeOpportunityCount },
      { source: 'Trusted Displayable Catalog', reachable: true, program_count: trustedOpportunityCount },
      { source: 'Crawler Strategies', reachable: true, program_count: listStrategies().length },
      { source: 'State Programs', reachable: true, note: 'Dynamic per-state loading' },
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
    min_match_score = DEFAULT_MIN_SCORE,
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
  const minScore = Number(min_match_score) || DEFAULT_MIN_SCORE

  try {
    void stampLastDiscoveryAt(db, profile_id)
    const smartProfileContext = await loadProfileContext(db, profile_id)
    const pdIntent = detectProfessionalDevelopmentIntent({
      searchTerms: need_text ? [String(need_text)] : [],
      freeText: String(need_text || ''),
      profileContext: smartProfileContext,
    })

    const osResult = await loadCrawlerOsOpportunities(db, String(profile_id), {
      minScore,
      limit: 100,
    })
    let working = osResult.opportunities

    if (pdIntent.active) {
      const curated = loadCuratedProfessionalDevelopmentPrograms(smartProfileContext)
      const seen = new Set(working.map((o) => String(o.title || '').toLowerCase()))
      for (const opp of curated) {
        const key = String(opp.title || '').toLowerCase()
        if (!key || seen.has(key)) continue
        seen.add(key)
        working.push({ ...opp, match_score: opp.match_score ?? 72, result_source: 'pd_curated' })
      }
      working = applyProfessionalDevelopmentQueryPolicy(working, pdIntent)
        .filter((opp) => (opp.match_score ?? 0) >= minScore || opp.is_directory_resource)
        .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
        .slice(0, 100)
    }

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
      total_found: osResult.opportunities.length,
      min_match_score: minScore,
      opportunities: decoratedSmart,
      sources_used: ['crawler-os'],
      duplicates_removed: osResult.duplicateCount,
      dispatch_profile_development: pdIntent.active || undefined,
      profile_credentials: smartProfileContext?.signals?.credentials instanceof Set
        ? Array.from(smartProfileContext.signals.credentials)
        : Array.isArray(smartProfileContext?.signals?.credentials) ? smartProfileContext.signals.credentials : [],
      professional_development_intent: pdIntent.active || undefined,
      branded_program: pdIntent.branded?.label || undefined,
    })
  } catch (err) {
    routeLogger.error('[RealCrawlers] run-smart error:', err)
    return res.status(500).json({
      success: false,
      engine: 'crawler-os',
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
