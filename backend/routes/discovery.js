import express from 'express';
import { ensureProfileAccess, isAdminUser, requireAuthenticatedUser } from '../utils/accessControl.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'
import { isJunkOpportunity } from '../services/contentFilter.js'
import { scoreOpportunity } from '../services/matchEngine.js'
import { DEFAULT_MIN_SCORE, RELAX_THRESHOLDS, FALLBACK_TOP_N } from '../config/matchThresholds.js'
import { isPlaceholderUrl } from '../config/urlRules.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { buildProfileFacets } from '../services/profile/profileTaxonomy.js'
import { deduplicateOpportunities, decorateOpportunityFreshness } from '../services/opportunityMatcher.js'
import { resolveGeoCoverage, buildGeoCoverageClause } from '../services/geo/geoCoverageService.js'
import { filterActionableOpportunities } from '../services/opportunityValidationLayer.js'

const router = express.Router();

// Discovery endpoints can reference stored profiles; require auth globally.
router.use((req, res, next) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  return next()
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

    // Profile isolation: only global catalog entries (profile_id IS NULL) or this profile's own crawl results.
    const matchProfileId = typeof profile_json === 'string' ? profile_json : (profile?.id ?? null)
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
    console.log(`[comprehensiveMatch] Query found ${opportunities.length} opportunities (${tierLabel}, zip=${profileZip || 'none'})`);

    const healthSet = profileContext?.signals?.health
    const healthFacets = profileContext?.facets?.health ?? {}
    const kws = profileContext?.signals?.keywordSet ?? new Set()

    if (kws.size > 0 || (healthSet instanceof Set && healthSet.size > 0)) {
      console.log(`[comprehensiveMatch] Profile signals:`, JSON.stringify({
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
    console.log(`[comprehensiveMatch] Filtered ${opportunities.length - filteredOpportunities.length} irrelevant opportunities, ${filteredOpportunities.length} remaining. Business intent: ${hasBizIntent}`);

    const scoredOpportunities = filteredOpportunities.map(opp => {
      const computed = scoreOpportunity(profileContext, opp);

      let url = opp.url || opp.application_url;
      if (url && isPlaceholderUrl(url)) {
        url = null;
      }

      let eligSummary = ''
      try {
        const bullets = typeof opp.eligibility_bullets === 'string' ? JSON.parse(opp.eligibility_bullets) : opp.eligibility_bullets
        eligSummary = Array.isArray(bullets) ? bullets.join('; ') : (opp.eligibility_bullets || '')
      } catch { eligSummary = opp.eligibility_bullets || '' }

      const freshness = decorateOpportunityFreshness(opp)
      return {
        id: opp.id,
        source_id: opp.source_id,
        source: opp.source ?? null,
        title: opp.title || opp.program_name,
        program_name: opp.title || opp.program_name,
        sponsor: opp.sponsor || opp.funder,
        url,
        deadline: opp.deadline,
        state: opp.state ?? null,
        amount_min: opp.amount_min ?? null,
        amount_max: opp.amount_max ?? null,
        description: opp.description || opp.summary,
        eligibility_summary: eligSummary,
        fit_score: computed.score,
        match_score: computed.score,
        match_reasons: computed.reasons,
        matched_fields: computed.reasons.slice(0, 10),
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
    console.log(`[comprehensiveMatch] Score distribution:`, scoreSummary);
    
    if (scoredOpportunities.length > 0) {
      const topScores = scoredOpportunities
        .sort((a, b) => b.fit_score - a.fit_score)
        .slice(0, 5)
        .map(o => ({ title: o.program_name?.substring(0, 30), score: o.fit_score, matched: o.matched_fields }));
      console.log(`[comprehensiveMatch] Top 5 scores:`, JSON.stringify(topScores));
    }
    
    // Deduplicate before threshold filtering — keeps highest-trust record when same grant
    // appears from multiple crawl sources. Display-only: no DB records are changed.
    const dedupedOpportunities = deduplicateOpportunities(scoredOpportunities)
    const dedupedCount = scoredOpportunities.length - dedupedOpportunities.length
    if (dedupedCount > 0) {
      console.log(`[comprehensiveMatch] Deduplication removed ${dedupedCount} duplicate opportunities`)
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
          console.log(`[comprehensiveMatch] Zero results at ${DEFAULT_MIN_SCORE}; relaxed to ${fallback} (${highScoring.length} results)`);
          break;
        }
      }
      if (highScoring.length === 0) {
        highScoring = dedupedOpportunities.sort((a, b) => b.fit_score - a.fit_score).slice(0, FALLBACK_TOP_N);
        matchThreshold = 0;
        console.log(`[comprehensiveMatch] All thresholds exhausted; returning top ${highScoring.length}`);
      }
    }

    const actionableResults = filterActionableOpportunities(highScoring);

        res.json({
      success: true,
      opportunities: actionableResults,
      total: actionableResults.length,
      page,
      threshold_used: matchThreshold,
      threshold_relaxed: matchThreshold < DEFAULT_MIN_SCORE ? true : undefined,
      total_evaluated: scoredOpportunities.length,
      total_after_dedupe: dedupedOpportunities.length,
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
    
    // Format results with freshness decoration
    const rawResults = (opportunities || []).map(opp => {
      let url = opp.url || opp.application_url || null
      if (url && isPlaceholderUrl(url)) {
        url = null;
      }
      const freshness = decorateOpportunityFreshness(opp)
      return {
        id: opp.id,
        source_id: opp.source_id ?? null,
        title: opp.title || opp.program_name,
        sponsor: opp.sponsor || opp.funder,
        url: url,
        deadline: opp.deadline,
        award_min: opp.amount_min ?? null,
        award_max: opp.amount_max ?? null,
        description: opp.description || opp.summary,
        state: opp.state,
        source: opp.source || 'database',
        eligibility: opp.eligibility_bullets,
        updated_at: opp.updated_at ?? null,
        created_at: opp.created_at ?? null,
        funding_source_type: opp.funding_source_type ?? null,
        freshness: freshness.freshness,
        days_since_verified: freshness.days_since_verified,
        freshness_warning: freshness.freshness_warning,
      };
    });
    // Deduplicate before returning (display-only; no DB records are changed)
    const results = deduplicateOpportunities(rawResults);
    
    res.json({
      success: true,
      results,
      total,
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
    
    const services = await req.db.prepare(query).all(...params);
    
    res.json({
      success: true,
      services,
      count: services.length
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
