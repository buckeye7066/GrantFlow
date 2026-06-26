import express from 'express';
import { ensureProfileAccess, isAdminUser, requireAuthenticatedUser } from '../utils/accessControl.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'
import { isJunkOpportunity } from '../services/contentFilter.js'
import { scoreOpportunity } from '../services/matchEngine.js'
import { DEFAULT_MIN_SCORE, RELAX_THRESHOLDS, FALLBACK_TOP_N } from '../config/matchThresholds.js'
import { loadProfileContext, buildProfileSignalAudit } from '../services/profileHelpers.js'
import { buildProfileFacets } from '../services/profile/profileTaxonomy.js'
import { deduplicateOpportunities, decorateOpportunityFreshness } from '../services/opportunityMatcher.js'
import { filterOutPipelineMembers } from '../services/pipelineExclusion.js'
import { resolveGeoCoverage, buildGeoCoverageClause } from '../services/geo/geoCoverageService.js'
import { assessOpportunityTrust } from '../services/opportunityTrust.js'
import { assembleFundingResults } from '../services/zeroResultLadder.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:discovery')

const router = express.Router();

// Discovery endpoints can reference stored profiles; require auth globally.
router.use((req, res, next) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  return next()
})

// GET /api/discover-grants
// Lightweight Discover Grants compatibility endpoint used by Admin CodeGuard.
// It returns real active opportunities from the same funding_opportunities
// table that powers the Discover UI, never placeholders.
router.get('/discover-grants', async (req, res) => {
  try {
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
// - scoreOpportunity (backend/services/matchEngine.js) → non-authoritative
//   ranking score; matchingEngine.js is a legacy compatibility shim.
// - computeMatchDecision (backend/services/matchEngine.js) → SOLE
//   acceptance/rejection authority; use this before any pipeline INSERT.
// - isJunkOpportunity (contentFilter.js) → content filtering

/**
 * Comprehensive AI Match endpoint
 * Performs deep profile analysis and multi-source matching
 */
router.post('/comprehensiveMatch', async (req, res) => {
  try {
    const { profile_json, states = [], page = 1, freshness_days = 60 } = req.body;
    
    if (!profile_json) {
      return res.status(400).json({
        success: false,
        error: 'Profile data is required for comprehensive matching'
      });
    }

    const user = req.user ?? { role: 'guest' }

    // Build full profile context (same path as Smart Matcher for consistent scoring)
    let profile, profileContext, organization, profileSections = {};
    if (typeof profile_json === 'string') {
      if (!(await ensureProfileAccess(req, res, profile_json))) return
      try {
        const baseContext = await loadProfileContext(req.db, profile_json)
        profileContext = buildProfileFacets(baseContext)
        profile = profileContext.profile
        organization = profileContext.organization ?? null
        profileSections = profileContext.sections ?? {}
      } catch (e) {
        return res.status(404).json({ success: false, error: 'Profile not found' })
      }
    } else if (!isAdminUser(user)) {
      return res.status(403).json({
        success: false,
        error: 'Non-admin requests must provide a profile_id string',
      })
    } else {
      profile = profile_json
      profileContext = { profile }
      if (profile.organization_id) {
        organization = req.db
          .prepare('SELECT * FROM organizations WHERE id = ?')
          .get(profile.organization_id) ?? null
      }
    }

    // Extract search criteria from profile
    const searchKeywords = [];
    const profileStates = states.length > 0 ? states : 
      [organization?.state, profileSections?.location_focus?.state].filter(Boolean);
    
    // ── Geographic coverage resolution (progressive expansion) ──
    // Extracts ZIP/state from profile signals, then expands radius until
    // sufficient results are found: 25mi → 50mi → state → national.
    const profileZip =
      profileContext?.signals?.location?.zip ??
      profileSections?.basic_information?.zip ??
      profileSections?.location_focus?.primary_zip ??
      profile?.postal_code ?? profile?.zip_code ?? null
    const profileState =
      profileContext?.signals?.location?.state ??
      (profileStates.length > 0 ? profileStates[0] : null)

    let geoCoverage = null
    try {
      geoCoverage = await resolveGeoCoverage(req.db, {
        zip: profileZip,
        state: profileState,
      })
    } catch (e) {
      console.warn('[comprehensiveMatch] Geo coverage resolution failed, falling back to state filter:', e?.message)
    }

    // Build search query based on profile characteristics
    const conditions = [];
    const params = [];
    
    // Exclude fake/synthetic sources
    conditions.push(trustedSourceClause());
    conditions.push(trustedOriginClause());
    
    const isPostgres = req.db?.dialect === 'postgres'

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

    // Crawler OS is the authoritative profile-scoped discovery source. This
    // compatibility endpoint may not backfill sparse OS coverage with generic
    // catalog matches.
    const matchProfileId = typeof profile_json === 'string' ? profile_json : (profile?.id ?? null)
    if (req.query.legacy_matching === '1' || req.body?.legacy_matching === '1') {
      return res.status(410).json({
        success: false,
        error: 'legacy_matching_retired',
        engine: 'crawler-os',
        message: 'Legacy catalog matching has been retired. Run Crawler OS discovery for this profile.',
      })
    }
    if (!matchProfileId) {
      return res.status(400).json({
        success: false,
        error: 'profile_required',
        engine: 'crawler-os',
        message: 'Crawler OS discovery requires a profile id.',
      })
    }

    if (matchProfileId) {
      let osRows = []
      try {
        osRows = await req.db
          .prepare(
            `SELECT o.*, m.match_score AS os_match_score, m.match_decision AS os_match_decision,
                    m.match_explanation AS os_match_explanation, m.match_reasons AS os_match_reasons
               FROM profile_opportunity_matches m
               JOIN funding_opportunities o ON o.id = m.opportunity_id
              WHERE m.profile_id = ? AND m.matcher_version = 'crawler-os'
                AND (o.is_active IS NULL OR o.is_active = 1)
                AND (o.is_hidden IS NULL OR o.is_hidden = 0)
              ORDER BY m.match_score DESC`,
          )
          .all(matchProfileId)
      } catch (osErr) {
        routeLogger.error('comprehensive_match.os_query_failed', osErr)
        return res.status(503).json({
          success: false,
          error: 'crawler_os_match_store_unavailable',
          engine: 'crawler-os',
          message: 'Crawler OS match data is unavailable. Generic fallback matching is disabled.',
        })
      }

      const osMin = Number.isFinite(Number(req.body?.min_score)) ? Number(req.body.min_score) : DEFAULT_MIN_SCORE
      let mapped = osRows.map((o) => {
        let reasons = []
        try { reasons = JSON.parse(o.os_match_reasons || '[]') } catch { reasons = [] }
        const kind = String(o.opportunity_kind ?? '').toUpperCase()
        const isDirectory = kind === 'DIRECTORY' || kind === 'PAST_AWARD_INTEL'
        return {
          ...o,
          match_score: Number(o.os_match_score ?? 0),
          match_decision: o.os_match_decision,
          match_explanation: o.os_match_explanation,
          match_reasons: reasons,
          is_directory: isDirectory,
          trust_tier: o.source_trust_tier ?? null,
          url: o.application_url ?? o.apply_url ?? o.source_url ?? null,
          actionable_url: o.application_url ?? o.apply_url ?? o.source_url ?? null,
          engine: 'crawler-os',
        }
      })
      if (req.body?.include_pipeline !== true && req.body?.include_pipeline !== '1') {
        mapped = (await filterOutPipelineMembers(req.db, matchProfileId, mapped)).results
      }
      const qualified = mapped.filter((o) => o.is_directory || Number(o.match_score) >= osMin)
      return res.json({
        success: true,
        engine: 'crawler-os',
        opportunities: qualified,
        total: qualified.length,
        page,
        threshold_used: osMin,
        total_evaluated: mapped.length,
        zero_result: qualified.length === 0 || undefined,
      })
    }
    if (matchProfileId) {
      conditions.push('(profile_id IS NULL OR profile_id = ?)')
      params.push(matchProfileId)
    } else {
      conditions.push('profile_id IS NULL')
    }
    
    // ── Geographic filtering (radius-aware) ──
    // Uses geo coverage when available; falls back to legacy state filter.
    if (geoCoverage && geoCoverage.tier !== 'national') {
      const geoClause = buildGeoCoverageClause(req.db, geoCoverage)
      conditions.push(geoClause.clause)
      params.push(...geoClause.params)
    } else if (profileStates.length > 0) {
      const statePlaceholders = profileStates.map(() => '?').join(',');
      conditions.push(`(state IN (${statePlaceholders}) OR state IS NULL OR state = 'nationwide')`);
      params.push(...profileStates);
    }
    
    // Freshness filter
    if (freshness_days > 0) {
      if (isPostgres) {
        conditions.push('(deadline IS NULL OR deadline >= (CURRENT_DATE - (?::int * INTERVAL \'1 day\')))');
        params.push(freshness_days);
      } else {
        conditions.push(`(deadline IS NULL OR deadline >= date('now', '-' || ? || ' days'))`);
        params.push(freshness_days);
      }
    }

    // Build the query with geographic coverage.
    const candidateLimit = 3000;
    const geoStates = geoCoverage?.nearbyStates instanceof Set ? [...geoCoverage.nearbyStates] : profileStates
    const statePhForOrder = geoStates.length > 0 ? geoStates.map(() => '?').join(',') : null;

    let query =
      isPostgres
        ? 'SELECT * FROM funding_opportunities WHERE is_active = TRUE'
        : 'SELECT * FROM funding_opportunities WHERE is_active = 1';
    if (conditions.length > 0) {
      query += ' AND ' + conditions.join(' AND ');
    }
    const deadlineNullSort =
      isPostgres ? 'deadline IS NULL' : "deadline IS NULL OR deadline = ''";
    const isNationalSort = isPostgres
      ? "(is_national = TRUE OR state = 'nationwide')"
      : "(is_national = 1 OR state = 'nationwide')";
    const stateOrderClause = statePhForOrder
      ? `CASE WHEN state IN (${statePhForOrder}) THEN 0 ELSE 1 END, `
      : '';
    query += ` ORDER BY ${stateOrderClause}CASE WHEN ${isNationalSort} THEN 0 ELSE 1 END, CASE WHEN ${deadlineNullSort} THEN 0 ELSE 1 END, deadline ASC, updated_at DESC LIMIT ${candidateLimit}`;

    const opportunities = await req.db.prepare(query).all(
      ...params,
      ...(geoStates.length > 0 ? geoStates : []),
    );
    
    const tierLabel = geoCoverage ? `tier=${geoCoverage.tier}` : 'fallback=state'
    routeLogger.info(`[comprehensiveMatch] Query found ${opportunities.length} opportunities (${tierLabel}, zip=${profileZip || 'none'})`);

    const healthSet = profileContext?.signals?.health
    const healthFacets = profileContext?.facets?.health ?? {}
    const kws = profileContext?.signals?.keywordSet ?? new Set()

    if (kws.size > 0 || (healthSet instanceof Set && healthSet.size > 0)) {
      routeLogger.info(`[comprehensiveMatch] Profile signals:`, JSON.stringify({
        keywords: [...kws].slice(0, 15),
        health: healthSet instanceof Set ? [...healthSet] : [],
      }));
    }

    const filterHints = {
      hasHealthNeeds:
        (healthSet instanceof Set && healthSet.size > 0) ||
        healthFacets.disability_types?.length > 0 ||
        healthFacets.visual_impairment || healthFacets.hearing_impairment ||
        healthFacets.chronic_illness || healthFacets.mental_health_condition ||
        kws.has('disability') || kws.has('chronic') || kws.has('mental health') || kws.has('epilepsy'),
      needsTransport: kws.has('transportation') || kws.has('ride assistance'),
    };
    const filteredOpportunities = opportunities.filter(opp => !isJunkOpportunity(opp, filterHints));
    const hasBizIntent = kws.has('small business') || kws.has('startup') || kws.has('entrepreneur') || kws.has('sba');
    routeLogger.info(`[comprehensiveMatch] Filtered ${opportunities.length - filteredOpportunities.length} irrelevant opportunities, ${filteredOpportunities.length} remaining. Business intent: ${hasBizIntent}`);

    // Canonical consumer-side trust assessment. This is the single layer
    // that decides whether a row is shown to the user, consistent with
    // matching.js. It handles: placeholder URLs, loans leaking past SQL
    // filters, matching-funds, expired deadlines, broken links, untrusted
    // origins, social-only URLs, and source tier classification.
    // Directory rows are kept (they are legitimate help) but flagged.
    const trustDroppedReasons = {}
    const trustKept = []
    for (const opp of filteredOpportunities) {
      const trust = assessOpportunityTrust(opp, {
        allowDirectory: true,
        allowExpired: false,
      })
      if (!trust.display) {
        for (const reason of trust.reasons) {
          trustDroppedReasons[reason] = (trustDroppedReasons[reason] || 0) + 1
        }
        continue
      }
      trustKept.push({ opp, trust })
    }
    const trustDroppedTotal = filteredOpportunities.length - trustKept.length
    if (trustDroppedTotal > 0) {
      routeLogger.info(
        `[comprehensiveMatch] Trust layer dropped ${trustDroppedTotal}:`,
        trustDroppedReasons,
      )
    }

    const scoredOpportunities = trustKept.map(({ opp, trust }) => {
      const computed = scoreOpportunity(profileContext, opp);

      let eligSummary = ''
      try {
        const bullets = typeof opp.eligibility_bullets === 'string' ? JSON.parse(opp.eligibility_bullets) : opp.eligibility_bullets
        eligSummary = Array.isArray(bullets) ? bullets.join('; ') : (opp.eligibility_bullets || '')
      } catch { eligSummary = opp.eligibility_bullets || '' }

      const freshness = decorateOpportunityFreshness(opp)
      // Soft downgrade for stale/non-official sources: keep them in results
      // but pull them behind higher-trust options of equal score.
      const adjustedScore = trust.downgrade
        ? Math.max(0, computed.score - 5)
        : computed.score

      return {
        id: opp.id,
        source_id: opp.source_id,
        source: opp.source ?? null,
        title: opp.title || opp.program_name,
        program_name: opp.title || opp.program_name,
        sponsor: opp.sponsor || opp.funder,
        url: trust.primaryUrl || null,
        deadline: opp.deadline,
        state: opp.state ?? null,
        amount_min: opp.amount_min ?? null,
        amount_max: opp.amount_max ?? null,
        description: opp.description || opp.summary,
        eligibility_summary: eligSummary,
        fit_score: adjustedScore,
        match_score: adjustedScore,
        match_reasons: computed.reasons,
        matched_fields: computed.reasons.slice(0, 10),
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
        actionable_url: trust.primaryUrl ?? null,
        updated_at: opp.updated_at ?? null,
        created_at: opp.created_at ?? null,
        funding_source_type: opp.funding_source_type ?? null,
        freshness: freshness.freshness,
        days_since_verified: freshness.days_since_verified,
        freshness_warning: freshness.freshness_warning,
      };
    });
    
    // Debug: Log score distribution
    const scoreSummary = scoredOpportunities.reduce((acc, o) => {
      const bucket = Math.floor(o.fit_score / 10) * 10;
      acc[bucket] = (acc[bucket] || 0) + 1;
      return acc;
    }, {});
    routeLogger.info(`[comprehensiveMatch] Score distribution:`, scoreSummary);
    
    if (scoredOpportunities.length > 0) {
      const topScores = scoredOpportunities
        .sort((a, b) => b.fit_score - a.fit_score)
        .slice(0, 5)
        .map(o => ({ title: o.program_name?.substring(0, 30), score: o.fit_score, matched: o.matched_fields }));
      routeLogger.info(`[comprehensiveMatch] Top 5 scores:`, JSON.stringify(topScores));
    }
    
    // Deduplicate before threshold filtering — keeps highest-trust record when same grant
    // appears from multiple crawl sources. Display-only: no DB records are changed.
    const dedupedOpportunities = deduplicateOpportunities(scoredOpportunities)
    const dedupedCount = scoredOpportunities.length - dedupedOpportunities.length
    if (dedupedCount > 0) {
      routeLogger.info(`[comprehensiveMatch] Deduplication removed ${dedupedCount} duplicate opportunities`)
    }

    let matchThreshold = DEFAULT_MIN_SCORE;
    let highScoring = dedupedOpportunities
      .filter(o => o.fit_score >= matchThreshold)
      .sort((a, b) => b.fit_score - a.fit_score);

    if (highScoring.length === 0 && dedupedOpportunities.length > 0) {
      for (const fallback of RELAX_THRESHOLDS) {
        highScoring = dedupedOpportunities
          .filter(o => o.fit_score >= fallback)
          .sort((a, b) => b.fit_score - a.fit_score);
        if (highScoring.length > 0) {
          matchThreshold = fallback;
          routeLogger.info(`[comprehensiveMatch] Zero results at ${DEFAULT_MIN_SCORE}; relaxed to ${fallback} (${highScoring.length} results)`);
          break;
        }
      }
      if (highScoring.length === 0) {
        highScoring = dedupedOpportunities.sort((a, b) => b.fit_score - a.fit_score).slice(0, FALLBACK_TOP_N);
        matchThreshold = 0;
        routeLogger.info(`[comprehensiveMatch] All thresholds exhausted; returning top ${highScoring.length}`);
      }
    }

    // Trust layer already filtered placeholder/loan/expired/etc. before
    // scoring, so `highScoring` is the final actionable list. No secondary
    // filterActionableOpportunities pass is needed.
    let signalAudit = null
    try {
      signalAudit = buildProfileSignalAudit(profileContext)
    } catch (auditErr) {
      signalAudit = { error: auditErr?.message ?? String(auditErr) }
    }

    const wasRelaxed = matchThreshold < DEFAULT_MIN_SCORE
    const relaxedReason = wasRelaxed
      ? `No matches at default threshold ${DEFAULT_MIN_SCORE}; relaxed to ${matchThreshold} so you still see options. Complete your profile (location, needs, organization type) to improve match quality.`
      : undefined

    // Mission rule (Phase 6): run the canonical zero-result ladder so
    // the discovery envelope carries the same diagnostics as matching.js
    // and the FundingResultCard renders honest threshold/relaxed banners.
    const ladderProfileGaps = []
    try {
      const sig = profileContext?.signals ?? {}
      if (!sig?.location?.state && !sig?.location?.zip) ladderProfileGaps.push('location')
      if (!sig?.entityType && !profileContext?.profile?.primary_type) ladderProfileGaps.push('profile_type')
      if (!sig?.interests?.size && !sig?.demographics?.size) ladderProfileGaps.push('interests')
    } catch { /* best-effort */ }

    const ladderInput = dedupedOpportunities.map((o) => ({
      ...o,
      match_score: o.match_score ?? o.fit_score,
    }))
    const ladder = assembleFundingResults(ladderInput, {
      minScore: DEFAULT_MIN_SCORE,
      maxResults: Math.max(highScoring.length, 100),
      profileGaps: ladderProfileGaps,
    })

    let finalOpportunities = highScoring
    if (highScoring.length === 0 && Array.isArray(ladder.opportunities) && ladder.opportunities.length > 0) {
      finalOpportunities = ladder.opportunities
    } else if (ladder.threshold_relaxed) {
      finalOpportunities = highScoring.map((o) => ({
        ...o,
        threshold_relaxed: true,
        relaxed_reason: o.relaxed_reason || ladder.threshold_relaxed_reason,
      }))
    }

    // Pipeline exclusion: drop anything already in THIS profile's pipeline or
    // dismissed. Profile-scoped → no cross-profile bleed-over.
    const profileIdForExclusion = typeof profile_json === 'string' ? profile_json : (profile?.id ?? null)
    let excludedAlreadyInPipeline = 0
    if (profileIdForExclusion && req.body?.include_pipeline !== true && req.body?.include_pipeline !== '1') {
      try {
        const filtered = await filterOutPipelineMembers(req.db, String(profileIdForExclusion), finalOpportunities)
        finalOpportunities = filtered.results
        excludedAlreadyInPipeline = filtered.excluded
      } catch (exclErr) {
        routeLogger.warn(`[comprehensiveMatch] pipeline exclusion skipped: ${exclErr?.message || exclErr}`)
      }
    }

    res.json({
      success: true,
      opportunities: finalOpportunities,
      total: finalOpportunities.length,
      excluded_already_in_pipeline: excludedAlreadyInPipeline || undefined,
      page,
      threshold_used: matchThreshold,
      threshold_relaxed: wasRelaxed || ladder.threshold_relaxed ? true : undefined,
      threshold_relaxed_reason: relaxedReason || ladder.threshold_relaxed_reason,
      total_evaluated: scoredOpportunities.length,
      total_after_dedupe: dedupedOpportunities.length,
      trust_dropped: trustDroppedTotal,
      trust_drop_reasons: trustDroppedReasons,
      profile_signal_audit: signalAudit,
      result_tier: ladder.tier,
      directory_only: ladder.directory_only || undefined,
      geo_expanded: ladder.geo_expanded || undefined,
      profile_gaps: ladder.profile_gaps?.length ? ladder.profile_gaps : undefined,
      tier_attempts: ladder.tier_attempts,
      tier_explanation: ladder.explanation,
    });
    
  } catch (error) {
    console.error('[comprehensiveMatch] Error:', error);
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
    const { profile_id, filters = {}, additional_keywords = [], page = 1, per_page = 50 } = req.body;
    
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
    const user = req.user ?? { role: 'guest' }
    if (!isAdminUser(user)) {
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
