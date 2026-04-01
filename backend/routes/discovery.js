import express from 'express';
import { ensureProfileAccess, isAdminUser, requireAuthenticatedUser } from '../utils/accessControl.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'
import { isJunkOpportunity } from '../services/contentFilter.js'
// NOTE: scoreOpportunity is used here for display-only scoring of the discovery
// feed. This route does NOT insert into the grants pipeline; it surfaces scored
// opportunities for user browsing. The canonical computeMatchDecision() is used
// for all pipeline insertions via saveToProfilePipeline.
import { scoreOpportunity } from '../services/matchEngine.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { buildProfileFacets } from '../services/profile/profileTaxonomy.js'

const router = express.Router();

// Discovery endpoints can reference stored profiles; require auth globally.
router.use((req, res, next) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  return next()
})

// Scoring and profile signal extraction handled by shared modules:
// - loadProfileContext + buildProfileFacets → profile context
// - scoreOpportunity (matchingEngine.js) → scoring
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
    
    // Build search query based on profile characteristics
    const conditions = [];
    const params = [];
    
    // Exclude fake/synthetic sources
    conditions.push(trustedSourceClause());

        conditions.push(trustedOriginClause());
                
    
    const isPostgres = req.db?.dialect === 'postgres'

  // Unconditional exclusion of loans and matching-required funds in every query path.
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
    // Profile isolation handled below after freshness filter
    
    // State filtering
    if (profileStates.length > 0) {
      const statePlaceholders = profileStates.map(() => '?').join(',');
      conditions.push(`(state IN (${statePlaceholders}) OR state IS NULL OR state = 'nationwide')`);
      params.push(...profileStates);
    }
    
    // Freshness filter
    if (freshness_days > 0) {
      if (isPostgres) {
        // Postgres: `CURRENT_DATE - (N days)`; keep it parameterized.
        conditions.push('(deadline IS NULL OR deadline >= (CURRENT_DATE - (?::int * INTERVAL \'1 day\')))');
        params.push(freshness_days);
      } else {
        conditions.push(`(deadline IS NULL OR deadline >= date('now', '-' || ? || ' days'))`);
        params.push(freshness_days);
      }
    }

    // Profile isolation: each profile sees global catalog entries plus its own crawl results.
    // This prevents cross-profile bleed where Profile A's crawl results appear in Profile B's matches.
    // When profile_json is a string it is the profile_id; skip isolation for admin-supplied raw objects.
    if (typeof profile_json === 'string') {
      conditions.push('(profile_id IS NULL OR profile_id = ?)');
      params.push(profile_json);
    }
    
    // Build the query: pull state + national + NULL state for relatable funding (no RANDOM).
    // Goal: real funding sources for profile needs — candidates are geographically relevant, then scored by profile signals.
    const candidateLimit = 3000;
    const statePlaceholders = profileStates.length > 0 ? profileStates.map(() => '?').join(',') : null;
    let query =
      req.db?.dialect === 'postgres'
        ? 'SELECT * FROM funding_opportunities WHERE is_active = TRUE'
        : 'SELECT * FROM funding_opportunities WHERE is_active = 1';
    if (conditions.length > 0) {
      query += ' AND ' + conditions.join(' AND ');
    }
    // Prefer state-specific, then national/rolling, then by deadline (deterministic, repeatable).
    const deadlineNullSort =
      req.db?.dialect === 'postgres' ? 'deadline IS NULL' : "deadline IS NULL OR deadline = ''";
    const isNationalSort = req.db?.dialect === 'postgres'
      ? "(is_national = TRUE OR state = 'nationwide')"
      : "(is_national = 1 OR state = 'nationwide')";
    const stateOrderClause = profileStates.length > 0
      ? `CASE WHEN state IN (${'?,'.repeat(profileStates.length).slice(0,-1)}) THEN 0 ELSE 1 END, `
      : '';
    query += ` ORDER BY ${stateOrderClause}CASE WHEN ${isNationalSort} THEN 0 ELSE 1 END, CASE WHEN ${deadlineNullSort} THEN 0 ELSE 1 END, deadline ASC, updated_at DESC LIMIT ${candidateLimit}`;

    const opportunities = req.db.prepare(query).all(...params);
    
    console.info(`[comprehensiveMatch] Query found ${opportunities.length} opportunities`);

    const healthSet = profileContext?.signals?.health
    const healthFacets = profileContext?.facets?.health ?? {}
    const kws = profileContext?.signals?.keywordSet ?? new Set()

    if (kws.size > 0 || (healthSet instanceof Set && healthSet.size > 0)) {
      console.info(`[comprehensiveMatch] Profile signals:`, JSON.stringify({
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
    console.info(`[comprehensiveMatch] Filtered ${opportunities.length - filteredOpportunities.length} irrelevant opportunities, ${filteredOpportunities.length} remaining. Business intent: ${hasBizIntent}`);

    const scoredOpportunities = filteredOpportunities.map(opp => {
      const computed = scoreOpportunity(profileContext, opp);

      let url = opp.url || opp.application_url;
      if (url && (url.includes('example.org') || url.includes('example.com') || url.includes('placeholder'))) {
        url = null;
      }

      let eligSummary = ''
      try {
        const bullets = typeof opp.eligibility_bullets === 'string' ? JSON.parse(opp.eligibility_bullets) : opp.eligibility_bullets
        eligSummary = Array.isArray(bullets) ? bullets.join('; ') : (opp.eligibility_bullets || '')
      } catch { eligSummary = opp.eligibility_bullets || '' }

      return {
        id: opp.id,
        source_id: opp.source_id,
        program_name: opp.title || opp.program_name,
        sponsor: opp.sponsor || opp.funder,
        url,
        deadline: opp.deadline,
        amount_min: opp.amount_min ?? null,
        amount_max: opp.amount_max ?? null,
        description: opp.description || opp.summary,
        eligibility_summary: eligSummary,
        fit_score: computed.score,
        match_score: computed.score,
        match_reasons: computed.reasons,
        matched_fields: computed.reasons.slice(0, 10),
      };
    });
    
    // Debug: Log score distribution
    const scoreSummary = scoredOpportunities.reduce((acc, o) => {
      const bucket = Math.floor(o.fit_score / 10) * 10;
      acc[bucket] = (acc[bucket] || 0) + 1;
      return acc;
    }, {});
    console.info(`[comprehensiveMatch] Score distribution:`, scoreSummary);
    
    if (scoredOpportunities.length > 0) {
      const topScores = scoredOpportunities
        .sort((a, b) => b.fit_score - a.fit_score)
        .slice(0, 5)
        .map(o => ({ title: o.program_name?.substring(0, 30), score: o.fit_score, matched: o.matched_fields }));
      console.info(`[comprehensiveMatch] Top 5 scores:`, JSON.stringify(topScores));
    }
    
    let matchThreshold = 50;
    let highScoring = scoredOpportunities
      .filter(o => o.fit_score >= matchThreshold)
      .sort((a, b) => b.fit_score - a.fit_score);

    // Zero-results fallback: progressively lower threshold
    if (highScoring.length === 0 && scoredOpportunities.length > 0) {
      for (const fallback of [30, 15, 0]) {
        highScoring = scoredOpportunities
          .filter(o => o.fit_score >= fallback)
          .sort((a, b) => b.fit_score - a.fit_score);
        if (highScoring.length > 0) {
          matchThreshold = fallback;
          console.info(`[comprehensiveMatch] Zero results at 50; relaxed to ${fallback} (${highScoring.length} results)`);
          break;
        }
      }
      if (highScoring.length === 0) {
        highScoring = scoredOpportunities.sort((a, b) => b.fit_score - a.fit_score).slice(0, 20);
        matchThreshold = 0;
        console.info(`[comprehensiveMatch] All thresholds exhausted; returning top ${highScoring.length}`);
      }
    }
    
    res.json({
      success: true,
      opportunities: highScoring,
      total: highScoring.length,
      page,
      threshold_used: matchThreshold,
      threshold_relaxed: matchThreshold < 50 ? true : undefined,
      total_evaluated: scoredOpportunities.length
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
    
    const opportunities = req.db.prepare(query).all(...params);
    
    // Count total for pagination
    let countQuery = 'SELECT COUNT(*) as total FROM funding_opportunities';
    if (conditions.length > 0) {
      countQuery += ' WHERE ' + conditions.join(' AND ');
    }
    const countParams = params.slice(0, -2); // Remove LIMIT and OFFSET params
    const countRow = req.db.prepare(countQuery).get(...countParams);
    const total = Number(countRow?.total ?? 0) || 0;
    
    // Format results
    const results = (opportunities || []).map(opp => {
      // Filter out placeholder URLs
      let url = opp.url || opp.application_url || null
      if (url && (url.includes('example.org') || url.includes('example.com') || url.includes('placeholder'))) {
        url = null;
      }
      
      return {
        id: opp.id,
        title: opp.title || opp.program_name,
        sponsor: opp.sponsor || opp.funder,
        url: url,
        deadline: opp.deadline,
      award_min: opp.amount_min,
      award_max: opp.amount_max,
      description: opp.description || opp.summary,
      state: opp.state,
      source: opp.source || 'database',
      eligibility: opp.eligibility_bullets
      };
    });
    
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
    const isPostgres = req.db?.dialect === 'postgres'
    const user = req.user ?? { role: 'guest' }
    if (!isAdminUser(user)) {
      return res.status(403).json({ success: false, error: 'Admin privileges required' })
    }
    const { opportunity_ids = [], action = 'archive' } = req.body;
    const isPostgres = req.db?.dialect === 'postgres'
    
    if (!Array.isArray(opportunity_ids) || opportunity_ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'opportunity_ids array is required'
      });
    }
    
    if (action === 'archive') {
      // Mark opportunities as archived
      const placeholders = opportunity_ids.map(() => '?').join(',');
      const query = `
        UPDATE funding_opportunities 
        SET archived = ${isPostgres ? 'TRUE' : '1'}, archived_at = CURRENT_TIMESTAMP 
        WHERE id IN (${placeholders})
      `;
      
      req.db.prepare(query).run(...opportunity_ids);
      
      res.json({
        success: true,
        message: `Archived ${opportunity_ids.length} opportunities`,
        archived_count: opportunity_ids.length
      });
      
    } else if (action === 'unarchive') {
      // Unarchive opportunities
      const placeholders = opportunity_ids.map(() => '?').join(',');
      const query = `
        UPDATE funding_opportunities 
        SET archived = ${isPostgres ? 'FALSE' : '0'}, archived_at = NULL 
        WHERE id IN (${placeholders})
      `;
      
      req.db.prepare(query).run(...opportunity_ids);
      
      res.json({
        success: true,
        message: `Unarchived ${opportunity_ids.length} opportunities`,
        unarchived_count: opportunity_ids.length
      });
      
    } else if (action === 'list') {
      // List archived opportunities
      const query = `
        SELECT * FROM funding_opportunities 
        WHERE archived = ${isPostgres ? 'TRUE' : '1'} 
        ORDER BY archived_at DESC 
        LIMIT 100
      `;
      
      const archived = req.db.prepare(query).all();
      
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
    
    const profile = req.db
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
    
    const services = req.db.prepare(query).all(...params);
    
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
