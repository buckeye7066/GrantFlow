import express from 'express'
import { randomUUID } from 'crypto'
import { ensureAuth, ensureAdmin } from '../middleware/auth.js'
import { standardRateLimiter } from '../middleware/rateLimiting.js'
import { runCrawler, SCHEMA } from '../services/crawlerFramework.js'
import { ensureProfileAccess } from '../utils/accessControl.js'
import { requireTierCapability, TIER_CAPABILITIES } from '../utils/tierGating.js'
import { expandNeed, scoreNeedMatch } from '../services/crawlers/needTaxonomy.js'
import { getStrategy, listStrategies } from '../services/crawlers/strategyRegistry.js'
import { searchWebForItem, KNOWN_ITEM_SOURCES, parseItemRequest } from '../services/crawlers/itemFundingCrawler.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { buildProfileFacets } from '../services/profile/profileTaxonomy.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'
import { filterActionableOpportunities } from '../services/opportunityValidationLayer.js'
import { applyRelevanceFilter, extractProfileData } from '../services/relevanceFilter.js'
import {
  assessOpportunityTrust,
  buildTrustMetadata,
} from '../services/opportunityTrust.js'
import { scoreOpportunity } from '../services/matchEngine.js'
import { canonicalizeOpportunityList } from '../services/matching/resultEnricher.js'
import {
  detectProfessionalDevelopmentIntent,
  loadCuratedProfessionalDevelopmentPrograms,
  applyProfessionalDevelopmentQueryPolicy,
} from '../services/matching/professionalDevelopmentPolicy.js'
import { runAllDomainEngines } from '../services/crawlers/domainEngines/index.js'
import { crawlStateWaiverBenefits, evaluateStateWaiverEligibility } from '../services/crawlers/stateWaiverBenefitsCrawler.js'
import { planCoverage, buildCoverageReport, buildGrantsGovQueryTerms, getSource, loadCrawlerSourceRuntimeStatus } from '../services/sourceRegistry.js'
import { deriveCoverageOutcomes, summariseOutcomes } from '../services/coverageOutcomes.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:realCrawlers')

const router = express.Router()

// Server-side time budget for the inline /run crawl. The gateway (Railway/
// Vercel) drops the request with a 504 well before a full live crawl can
// finish, leaving the client hanging with no response. We race the crawl
// work against this budget so the handler ALWAYS responds in time — falling
// back to whatever DB-backed/nearby opportunities are already available (or
// an empty list) flagged with `partial: true, timed_out: true`.
// HAMILTON-style env override; default 22s sits under a typical 30s gateway cap.
const CRAWL_BUDGET_MS = Number(process.env.CRAWL_TIME_BUDGET_MS) || 22000

// Sentinel returned when the crawl pipeline overruns the time budget. Distinct
// object identity so the caller can branch without ambiguity vs a real result.
const CRAWL_TIMEOUT = Symbol('crawl-timeout')

/**
 * Race an async crawl-producing function against the server-side time budget.
 * Resolves to the function's value, or CRAWL_TIMEOUT if the budget elapsed
 * first. Never rejects on timeout — the in-flight work is abandoned (its
 * eventual settlement is ignored) so the request can respond immediately.
 */
async function withCrawlBudget(fn, budgetMs = CRAWL_BUDGET_MS) {
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
async function queryNearbyOpportunities(db, analysis, curatedTitles, profileContext, limit = 50) {
  if (!db || typeof db.prepare !== 'function') return [];
  const state = analysis?.location?.state;
  try {
    const isPg = db?.dialect === 'postgres'
    // Fetch more rows than requested: curated upserts overlap with curatedTitles and
    // will be deduplicated, so we need headroom to find genuinely new records.
    const sqlLimit = Math.max(limit * 4, 200)
    const query = isPg
      ? `SELECT id, title, description, sponsor, source, source_url, application_url, apply_url,
             state, is_national, opportunity_type, type, deadline_type, amount_max,
             contact_info, categories, keywords, match_reasons,
             funding_type, record_origin, requires_match, match_percentage, is_loan,
             funding_category, usable_for_housing, refund_potential, eligibility_signals, verification_status
         FROM funding_opportunities 
         WHERE is_active = TRUE AND (state = $1 OR state = 'nationwide' OR is_national = TRUE) 
         AND ${trustedOriginClause()} AND ${trustedSourceClause()} 
         ORDER BY last_verified_at DESC NULLS LAST 
         LIMIT $2`
      : `SELECT id, title, description, sponsor, source, source_url, application_url, apply_url,
             state, is_national, opportunity_type, type, deadline_type, amount_max,
             contact_info, categories, keywords, match_reasons,
             funding_type, record_origin, requires_match, match_percentage, is_loan,
             funding_category, usable_for_housing, refund_potential, eligibility_signals, verification_status
         FROM funding_opportunities 
         WHERE is_active = 1 AND (state = ? OR state = 'nationwide' OR is_national = 1) 
         AND ${trustedOriginClause()} AND ${trustedSourceClause()} 
         ORDER BY last_verified_at DESC NULLS LAST 
         LIMIT ?`
    const rows = await db.prepare(query).all(state || 'nationwide', sqlLimit);

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
        match_score: profileContext ? (scoreOpportunity(profileContext, row)?.score ?? 50) : 50,
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
 * BUG 2 fix — exclude opportunities that are already in this profile's
 * pipeline (grants table) so already-added sources don't reappear in a fresh
 * crawl. Matches primarily on funding_opportunity_id; falls back to a
 * normalized title match when ids are absent. Tolerant by design: any failure
 * returns the input unchanged so the dedup query NEVER blocks results.
 */
function normalizeOppTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Normalize a URL to a stable dedup key: drop scheme, querystring, hash, and a
// trailing slash, lowercased. So http(s)://Host/path/?utm=… → host/path.
function normalizeUrlForDedup(u) {
  if (!u || typeof u !== 'string') return null;
  let s = u.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('#')[0].split('?')[0].replace(/\/+$/, '');
  return s || null;
}

async function excludeExistingPipeline(db, profileId, opportunities) {
  if (!Array.isArray(opportunities) || opportunities.length === 0) return opportunities;
  if (!db || typeof db.prepare !== 'function' || !profileId) return opportunities;
  try {
    const existing = await db
      .prepare(
        'SELECT DISTINCT funding_opportunity_id FROM grants WHERE profile_id = ? AND funding_opportunity_id IS NOT NULL',
      )
      .all(profileId);
    const existingIds = new Set((existing || []).map((g) => g.funding_opportunity_id).filter(Boolean));

    // Fallback: also collect titles AND application URLs of grants already in
    // the pipeline. A re-crawled opportunity gets a NEW funding_opportunity_id
    // (and sometimes a reworded title), so id-only dedup misses it — but its
    // URL is stable, making URL the most reliable "same opportunity" key.
    const existingTitles = new Set();
    const existingUrls = new Set();
    try {
      const rows = await db
        .prepare('SELECT title, application_url FROM grants WHERE profile_id = ?')
        .all(profileId);
      for (const row of rows || []) {
        const norm = normalizeOppTitle(row?.title);
        if (norm) existingTitles.add(norm);
        const u = normalizeUrlForDedup(row?.application_url);
        if (u) existingUrls.add(u);
      }
    } catch (titleErr) {
      // Title/URL fallback is best-effort; id-based exclusion still applies.
      routeLogger.warn(`[RealCrawlers] pipeline-dedup title/url lookup failed: ${titleErr?.message ?? titleErr}`);
    }

    if (existingIds.size === 0 && existingTitles.size === 0 && existingUrls.size === 0) return opportunities;

    const before = opportunities.length;
    const deduped = opportunities.filter((opp) => {
      const oppId = opp?.id ?? opp?.funding_opportunity_id ?? null;
      if (oppId !== null && oppId !== undefined && existingIds.has(oppId)) return false;
      const u = normalizeUrlForDedup(opp?.application_url || opp?.url || opp?.source_url);
      if (u && existingUrls.has(u)) return false;
      const norm = normalizeOppTitle(opp?.title || opp?.name);
      if (norm && existingTitles.has(norm)) return false;
      return true;
    });
    if (deduped.length < before) {
      routeLogger.info(
        `[RealCrawlers] pipeline-dedup: ${before} → ${deduped.length} (excluded ${before - deduped.length} already-in-pipeline for profile ${profileId})`,
      );
    }
    return deduped;
  } catch (err) {
    routeLogger.warn(`[RealCrawlers] pipeline-dedup failed (continuing, no exclusion): ${err?.message ?? err}`);
    return opportunities;
  }
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
    strict_min_score: bodyStrictMin,
  } = req.body

  let min_match_score = 50
  if (typeof bodyMinScore === 'number' && bodyMinScore >= 0 && bodyMinScore <= 100) {
    min_match_score = bodyMinScore
  } else if (typeof bodyMinScore === 'string' && /^\d+$/.test(bodyMinScore)) {
    min_match_score = Math.min(100, Math.max(0, parseInt(bodyMinScore, 10)))
  }

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

  const strictMinScore =
    bodyStrictMin === true ||
    bodyStrictMin === 'true' ||
    bodyStrictMin === 1 ||
    bodyStrictMin === '1'

  try {
    const db = req.db
    const startTime = Date.now()

    routeLogger.info(`[RealCrawlers] Running ${crawler_type} for profile ${profile_id}`)

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

    // Mission rule (Phase 4): every crawler run must derive a profile-aware
    // source coverage plan from the canonical SourceRegistry. The plan is
    // attached to the response so the dashboard / Anya can answer "what
    // sources were actually queried for this profile?". Failures are logged
    // but never block the crawl itself (recall over suppression).
    let coveragePlan = null
    let coverageReport = null
    let coverageOutcomes = []
    const crawlerRunId = randomUUID()
    try {
      coveragePlan = planCoverage(profileContext)
      routeLogger.info(
        `[RealCrawlers] coverage plan: ${coveragePlan?.sources_planned?.length ?? 0} sources for profile_type=${coveragePlan?.profile_type ?? 'unknown'}`,
      )
    } catch (planErr) {
      routeLogger.warn(`[RealCrawlers] coverage planning failed: ${planErr?.message ?? planErr}`)
    }

    // Derive non-empty Grants.gov search terms from the profile so the
    // crawler doesn't fall back to the historic empty-keyword query
    // (mission rule, Phase 4).
    let derivedSearchTerms = []
    try {
      derivedSearchTerms = buildGrantsGovQueryTerms(profileContext)
    } catch { /* best-effort */ }

    // BUG 1 fix — run the full crawl pipeline (runCrawler + scoring/filtering/
    // trust assembly) under a server-side time budget so we always respond
    // before the gateway 504s. The pipeline body returns the values the final
    // response needs; on overrun we fall back to DB-backed nearby opportunities.
    const pipeline = async () => {
    const result = await runCrawler(db, profile_id, {
      minScore: Math.max(1, Math.floor(min_match_score * 0.25)),
      maxResults: strategy.maxResults || 100,
      crawlerType: crawler_type,
      profileContext,
      coveragePlan,
      searchTerms: derivedSearchTerms,
    })

    // Mission rule (Goal 9 — explainable, reliable): coverage report
    // must distinguish PLANNED vs QUERIED vs FAILED vs FOUND. The
    // outcomes are derived from the strategy's per-group candidate
    // counts and the actually-displayed opportunities so the UI never
    // claims a source was "queried" when no candidates loaded.
    try {
      coverageOutcomes = deriveCoverageOutcomes({
        coveragePlan,
        runResult: result,
        opportunities: result?.results ?? [],
        errors: result?.debug?.errors ?? [],
      })
      // RC-16: surface last_crawl + failure_status per source from the
      // crawler_source_runs table. Best-effort — falls back to outcome-
      // derived status when the table is empty / missing.
      let runtimeStatus
      try {
        runtimeStatus = await loadCrawlerSourceRuntimeStatus(db)
      } catch {
        runtimeStatus = new Map()
      }
      coverageReport = buildCoverageReport(coveragePlan, coverageOutcomes, { runtimeStatus })
      const summary = summariseOutcomes(coverageOutcomes)
      routeLogger.info(
        `[RealCrawlers] coverage outcomes — queried=${summary.sources_queried}/${summary.sources_total} failed=${summary.sources_failed} direct=${summary.direct_found} directory=${summary.directory_found}`,
      )
      // Persist the per-source outcomes so missionHealth can answer
      // "which sources actually ran for recent crawler runs?". Best-
      // effort — never block the user response on a logging failure.
      try {
        await persistCoverageOutcomes(db, {
          crawlerRunId,
          profileId: profile_id,
          crawlerType: crawler_type,
          outcomes: coverageOutcomes,
        })
      } catch (persistErr) {
        routeLogger.warn(`[RealCrawlers] persist coverage outcomes failed: ${persistErr?.message ?? persistErr}`)
      }
    } catch (outcomeErr) {
      routeLogger.warn(`[RealCrawlers] coverage outcomes failed: ${outcomeErr?.message ?? outcomeErr}`)
      // Fallback: at least surface the plan so the UI can still render
      // planned sources rather than nothing.
      try { coverageReport = buildCoverageReport(coveragePlan, []) } catch { /* swallow */ }
    }

    // If strategy was gated, return early with reason
    if (result.debug?.gated) {
      const duration = Date.now() - startTime
      return {
        __gated: true,
        payload: {
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
        },
      }
    }

    const mapped = result.results.map(mapResultToFrontendShape)

    // Merge "near you" opportunities from funding_opportunities table.
    // IMPORTANT: crawler matchScore is only a retrieval prefilter score.
    // Re-score everything with the canonical decision engine before filtering,
    // displaying, saving, or explaining it.
    const curatedTitles = mapped.map(o => o.title || o.name || '')
    const nearbyOpps = await queryNearbyOpportunities(db, result.analysis, curatedTitles, profileContext, 30)
    const initialMapped = filterActionableOpportunities([...mapped, ...nearbyOpps])

    const canonicalized = canonicalizeOpportunityList(profileContext, initialMapped, {
      preserveDirectories: true,
      trustOptions: { allowDirectory: true, allowExpired: false },
      trustDowngradePenalty: 5,
    })
    const allMapped = canonicalized.kept
    const canonicalDropCounts = canonicalized.dropped

    const _isDirectoryOpp = (opp) => (
      Boolean(opp.is_directory_resource) ||
      String(opp.source || '').startsWith('directory') ||
      String(opp.source || '').includes('local_directory') ||
      String(opp.record_origin || '').startsWith('directory')
    )

    const dropCounts = {
      belowMinScore: 0,
      relevance: 0,
      relevanceByRule: {},
      canonical: canonicalDropCounts,
    }

    // Directories are exempt from the numeric threshold only in the
    // directory-centric crawler type (local_funding) where the caller is
    // explicitly asking for directory resources. In any other crawler type,
    // an explicit min_match_score applies to every item so that competitive
    // threshold requests are honoured (real-crawlers-policy.test.mjs
    // "min_match_score threshold enforced").
    const directoryScoreFloorExempt = crawler_type === 'local_funding'
    let filtered = allMapped
      .filter((opp) => {
        const isDbDirectory = _isDirectoryOpp(opp)
        const exemptFromScoreFloor = isDbDirectory && directoryScoreFloorExempt
        if (!exemptFromScoreFloor) {
          if (typeof opp.match_score !== 'number' || opp.match_score < min_match_score) {
            dropCounts.belowMinScore++
            return false
          }
        }
        const relevance = applyRelevanceFilter(opp, profileData)
        if (!relevance.pass && !isDbDirectory) {
          dropCounts.relevance++
          dropCounts.relevanceByRule[relevance.ruleId || 'unknown'] =
            (dropCounts.relevanceByRule[relevance.ruleId || 'unknown'] || 0) + 1
          routeLogger.info(`[RealCrawlers] Filtered out "${opp.title}" — ${relevance.reason}`)
          return false
        }
        return true
      })
      .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
      .slice(0, (strategy.maxResults || 100) + nearbyOpps.length)

    let thresholdFallbackMessage = null
    // The requested score floor is a ranking preference, not a hard exact-match
    // requirement. If it empties the response, fallback may relax it unless the
    // caller explicitly opts into strict_min_score.
    const scoreFloorForFallback = 0
    if (!strictMinScore && filtered.length === 0 && allMapped.length > 0) {
      // STAGE 1: relax relevance rules (per project rule: "Population /
      // eligibility mismatches must reduce score, not discard results"). If
      // the caller did not explicitly request a score floor, relax scores too.
      let relaxed = allMapped
        .filter((opp) => {
          const isDir = _isDirectoryOpp(opp)
          const relevance = applyRelevanceFilter(opp, profileData, { mode: 'soft' })
          const scoreOk =
            typeof opp.match_score === 'number' && opp.match_score >= scoreFloorForFallback
          // Directories get the same score-floor treatment as the main filter:
          // exempt only for the directory-centric local_funding crawler.
          const isDirExempt = isDir && directoryScoreFloorExempt
          return (relevance.pass || isDir) && (scoreOk || isDirExempt)
        })
        .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
        .slice(0, 50)

      if (relaxed.length > 0) {
        filtered = relaxed
        thresholdFallbackMessage = `No results met the requested ${min_match_score}% floor. Showing best available matches after relaxing soft relevance constraints.`
      } else {
        // STAGE 2: last-resort — drop relevance filter entirely, keep only URL-actionable items.
        // Directories / general funding resources must always survive (user rule).
        // Explicit score floors still apply.
        filtered = allMapped
          .filter((opp) => {
            const url = opp.url || opp.application_url || opp.source_url || ''
            if (!(typeof url === 'string' && url.startsWith('http'))) return false
            // PERMANENT RELEVANCE FLOOR: even when relaxing the score floor, an
            // opportunity must still be relevant to THIS profile (soft relevance
            // pass). Never surface "nothing-to-do-with-the-profile" results just
            // to avoid an empty list. Genuine directory resources are exempt.
            const isDir = _isDirectoryOpp(opp)
            if (!isDir && !applyRelevanceFilter(opp, profileData, { mode: 'soft' }).pass) return false
            return true
          })
          .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
          .slice(0, 25)
        if (filtered.length > 0) {
          thresholdFallbackMessage = `Showing best-available funding sources. Your profile did not match a strict filter — complete more profile fields to improve matches.`
          routeLogger.info(`[RealCrawlers] STAGE-2 relax: ${allMapped.length} candidates → ${filtered.length} returned (dropped relevance rules: ${JSON.stringify(dropCounts.relevanceByRule)})`)
        }
      }
    } else if (strictMinScore && filtered.length === 0 && allMapped.length > 0) {
      // Compute score distribution so frontend can suggest a better threshold
      const rawScores = allMapped
        .map(o => typeof o.match_score === 'number' ? o.match_score : 0)
        .sort((a, b) => b - a)
      const bestScore = rawScores[0] || 0
      // Suggest a threshold that would return at least 5 results (rounded down to nearest 5)
      const suggestedIdx = Math.min(4, rawScores.length - 1)
      const suggestedThreshold = Math.max(5, Math.floor(rawScores[suggestedIdx] / 5) * 5)
      const countAtSuggested = rawScores.filter(s => s >= suggestedThreshold).length
      thresholdFallbackMessage = null // ensure no stale message
      // Attach to response via closure variable
      allMapped._scoreHint = { bestScore, suggestedThreshold, countAtSuggested, totalScored: rawScores.length }
      routeLogger.info(
        `[RealCrawlers] strict min_match_score=${min_match_score} — skipping threshold fallback (${allMapped.length} raw, best=${bestScore}, suggest=${suggestedThreshold})`,
      )
    }

    // Canonical decision was already attached by canonicalizeOpportunityList
    // above. Do NOT re-run makeDecision against the crawler/prefilter
    // match_score — that path inflated weak generic rows. Just ensure
    // every survivor has stable fallback display fields.
    filtered = filtered.map((opp) => ({
      ...opp,
      match_decision: opp.match_decision ?? opp.decision ?? 'REVIEW',
      decision: opp.decision ?? opp.match_decision ?? 'REVIEW',
      match_decision_explanation:
        opp.match_decision_explanation ?? opp.match_explanation ?? null,
    }))

    // Policy enforcement: remove loans, matching-funds, no-URL, and hard-REJECT items.
    // Directory resources survive REJECT unless they are themselves loans/matching-funds.
    const prePolicyCount = filtered.length
    let policyDrops = { noUrl: 0, loan: 0, requiresMatch: 0, reject: 0 }
    filtered = filtered.filter(opp => {
      const effectiveUrl = opp.url || opp.application_url || opp.source_url || ''
      if (!effectiveUrl.startsWith('http')) { policyDrops.noUrl++; return false }

      const oppType = String(opp.opportunity_type || '').toLowerCase()
      if (['loan', 'loan_program', 'microloan'].includes(oppType) || opp.is_loan) { policyDrops.loan++; return false }
      if (opp.requires_match) { policyDrops.requiresMatch++; return false }

      const isDirectoryResource = _isDirectoryOpp(opp)
      if (opp.match_decision === 'REJECT' && !isDirectoryResource) { policyDrops.reject++; return false }
      if (opp.match_decision === 'REJECT' && isDirectoryResource) {
        opp.match_decision = 'REVIEW'
        opp.decision = 'REVIEW'
      }
      return true
    })
    if (prePolicyCount > 0 && filtered.length < prePolicyCount) {
      routeLogger.info(`[RealCrawlers] Policy filter: ${prePolicyCount} → ${filtered.length} (drops=${JSON.stringify(policyDrops)})`)
    }

    // GUARANTEE: if UI will show "Found N", backend must return >= 1 included item
    // whenever allMapped > 0 (user rule). Only empty when truly 0 candidates exist,
    // strict_min_score mode is set, or the caller specified an explicit
    // min_match_score floor that no candidate meets.
    if (filtered.length === 0 && allMapped.length > 0 && !strictMinScore) {
      const lastResort = allMapped
        .filter((opp) => {
          const url = opp.url || opp.application_url || opp.source_url || ''
          if (!(typeof url === 'string' && url.startsWith('http'))) return false
          const oppType = String(opp.opportunity_type || '').toLowerCase()
          if (['loan', 'loan_program', 'microloan'].includes(oppType) || opp.is_loan) return false
          if (opp.requires_match) return false
          // PERMANENT RELEVANCE FLOOR (global): the "always show something" rule
          // must NEVER show an opportunity that is irrelevant to this profile.
          // Returning ZERO relevant results is correct and preferred over
          // surfacing e.g. nursing-in-Texas to a TN forensic-science student.
          // Hard-reject and soft-relevance failures are both excluded; genuine
          // directory resources are exempt.
          const isDir = _isDirectoryOpp(opp)
          if (!isDir) {
            if (opp.match_decision === 'REJECT') return false
            if (!applyRelevanceFilter(opp, profileData, { mode: 'soft' }).pass) return false
          }
          return true
        })
        .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
        .slice(0, 15)
        .map(opp => ({ ...opp, match_decision: 'REVIEW', decision: 'REVIEW', match_decision_explanation: 'Best-effort match (all strict filters relaxed).' }))
      if (lastResort.length > 0) {
        filtered = lastResort
        thresholdFallbackMessage = thresholdFallbackMessage ||
          `Showing best-available funding sources (strict matching relaxed).`
        console.warn(`[RealCrawlers] LAST-RESORT fallback engaged: ${allMapped.length} candidates → ${filtered.length} returned. Drops=${JSON.stringify({...dropCounts, policy: policyDrops})}`)
      }
    }

    const duration = Date.now() - startTime

    // Canonical trust decoration — every returned opportunity carries the same
    // trust_* fields as /api/opportunities and /api/discovery so the frontend
    // and Anya can explain results with one vocabulary.
    const trustDropCounts = {}
    const decorateWithTrust = (opp, trustOpts) => {
      const trust = assessOpportunityTrust(opp, trustOpts)
      const meta = buildTrustMetadata(trust) || {}
      return {
        opp: {
          ...opp,
          trust_tier: opp.trust_tier ?? meta.trust_tier,
          source_trust: opp.source_trust ?? meta.source_trust,
          trust_flags: opp.trust_flags ?? meta.trust_flags,
          trust_reasons: opp.trust_reasons ?? meta.trust_reasons,
          trust_downgrade: opp.trust_downgrade ?? meta.trust_downgrade,
          trust_downgrade_reason: opp.trust_downgrade_reason ?? meta.trust_downgrade_reason,
          actionable_url: opp.actionable_url ?? meta.actionable_url,
        },
        trust,
      }
    }
    let decorated = filtered.flatMap((opp) => {
      const { opp: decoratedOpp, trust } = decorateWithTrust(opp, {
        allowDirectory: true,
        allowExpired: false,
      })
      if (!trust.display) {
        for (const r of trust.reasons || []) {
          trustDropCounts[r] = (trustDropCounts[r] || 0) + 1
        }
        return []
      }
      return [decoratedOpp]
    })
    let trustRelaxed = false
    // Project rule: zero-results is a failure state. If a non-empty candidate
    // pool collapses to zero AFTER trust filtering, relax once (allow expired,
    // accept directories, accept lower trust) so the user always sees something
    // when something exists. Logged for explainability.
    if (decorated.length === 0 && filtered.length > 0 && !strictMinScore) {
      decorated = filtered.flatMap((opp) => {
        const { opp: decoratedOpp, trust } = decorateWithTrust(opp, {
          allowDirectory: true,
          allowExpired: true,
        })
        if (!trust.display && trust.trustTier === 'low') return []
        return [{ ...decoratedOpp, trust_relaxed: true }]
      })
      trustRelaxed = decorated.length > 0
      if (trustRelaxed) {
        routeLogger.info(
          `[RealCrawlers] Trust relax fallback: ${filtered.length} → ${decorated.length} after allowing expired/directory (orig drops=${JSON.stringify(trustDropCounts)})`,
        )
      }
    }
    if (filtered.length > 0 && decorated.length < filtered.length && !trustRelaxed) {
      routeLogger.info(`[RealCrawlers] Trust filter: ${filtered.length} → ${decorated.length} (drops=${JSON.stringify(trustDropCounts)})`)
    }

    routeLogger.info(
      `[RealCrawlers] ${crawler_type}: curated=${result.results.length} nearby=${nearbyOpps.length} allMapped=${allMapped.length} → returned=${decorated.length} (min_score=${min_match_score}, strict=${strictMinScore}) in ${duration}ms`,
    )

    return {
      result,
      decorated,
      allMapped,
      nearbyOpps,
      dropCounts,
      trustDropCounts,
      thresholdFallbackMessage,
      duration,
    }
    } // end pipeline()

    // Race the pipeline against the server-side time budget.
    const pipelineOutcome = await withCrawlBudget(pipeline)

    // BUG 1 fix — budget exceeded: respond with DB-backed nearby opportunities
    // (whatever is already available) flagged partial/timed_out, instead of
    // hanging until the gateway 504s. Best-effort; never throws.
    if (pipelineOutcome === CRAWL_TIMEOUT) {
      const duration = Date.now() - startTime
      routeLogger.warn(
        `[RealCrawlers] ${crawler_type} for profile ${profile_id} exceeded crawl budget ${CRAWL_BUDGET_MS}ms — responding with partial DB-backed results`,
      )
      let partialOpps = []
      try {
        partialOpps = await queryNearbyOpportunities(db, { location: { state: profileContext?.profile?.state || profileContext?.signals?.location?.state } }, [], profileContext, 30)
      } catch (partialErr) {
        routeLogger.warn(`[RealCrawlers] partial nearby query failed: ${partialErr?.message ?? partialErr}`)
        partialOpps = []
      }
      // Apply the same dedup against the profile's existing pipeline (BUG 2)
      // so timed-out responses don't resurface already-added sources.
      partialOpps = await excludeExistingPipeline(db, profile_id, partialOpps)
      return res.json({
        success: true,
        partial: true,
        timed_out: true,
        message: `Search is taking longer than expected; showing funding sources already available for your area. Run again shortly for the full results.`,
        crawler_type,
        count: partialOpps.length,
        total_found: partialOpps.length,
        filtered_count: partialOpps.length,
        min_match_score,
        duration,
        opportunities: partialOpps,
        coverage_plan: coveragePlan,
        coverage_report: coverageReport,
        used_live: false,
        used_db_fallback: true,
        used_curated: false,
      })
    }

    // Gated strategy short-circuit (the pipeline returns a payload to send as-is).
    if (pipelineOutcome?.__gated) {
      return res.json(pipelineOutcome.payload)
    }

    let {
      result,
      decorated,
      allMapped,
      nearbyOpps,
      dropCounts,
      trustDropCounts,
      thresholdFallbackMessage,
      duration,
    } = pipelineOutcome

    // BUG 2 fix — exclude opportunities already in this profile's pipeline
    // (grants table) so already-added sources don't reappear. Tolerant:
    // never blocks results on the dedup query.
    decorated = await excludeExistingPipeline(db, profile_id, decorated)

    // Profile-aware policy (lead-engineer decision): the crawlers now use the
    // full profile (profile-derived source plan + search terms + relevance +
    // canonical eligibility decision), so an empty result after relevance gating
    // is an HONEST "no strong match for this profile" — not a failure to paper
    // over. The old "always return ≥1" rule predates profile-aware matching and
    // was surfacing irrelevant filler (e.g. nursing-in-Texas to a TN
    // forensic-science student). We now return zero with a helpful empty-state
    // message rather than mismatched results.
    const relevanceSuppressed = decorated.length === 0 && allMapped.length > 0
    const emptyStateMessage = relevanceSuppressed
      ? `Found ${allMapped.length} candidate funding source(s), but none were a strong match for this profile, so none were added. Add more profile detail (needs, location, eligibility) or broaden the search to surface more.`
      : null

    res.json({
      success: true,
      crawler_type,
      count: decorated.length,
      relevance_suppressed: relevanceSuppressed,
      message: emptyStateMessage,
      // total_found reflects candidates entering the filter pipeline (post-map+merge)
      // so the 1:1 invariant holds: total_found === allMapped.length, and
      // count is what passed filters. Legacy `curated_count` preserves old value.
      total_found: allMapped.length,
      curated_count: result.results.length,
      nearby_count: nearbyOpps.length,
      filtered_count: decorated.length,
      drop_counts: dropCounts,
      trust_drop_counts: trustDropCounts,
      min_match_score,
      duration,
      opportunities: decorated,
      score_hint: allMapped._scoreHint || null,
      threshold_fallback_message: thresholdFallbackMessage || null,
      used_live: false,
      used_db_fallback: false,
      used_curated: true,
      // Phase 4 mission rule: every crawler run reports its profile-aware
      // source plan so admins / Anya / CI can answer "did we even query a
      // relevant source for this profile?". The flat `source_labels` map
      // lets the UI render human names (Goal 7 — clear discovery UI) without
      // round-tripping the registry.
      coverage_plan: coveragePlan,
      coverage_report: coverageReport,
      coverage_outcomes: coverageOutcomes,
      coverage_summary: summariseOutcomes(coverageOutcomes),
      source_labels: (() => {
        const ids = new Set([
          ...(coveragePlan?.sources_planned ?? []),
          ...(coverageReport?.sources_required ?? []),
          ...(coverageReport?.sources_queried ?? []),
          ...(coverageReport?.coverage_gaps ?? []),
          ...(coverageOutcomes ?? []).map((o) => o.source_id).filter(Boolean),
        ])
        const out = {}
        for (const id of ids) {
          const src = getSource(id)
          if (src) {
            out[id] = { label: src.label, directory: !!src.directory, trust: src.trust ?? null }
          } else if (typeof id === 'string' && id.startsWith('curated_')) {
            // Synthetic id for a strategy candidate group not yet
            // mapped to a SourceRegistry id. Render it sensibly so the
            // UI doesn't show a snake_case blob to the user.
            const human = id.replace(/^curated_/, '').replace(/_/g, ' ')
            out[id] = {
              label: `Curated ${human} dataset`,
              directory: false,
              trust: 'curated',
            }
          }
        }
        return out
      })(),
      debug: {
        strategy: result.debug?.strategy || crawler_type,
        intents: result.debug?.intents || [],
        candidateCounts: result.debug?.candidateCounts || {},
        totalCandidates: result.debug?.totalCandidates || 0,
        matchedCount: result.debug?.matchedCount || 0,
        demotedForUrl: result.debug?.demotedForUrl || 0,
        matchStats: result.debug?.matchStats || {},
        canonicalDrops: dropCounts.canonical,
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
    routeLogger.error(`[RealCrawlers] Error in ${crawler_type}:`, error)
    res.status(500).json({
      success: false,
      error: 'Crawler execution failed',
      message: error?.message || String(error),
      crawler_type,
      min_match_score,
      opportunities: [],
    })
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
    let detectedApplicantType = 'unknown'
    try {
      // Build the requesting profile's signals ONCE so both the known-source
      // category pick AND the live web search reflect WHO is asking (applicant
      // type, mission, location), not just the literal need text.
      let webProfile
      try {
        const ctx = await loadProfileContext(db, profile_id)
        const enriched = buildProfileFacets(ctx)
        webProfile = { signals: enriched.signals, profile: enriched.profile }
      } catch {
        webProfile = { signals: { location: {}, military: new Set(), assistance: new Set(), health: new Set() } }
      }

      const parsed = parseItemRequest(need_text, webProfile.signals)
      detectedApplicantType = parsed.applicantType || 'unknown'

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

      // Live DuckDuckGo web search — uses the same profile signals built above
      // so queries are applicant-type / mission / location aware.
      const webResults = await searchWebForItem(need_text, webProfile)
      routeLogger.info(`[specific-need] Web search for "${need_text}" found ${webResults.length} results`)

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
    min_match_score = 50,
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

  // Base crawler set (existing behavior).
  const crawlerTypes = ['local_funding', 'government_funding']
  if (dispatchProfDev) {
    crawlerTypes.push('license_reinstatement', 'certification_training')
  }

  try {
    routeLogger.info(`[run-smart] profile=${profile_id} crawlerTypes=${JSON.stringify(crawlerTypes)} dispatchProfDev=${dispatchProfDev} (licensed=${profileIsLicensedProfessional}, profDevNeed=${profileHasProfDevNeed}, intent=${intentSignalsProfDev})`)
    for (const crawlerType of crawlerTypes) {
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
      const profileState = smartProfileContext?.profile?.state || smartProfileContext?.signals?.location?.state
      const curated = loadCuratedProfessionalDevelopmentPrograms(profileState)
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
      count: decoratedSmart.length,
      total_found: allOpportunities.length,
      min_match_score: minScore,
      opportunities: decoratedSmart,
      sources_used: [...crawlerTypes, 'domain_engines', 'state_waiver_benefits'],
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
