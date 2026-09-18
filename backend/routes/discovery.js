import { resolveApplicationUrl } from '../../shared/applicationTarget.js'

import express from 'express';
import { ensureProfileAccess, isAdminUserWithDb, requireAuthenticatedUser } from '../utils/accessControl.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'
import { DEFAULT_MIN_SCORE } from '../config/matchThresholds.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { buildProfileFacets } from '../services/profile/profileTaxonomy.js'
import { deduplicateOpportunities, decorateOpportunityFreshness } from '../services/opportunityMatcher.js'
import { filterOutPipelineMembers } from '../services/pipelineExclusion.js'
import { assessOpportunityTrust } from '../services/opportunityTrust.js'
import { assembleFundingResults } from '../services/zeroResultLadder.js'
import { canonicalizeOpportunityList, isFiniteNumberLike } from '../services/matching/resultEnricher.js'
import { tallyDisplayRefusals, buildRemovalLedger } from '../services/matching/removalLedger.js'
import { loadVnextGuidanceByOpportunity } from '../services/matching/vnextApplicationGuidance.js'
import { SURFACED_MATCHER_VERSIONS_SQL, qualifiesForDisplay } from '../config/matchSurfacing.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:discovery')

const router = express.Router();

// Discovery endpoints can reference stored profiles; require auth globally.
router.use((req, res, next) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  return next()
})

function parseJsonArray(value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function normalizeSearchTerms(...sources) {
  const terms = []
  for (const source of sources) {
    const values = Array.isArray(source) ? source : [source]
    for (const value of values) {
      const text = String(value ?? '').trim().toLowerCase()
      if (!text) continue
      for (const part of text.split(/[,\n;|]+/)) {
        const term = part.trim()
        if (term && term.length >= 2) terms.push(term)
      }
    }
  }
  return [...new Set(terms)].slice(0, 20)
}

function searchableOpportunityText(opp) {
  return [
    opp?.title,
    opp?.program_name,
    opp?.sponsor,
    opp?.funder,
    opp?.description,
    opp?.summary,
    opp?.eligibility_bullets,
    opp?.keywords,
    opp?.categories,
    opp?.source,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function formatProfileSearchResult(opp) {
  const freshness = decorateOpportunityFreshness(opp)
  return {
    ...opp,
    id: opp.id,
    source_id: opp.source_id ?? null,
    title: opp.title || opp.program_name,
    program_name: opp.program_name || opp.title,
    sponsor: opp.sponsor || opp.funder,
    funder: opp.funder || opp.sponsor,
    url: resolveApplicationUrl(opp) || opp.url || opp.actionable_url || opp.source_url || null,
    application_url: resolveApplicationUrl(opp),
    deadline: opp.deadline,
    award_min: opp.amount_min ?? opp.award_min ?? null,
    award_max: opp.amount_max ?? opp.award_max ?? null,
    amount_min: opp.amount_min ?? opp.award_min ?? null,
    amount_max: opp.amount_max ?? opp.award_max ?? null,
    description: opp.description || opp.summary,
    state: opp.state,
    source: opp.source || 'crawler-os',
    eligibility: opp.eligibility_bullets,
    match: Number(opp.match_score ?? opp.fit_score ?? 0),
    fit_score: Number(opp.match_score ?? opp.fit_score ?? 0),
    match_score: Number(opp.match_score ?? opp.fit_score ?? 0),
    updated_at: opp.updated_at ?? null,
    created_at: opp.created_at ?? null,
    freshness: opp.freshness ?? freshness.freshness,
    days_since_verified: opp.days_since_verified ?? freshness.days_since_verified,
    freshness_warning: opp.freshness_warning ?? freshness.freshness_warning,
    engine: 'crawler-os',
  }
}

/**
 * The ONE selector for "what does this profile see". Both discovery entry
 * points (GET /discover-grants and POST /comprehensiveMatch) read the
 * profile's PERSISTED canonical matches through this function so there is a
 * single funnel: surfaced lanes → canonical funnel → display gate → G2 recovery
 * ladder → four-truth boundary → dedupe → pipeline exclusion. Every removal is
 * counted by reason into `ledger` (canonical_rules G2: an evaluated candidate
 * that is not shown must be accounted for, never silently dropped).
 */
async function selectProfileOsResults(req, profileId, {
  minScore = DEFAULT_MIN_SCORE,
  includePipeline = false,
  filters = {},
  searchTerms = [],
} = {}) {
  const baseContext = await loadProfileContext(req.db, profileId)
  const profileContext = buildProfileFacets(baseContext)
  const isPostgres = req.db?.dialect === 'postgres'
  const activeClause = isPostgres
    ? '(o.is_active IS NULL OR o.is_active = TRUE)'
    : '(o.is_active IS NULL OR o.is_active = 1)'
  const hiddenClause = isPostgres
    ? '(o.is_hidden IS NULL OR o.is_hidden = FALSE)'
    : '(o.is_hidden IS NULL OR o.is_hidden = 0)'

  const osRows = await req.db
    .prepare(
      `SELECT o.*, m.match_score AS os_match_score, m.match_confidence AS os_match_confidence,
              m.match_explain_json AS os_match_explain_json, m.match_decision AS os_match_decision,
              m.match_explanation AS os_match_explanation, m.match_reasons AS os_match_reasons
         FROM profile_opportunity_matches m
         JOIN funding_opportunities o ON o.id = m.opportunity_id
        WHERE m.profile_id = ? AND m.matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}
          AND ${activeClause}
          AND ${hiddenClause}
        ORDER BY m.match_score DESC`,
    )
    .all(profileId)
  const loadedCount = osRows.length

  const vnextGuidance = await loadVnextGuidanceByOpportunity(
    req.db,
    profileId,
    osRows.map((row) => row.id),
    { userId: req.ctx?.userId ?? req.user?.userId ?? null, isAdmin: Boolean(req.ctx?.isAdmin) },
  )
  let mapped = osRows.map((o) => {
    const kind = String(o.opportunity_kind ?? '').toUpperCase()
    const isDirectory = kind === 'DIRECTORY' || kind === 'PAST_AWARD_INTEL'
    return {
      ...o,
      ...vnextGuidance.get(String(o.id)),
      match_score: Number(o.os_match_score ?? 0),
      match_confidence: isFiniteNumberLike(o.os_match_confidence) ? Number(o.os_match_confidence) : null,
      match_explain_json: o.os_match_explain_json,
      match_decision: o.os_match_decision,
      match_explanation: o.os_match_explanation,
      match_reasons: parseJsonArray(o.os_match_reasons),
      is_directory: isDirectory,
      trust_tier: o.source_trust_tier ?? o.trust_tier ?? null,
      url: resolveApplicationUrl(o) ?? o.source_url ?? null,
      actionable_url: resolveApplicationUrl(o) ?? o.source_url ?? null,
      application_url: resolveApplicationUrl(o),
      engine: 'crawler-os',
    }
  })

  // Preserve a copy of the PRE-canonicalized pool for Tier B recovery.
  const rawMapped = Array.isArray(mapped) ? mapped.slice() : []

  const canonical = canonicalizeOpportunityList(profileContext, mapped, {
    preserveDirectories: true,
    rejectHardIneligible: true,
  })
  mapped = canonical.kept

  const beforeFilters = mapped.length
  const normalizedTerms = normalizeSearchTerms(searchTerms)
  if (normalizedTerms.length > 0) {
    mapped = mapped.filter((opp) => {
      const haystack = searchableOpportunityText(opp)
      return normalizedTerms.some((term) => haystack.includes(term))
    })
  }

  if (filters?.state) {
    const state = String(filters.state).trim().toUpperCase()
    if (state) {
      mapped = mapped.filter((opp) => {
        const oppState = String(opp.state ?? '').trim().toUpperCase()
        return !oppState || oppState === state || oppState === 'NATIONWIDE'
      })
    }
  }
  if (filters?.min_award) {
    const min = Number(filters.min_award)
    if (Number.isFinite(min)) mapped = mapped.filter((opp) => opp.amount_max === null || opp.amount_max === undefined || Number(opp.amount_max) >= min)
  }
  if (filters?.max_award) {
    const max = Number(filters.max_award)
    if (Number.isFinite(max)) mapped = mapped.filter((opp) => opp.amount_min === null || opp.amount_min === undefined || Number(opp.amount_min) <= max)
  }
  const filterRemoved = beforeFilters - mapped.length

  const preScoreCount = mapped.length
  const displayRefused = tallyDisplayRefusals(mapped, minScore)
  let qualified = mapped.filter((opp) => qualifiesForDisplay(opp, minScore))
  let relaxation = null

  // Mission rule: total_found > 0 with included === 0 must log, relax, re-score.
  // Implement both Tier A (score relaxation) and Tier B (soft canonicalization)
  // so Discover mirrors matching.js behavior.
  if (qualified.length === 0 && (preScoreCount > 0 || rawMapped.length > 0)) {
    const toLadderInput = (list) =>
      (Array.isArray(list) ? list : []).map((o) => ({
        ...o,
        kind: o.is_directory ? 'directory' : o.kind || 'direct',
        match_score: o.match_score ?? o.os_match_score,
      }))

    let recovered = []
    let ladder = null

    // Tier A — candidates survived canonicalization but scored below the floor.
    if (preScoreCount > 0) {
      ladder = assembleFundingResults(toLadderInput(mapped), {
        minScore,
        maxResults: 100,
        strictMinScore: false,
      })
      recovered = Array.isArray(ladder.opportunities) ? ladder.opportunities : []
    }

    // Tier B — canonicalization removed EVERYTHING; re-canonicalize softly and
    // allow eligible rows + directories to survive as reviewable results.
    if (recovered.length === 0 && rawMapped.length > 0) {
      const soft = canonicalizeOpportunityList(profileContext, rawMapped, {
        preserveDirectories: true,
        rejectHardIneligible: false,
        profileGateMode: 'fallback',
        allowUnmatchedDirectoryFallback: true,
      })
      const softKept = (soft.kept || []).filter(
        (o) => String(o.match_decision || '').toUpperCase() !== 'REJECT' && o.eligible !== false,
      )
      if (softKept.length > 0) {
        ladder = assembleFundingResults(toLadderInput(softKept), {
          minScore,
          maxResults: 100,
          strictMinScore: false,
        })
        recovered = Array.isArray(ladder.opportunities) ? ladder.opportunities : []
      }
    }

    if (recovered.length > 0) {
      qualified = recovered
      relaxation = {
        applied: true,
        tier: ladder?.tier,
        threshold_relaxed: Boolean(ladder?.threshold_relaxed),
        threshold_relaxed_reason: ladder?.threshold_relaxed_reason || null,
        directory_only: Boolean(ladder?.directory_only),
        geo_expanded: Boolean(ladder?.geo_expanded),
        requested_min_score: minScore,
        recovered_count: recovered.length,
        tier_attempts: ladder?.tier_attempts || [],
      }
      routeLogger.info(
        `[discover] zero-result recovery for profile ${profileId}: ` +
          `pre_score=${preScoreCount} raw_candidates=${rawMapped.length} dropped=${JSON.stringify(canonical.dropped || {})} ` +
          `-> recovered=${recovered.length} tier=${ladder?.tier}`,
      )
    } else {
      routeLogger.warn(
        `[discover] suppression for profile ${profileId}: ${Math.max(preScoreCount, rawMapped.length)} candidate(s) ` +
          `but 0 included after score floor ${minScore}. dropped=${JSON.stringify(canonical.dropped || {})}`,
      )
    }
  }
  const readmitted = relaxation ? qualified.length : 0

  // Final owner-facing boundary: recovery may widen search, never the four
  // funding truths. Pointers remain research leads; direct rows must still
  // satisfy the same persisted proof policy as the primary path.
  const beforeTruthBoundary = qualified.length
  qualified = qualified.filter(
    (o) =>
      qualifiesForDisplay(o, minScore) &&
      o.eligible !== false &&
      o.eligibility_relaxed !== true,
  )
  const truthBoundaryRemoved = beforeTruthBoundary - qualified.length

  const beforeDedupe = qualified.length
  mapped = deduplicateOpportunities(qualified).map(formatProfileSearchResult)
  const dedupeRemoved = beforeDedupe - mapped.length

  let excludedAlreadyInPipeline = 0
  if (!includePipeline) {
    const filtered = await filterOutPipelineMembers(req.db, profileId, mapped)
    mapped = filtered.results
    excludedAlreadyInPipeline = filtered.excluded
  }

  const ledger = buildRemovalLedger({
    loaded: loadedCount,
    canonicalDropped: canonical.dropped,
    filterRemoved,
    displayRefused,
    recovery: relaxation ? { tier: relaxation.tier, readmitted } : null,
    truthBoundaryRemoved,
    dedupeRemoved,
    pipelineExcluded: excludedAlreadyInPipeline,
    returned: mapped.length,
  })
  if (!ledger.reconciles) {
    routeLogger.warn(
      `[discover] removal ledger does not reconcile for profile ${profileId}: unaccounted=${ledger.unaccounted}`,
    )
  }

  return {
    profileContext,
    results: mapped,
    preScoreCount,
    dropped: canonical.dropped,
    relaxation,
    excludedAlreadyInPipeline,
    ledger,
  }
}

async function loadProfileOsResults(req, profileId, {
  minScore = DEFAULT_MIN_SCORE,
  includePipeline = false,
  filters = {},
  searchTerms = [],
  page = 1,
  perPage = 50,
} = {}) {
  const os = await selectProfileOsResults(req, profileId, { minScore, includePipeline, filters, searchTerms })
  const mapped = os.results

  const safePage = Math.max(1, Number.parseInt(String(page), 10) || 1)
  const safePerPage = Math.max(1, Math.min(Number.parseInt(String(perPage), 10) || 50, 100))
  const offset = (safePage - 1) * safePerPage
  const pageResults = mapped.slice(offset, offset + safePerPage)

  return {
    profileContext: os.profileContext,
    results: pageResults,
    total: mapped.length,
    totalFound: os.preScoreCount,
    included: mapped.length,
    excludedAlreadyInPipeline: os.excludedAlreadyInPipeline,
    page: safePage,
    perPage: safePerPage,
    hasMore: offset + pageResults.length < mapped.length,
    dropped: os.dropped,
    relaxation: os.relaxation,
    ledger: os.ledger,
  }
}

// GET /api/discover-grants
// Lightweight Discover Grants compatibility endpoint used by Admin CodeGuard.
// It returns real active opportunities from the same funding_opportunities
// table that powers the Discover UI, never placeholders.
router.get('/discover-grants', async (req, res) => {
  try {
    const profileId = String(req.query?.profile_id || req.query?.profileId || '').trim()
    if (profileId) {
      if (!(await ensureProfileAccess(req, res, profileId))) return
      const os = await loadProfileOsResults(req, profileId, {
        minScore: Number.isFinite(Number(req.query?.min_score)) ? Number(req.query.min_score) : DEFAULT_MIN_SCORE,
        includePipeline: req.query?.include_pipeline === '1',
        filters: { state: req.query?.state },
        page: Number(req.query?.page) || 1,
        perPage: Number(req.query?.limit) || 10,
      })
      return res.json({
        ok: true,
        profile_id: profileId,
        engine: 'crawler-os',
        profile_matched: true,
        // total_found = pre-floor candidates; included = full post-recovery set
        // (page size is results.length / returned_page — do not confuse them).
        total_found: Math.max(Number(os.totalFound) || 0, Number(os.included) || 0, Number(os.total) || 0),
        included: Number(os.included ?? os.total) || 0,
        returned: Number(os.included ?? os.total) || 0,
        returned_page: os.results.length,
        page: os.page,
        per_page: os.perPage,
        results: os.results,
        excluded_already_in_pipeline: os.excludedAlreadyInPipeline || undefined,
        relaxation: os.relaxation || undefined,
        threshold_relaxed: os.relaxation?.threshold_relaxed || undefined,
        threshold_relaxed_reason: os.relaxation?.threshold_relaxed_reason || undefined,
        dropped_reasons: os.dropped && Object.keys(os.dropped).length ? os.dropped : undefined,
        removal_ledger: os.ledger,
      })
    }

    if (!(await isAdminUserWithDb(req.db, req.user))) {
      return res.status(400).json({
        ok: false,
        error: 'profile_id_required',
        message: 'Profile discovery requires a profile_id so results come from Crawler OS profile matches.',
      })
    }

    const limit = Math.max(1, Math.min(Number(req.query?.limit) || 10, 50))
    const state = String(req.query?.state || '').trim().toUpperCase()
    const clauses = [req.db?.dialect === 'postgres' ? 'is_active = TRUE' : 'is_active = 1']
    const params = []
    if (/^[A-Z]{2}$/.test(state)) {
      clauses.push('(UPPER(state) = ? OR state IS NULL OR TRIM(state) = ?)')
      params.push(state, '')
    }
    const where = clauses.join(' AND ')
    const rows = await req.db
      .prepare(
        `
          SELECT id, title, sponsor, application_url, source_url, evidence_url, state, deadline
          FROM funding_opportunities
          WHERE ${where}
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(...params, limit)
    return res.json({
      ok: true,
      catalog_browse: true,
      profile_matched: false,
      warning: 'Admin catalog browse only. These rows are not profile matches.',
      total_found: rows.length,
      included: rows.length,
      results: rows,
    })
  } catch (error) {
    routeLogger.error('discover_grants.failed', error)
    return res.status(500).json({ ok: false, error: error?.message || String(error) })
  }
})

// Scoring and profile signal extraction handled by shared modules:
// - loadProfileContext + buildProfileFacets → profile context
// - computeMatchDecision (backend/services/matchEngine.js) → SOLE
//   acceptance/rejection authority; use this before any pipeline INSERT.
//   Discovery routes compute NO decisions of their own: they read the
//   profile's persisted canonical matches through selectProfileOsResults.

/**
 * Comprehensive match endpoint — the Discover page's result feed
 * (src/components/discovery/discoveryHelpers.jsx → runComprehensiveMatch).
 *
 * Crawler OS is the authoritative profile-scoped discovery source. This route
 * reads the profile's PERSISTED canonical matches through the same selector as
 * GET /discover-grants, so both entry points share one funnel and one removal
 * ledger. It never backfills sparse OS coverage with generic catalog matches.
 *
 * REMOVED 2026-09-17: a catalog-wide live-scoring fallback (fit_score-only rows
 * relaxed through RELAX_THRESHOLDS down to slice(0, FALLBACK_TOP_N)) that sat
 * behind this branch. It was unreachable — every request with a profile id
 * returned above it and every request without one was refused — and it carried
 * a latent reject leak: it discarded the engine decision, so the ladder's
 * REJECT filter had nothing to read. One selector is authoritative now; see
 * backend/tests/comprehensiveMatchRouteAuthority.test.js.
 */
router.post('/comprehensiveMatch', async (req, res) => {
  try {
    const { profile_json, page = 1 } = req.body ?? {}

    if (!profile_json) {
      return res.status(400).json({
        success: false,
        error: 'Profile data is required for comprehensive matching'
      });
    }

    if (req.query.legacy_matching === '1' || req.body?.legacy_matching === '1') {
      return res.status(410).json({
        success: false,
        error: 'legacy_matching_retired',
        engine: 'crawler-os',
        message: 'Legacy catalog matching has been retired. Run Crawler OS discovery for this profile.',
      })
    }

    if (typeof profile_json !== 'string') {
      if (req.ctx?.isAdmin !== true) {
        return res.status(403).json({
          success: false,
          error: 'Non-admin requests must provide a profile_id string',
        })
      }
      // An inline profile object has no persisted match store to read from.
      return res.status(400).json({
        success: false,
        error: 'profile_required',
        engine: 'crawler-os',
        message: 'Crawler OS discovery requires a profile id.',
      })
    }

    const matchProfileId = profile_json
    if (!(await ensureProfileAccess(req, res, matchProfileId))) return

    const osMin = Number.isFinite(Number(req.body?.min_score)) ? Number(req.body.min_score) : DEFAULT_MIN_SCORE
    const includePipeline = req.body?.include_pipeline === true || req.body?.include_pipeline === '1'

    let os
    try {
      os = await selectProfileOsResults(req, matchProfileId, { minScore: osMin, includePipeline })
    } catch (osErr) {
      if (/not found/i.test(String(osErr?.message || ''))) {
        return res.status(404).json({ success: false, error: 'Profile not found' })
      }
      routeLogger.error('comprehensive_match.os_query_failed', osErr)
      return res.status(503).json({
        success: false,
        error: 'crawler_os_match_store_unavailable',
        engine: 'crawler-os',
        message: 'Crawler OS match data is unavailable. Generic fallback matching is disabled.',
      })
    }

    return res.json({
      success: true,
      engine: 'crawler-os',
      opportunities: os.results,
      total: os.results.length,
      page,
      threshold_used: osMin,
      total_evaluated: os.preScoreCount,
      zero_result: os.results.length === 0 || undefined,
      excluded_already_in_pipeline: os.excludedAlreadyInPipeline || undefined,
      relaxation: os.relaxation || undefined,
      threshold_relaxed: os.relaxation?.threshold_relaxed || undefined,
      threshold_relaxed_reason: os.relaxation?.threshold_relaxed_reason || undefined,
      result_tier: os.relaxation?.tier || undefined,
      tier_attempts: os.relaxation?.tier_attempts || undefined,
      dropped_reasons: os.dropped && Object.keys(os.dropped).length ? os.dropped : undefined,
      removal_ledger: os.ledger,
    })
  } catch (error) {
    routeLogger.error('comprehensive_match.failed', error)
    res.status(500).json({
      success: false,
      error: error.message || 'Comprehensive match failed'
    });
  }
});

/**
 * Search Opportunities endpoint
 * Standard opportunity search with filters
 */
router.post('/searchOpportunities', async (req, res) => {
  try {
    const {
      profile_id,
      filters = {},
      additional_keywords = [],
      enhanced_prompt = '',
      page = 1,
      per_page = 50,
    } = req.body;

    if (profile_id) {
      const profileId = String(profile_id)
      if (!(await ensureProfileAccess(req, res, profileId))) return
      const os = await loadProfileOsResults(req, profileId, {
        minScore: Number.isFinite(Number(req.body?.min_score)) ? Number(req.body.min_score) : DEFAULT_MIN_SCORE,
        includePipeline: req.body?.include_pipeline === true || req.body?.include_pipeline === '1',
        filters,
        searchTerms: normalizeSearchTerms(
          additional_keywords,
          filters?.q,
          filters?.search,
          filters?.keyword,
          enhanced_prompt,
        ),
        page,
        perPage: per_page,
      })
      return res.json({
        success: true,
        engine: 'crawler-os',
        profile_id: profileId,
        results: os.results,
        total: os.total,
        excluded_already_in_pipeline: os.excludedAlreadyInPipeline || undefined,
        page: os.page,
        per_page: os.perPage,
        has_more: os.hasMore,
        canonical_dropped: os.dropped,
      })
    }

    const adminGlobalCatalog = req.body?.admin_global_catalog === true || req.body?.admin_global_catalog === '1'
    if (!adminGlobalCatalog) {
      return res.status(400).json({
        success: false,
        error: 'profile_id_required',
        engine: 'crawler-os',
        message: 'Search requires a profile_id so results come from Crawler OS profile matches. Admin catalog browsing must set admin_global_catalog=true.',
      })
    }
    if (!(await isAdminUserWithDb(req.db, req.user))) {
      return res.status(403).json({
        success: false,
        error: 'admin_required',
        message: 'Global catalog browsing is admin-only and is not a profile match result.',
      })
    }
    
    const conditions = [];
    const params = [];
    const isPostgres = req.db?.dialect === 'postgres';

    const activeVal = isPostgres ? 'TRUE' : '1'
    conditions.push(`is_active = ${activeVal}`);
    conditions.push(trustedOriginClause());
    conditions.push(trustedSourceClause());

    conditions.push(
      isPostgres
        ? '(requires_match IS NULL OR requires_match = FALSE)'
        : '(requires_match = 0 OR requires_match IS NULL)',
    );
    conditions.push(
      isPostgres
        ? '(is_loan IS NULL OR is_loan = FALSE)'
        : '(is_loan = 0 OR is_loan IS NULL)',
    );
    
    // Profile-based filtering
    if (profile_id) {
      if (!(await ensureProfileAccess(req, res, String(profile_id)))) return
      const profile = req.db
        .prepare('SELECT * FROM profiles WHERE id = ?')
        .get(profile_id);
      
      // Profile isolation: only global catalog entries or this profile's own crawl results.
      conditions.push('(profile_id IS NULL OR profile_id = ?)')
      params.push(profile_id)

      if (profile && profile.state) {
        conditions.push(`(state = ? OR state IS NULL OR state = 'nationwide')`);
        params.push(profile.state);
      }
    } else {
      // No profile specified: restrict to global catalog only
      conditions.push('profile_id IS NULL')
    }
    
    // Keyword search
    if (additional_keywords && additional_keywords.length > 0) {
      const keywordConditions = additional_keywords.map(() => 
        '(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(keywords) LIKE ?)'
      );
      conditions.push(`(${keywordConditions.join(' OR ')})`);
      
      additional_keywords.forEach(keyword => {
        const pattern = `%${keyword.toLowerCase()}%`;
        params.push(pattern, pattern, pattern);
      });
    }
    
    // Apply filters
    if (filters.state) {
      conditions.push('state = ?');
      params.push(filters.state);
    }
    
    if (filters.min_award) {
      conditions.push('(amount_max IS NULL OR amount_max >= ?)');
      params.push(filters.min_award);
    }
    
    if (filters.max_award) {
      conditions.push('(amount_min IS NULL OR amount_min <= ?)');
      params.push(filters.max_award);
    }
    
    // Build query
    let query = 'SELECT * FROM funding_opportunities';
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    
    const offset = (page - 1) * per_page;
    params.push(per_page, offset);
    
    const opportunities = await req.db.prepare(query).all(...params);
    
    // Count total for pagination
    let countQuery = 'SELECT COUNT(*) as total FROM funding_opportunities';
    if (conditions.length > 0) {
      countQuery += ' WHERE ' + conditions.join(' AND ');
    }
    const countParams = params.slice(0, -2); // Remove LIMIT and OFFSET params
    const countRow = await req.db.prepare(countQuery).get(...countParams);
    const total = Number(countRow?.total ?? 0) || 0;
    
    // Format results with trust assessment + freshness decoration.
    // Canonical trust layer unifies URL/loan/expired/placeholder/source checks
    // with matching.js and /comprehensiveMatch.
    const rawResults = (opportunities || [])
      .map(opp => {
        const trust = assessOpportunityTrust(opp, { allowDirectory: true })
        if (!trust.display) return null
        const url = trust.primaryUrl
        const freshness = decorateOpportunityFreshness(opp)
        return {
          id: opp.id,
          source_id: opp.source_id ?? null,
          title: opp.title || opp.program_name,
          sponsor: opp.sponsor || opp.funder,
          url,
          deadline: opp.deadline,
          award_min: opp.amount_min ?? null,
          award_max: opp.amount_max ?? null,
          description: opp.description || opp.summary,
          state: opp.state,
          source: opp.source || 'database',
          trust_tier: trust.trustTier,
          source_trust: trust.sourceTrust,
          trust_flags: trust.flags,
          trust_reasons: Array.isArray(trust.reasons) ? trust.reasons.slice(0, 10) : [],
          trust_downgrade: Boolean(trust.downgrade),
          trust_downgrade_reason: trust.downgrade
            ? (Array.isArray(trust.reasons) ? trust.reasons : []).find((r) =>
                r === 'link_marked_broken' ||
                r === 'non_actionable_primary_url' ||
                String(r).startsWith('untrusted_origin'),
              ) || 'lower_trust_source'
            : null,
          actionable_url: url || null,
          eligibility: opp.eligibility_bullets,
          updated_at: opp.updated_at ?? null,
          created_at: opp.created_at ?? null,
          funding_source_type: opp.funding_source_type ?? null,
          freshness: freshness.freshness,
          days_since_verified: freshness.days_since_verified,
          freshness_warning: freshness.freshness_warning,
        };
      })
      .filter(Boolean);
    // Deduplicate before returning (display-only; no DB records are changed)
    const deduped = deduplicateOpportunities(rawResults);

    // Pipeline exclusion: never re-surface a grant already in this profile's
    // pipeline or dismissed. Profile-scoped (no cross-profile bleed-over).
    // Skipped when no profile_id (admin global browse) or include_pipeline=1.
    let results = deduped;
    let excludedAlreadyInPipeline = 0;
    if (profile_id && req.body?.include_pipeline !== true && req.body?.include_pipeline !== '1') {
      try {
        const filtered = await filterOutPipelineMembers(req.db, String(profile_id), deduped);
        results = filtered.results;
        excludedAlreadyInPipeline = filtered.excluded;
      } catch (exclErr) {
        // Recall over suppression — a filter failure must not blank results.
        console.warn('[searchOpportunities] pipeline exclusion skipped:', exclErr?.message || exclErr);
      }
    }

    res.json({
      success: true,
      catalog_browse: true,
      profile_matched: false,
      warning: 'Admin catalog browse only. These rows are not profile matches.',
      results,
      total,
      excluded_already_in_pipeline: excludedAlreadyInPipeline || undefined,
      page,
      per_page,
      has_more: offset + opportunities.length < total
    });
    
  } catch (error) {
    console.error('[searchOpportunities] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Search failed'
    });
  }
});

/**
 * Archive Opportunities endpoint
 * For marking opportunities as archived or retrieving archived ones
 */
router.post('/archOpportunities', async (req, res) => {
  try {
    if (req.ctx?.isAdmin !== true) {
      return res.status(403).json({ success: false, error: 'Admin privileges required' })
    }
    const { opportunity_ids = [], action = 'archive' } = req.body;
    
    if (!Array.isArray(opportunity_ids) || opportunity_ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'opportunity_ids array is required'
      });
    }
    
    if (action === 'archive') {
      // Mark opportunities as archived
      const placeholders = opportunity_ids.map(() => '?').join(',');
      const isPostgresArch = req.db?.dialect === 'postgres'
      const query = `
        UPDATE funding_opportunities
        SET archived = ${isPostgresArch ? 'TRUE' : '1'}, archived_at = CURRENT_TIMESTAMP
        WHERE id IN (${placeholders})
      `;
      
      await req.db.prepare(query).run(...opportunity_ids);
      
      res.json({
        success: true,
        message: `Archived ${opportunity_ids.length} opportunities`,
        archived_count: opportunity_ids.length
      });
      
    } else if (action === 'unarchive') {
      // Unarchive opportunities
      const placeholders = opportunity_ids.map(() => '?').join(',');
      const isPostgresUnarch = req.db?.dialect === 'postgres'
      const query = `
        UPDATE funding_opportunities
        SET archived = ${isPostgresUnarch ? 'FALSE' : '0'}, archived_at = NULL
        WHERE id IN (${placeholders})
      `;
      
      await req.db.prepare(query).run(...opportunity_ids);
      
      res.json({
        success: true,
        message: `Unarchived ${opportunity_ids.length} opportunities`,
        unarchived_count: opportunity_ids.length
      });
      
    } else if (action === 'list') {
      // List archived opportunities
      const query = `
        SELECT * FROM funding_opportunities 
        WHERE archived = 1 
        ORDER BY archived_at DESC 
        LIMIT 100
      `;
      
      const archived = await req.db.prepare(query).all();
      
      res.json({
        success: true,
        opportunities: archived,
        total: archived.length
      });
      
    } else {
      return res.status(400).json({
        success: false,
        error: 'Invalid action. Use "archive", "unarchive", or "list"'
      });
    }
    
  } catch (error) {
    console.error('[archOpportunities] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Archive operation failed'
    });
  }
});

/**
 * Discover ECF Services endpoint
 * For ECF CHOICES service discovery
 */
router.post('/discoverECFServices', async (req, res) => {
  try {
    const { profile_id } = req.body;
    
    if (!profile_id) {
      return res.status(400).json({
        success: false,
        error: 'profile_id is required'
      });
    }

    if (!(await ensureProfileAccess(req, res, String(profile_id)))) return
    
    const profile = await req.db
      .prepare('SELECT * FROM profiles WHERE id = ?')
      .get(profile_id);
    
    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }
    
    // Check if this is an ECF CHOICES profile
    let tags = [];
    if (profile.tags) {
      try {
        tags = typeof profile.tags === 'string' ? JSON.parse(profile.tags) : profile.tags;
      } catch (e) {
        // If parsing fails, treat as empty array
        tags = [];
      }
    }
    
    const isECF = Array.isArray(tags) && tags.includes('ecf_choices');
    
    if (!isECF) {
      return res.status(400).json({
        success: false,
        error: 'This profile is not enrolled in ECF CHOICES'
      });
    }
    
    // Search for local ECF services based on profile location
    const isPostgresEcf = req.db?.dialect === 'postgres'
    const ecfActive = isPostgresEcf ? 'TRUE' : '1'
    const conditions = [`is_active = ${ecfActive}`, 'source = ?', trustedOriginClause()];
    const params = ['ecf_choices_discovery'];
    
    if (profile.state) {
      conditions.push('state = ?');
      params.push(profile.state);
    }
    
    const query = `
      SELECT * FROM funding_opportunities 
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC 
      LIMIT 50
    `;
    
    let services = await req.db.prepare(query).all(...params);

    // Pipeline exclusion: never re-surface a service already in this profile's
    // pipeline, dismissed, or secured/imported in university_applications.
    // Profile-scoped (no cross-profile bleed). Skipped when include_pipeline=1.
    let excludedAlreadyInPipeline = 0;
    if (req.body?.include_pipeline !== true && req.body?.include_pipeline !== '1') {
      try {
        const filtered = await filterOutPipelineMembers(req.db, String(profile_id), services);
        services = filtered.results;
        excludedAlreadyInPipeline = filtered.excluded;
      } catch (exclErr) {
        // Recall over suppression — a filter failure must not blank results.
        console.warn('[discoverECFServices] pipeline exclusion skipped:', exclErr?.message || exclErr);
      }
    }

    res.json({
      success: true,
      services,
      count: services.length,
      excluded_already_in_pipeline: excludedAlreadyInPipeline || undefined
    });

  } catch (error) {
    console.error('[discoverECFServices] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'ECF service discovery failed'
    });
  }
});

export default router;
