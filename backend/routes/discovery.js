import express from 'express';

const router = express.Router();

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

    // Get profile from database if profile_id is provided
    let profile = profile_json;
    if (typeof profile_json === 'string') {
      const profileRow = req.db
        .prepare('SELECT * FROM profiles WHERE id = ?')
        .get(profile_json);
      
      if (!profileRow) {
        return res.status(404).json({
          success: false,
          error: 'Profile not found'
        });
      }
      
      profile = profileRow;
    }

    // Extract search criteria from profile
    const searchKeywords = [];
    const profileStates = states.length > 0 ? states : [profile.state].filter(Boolean);
    
    // Build search query based on profile characteristics
    const conditions = [];
    const params = [];
    
    // State filtering
    if (profileStates.length > 0) {
      const statePlaceholders = profileStates.map(() => '?').join(',');
      conditions.push(`(state IN (${statePlaceholders}) OR state IS NULL OR state = 'nationwide')`);
      params.push(...profileStates);
    }
    
    // Freshness filter
    if (freshness_days > 0) {
      conditions.push(`(deadline IS NULL OR deadline >= date('now', '-' || ? || ' days'))`);
      params.push(freshness_days);
    }
    
    // Build the query
    let query = 'SELECT * FROM funding_opportunities';
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY RANDOM() LIMIT 100';
    
    const opportunities = req.db.prepare(query).all(...params);
    
    // Calculate fit scores for each opportunity
    const scoredOpportunities = opportunities.map(opp => {
      let fit_score = 50; // Base score
      
      // Increase score based on profile matching
      if (profile.organization_type && opp.eligibility_bullets) {
        try {
          const eligibility = JSON.parse(opp.eligibility_bullets || '[]');
          if (eligibility.some(e => e.toLowerCase().includes(profile.organization_type.toLowerCase()))) {
            fit_score += 20;
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
      
      // State match bonus
      if (profileStates.includes(opp.state)) {
        fit_score += 15;
      }
      
      // Recent deadline bonus
      if (opp.deadline) {
        const daysUntilDeadline = Math.floor((new Date(opp.deadline) - new Date()) / (1000 * 60 * 60 * 24));
        if (daysUntilDeadline > 30 && daysUntilDeadline < 90) {
          fit_score += 10;
        }
      }
      
      fit_score = Math.min(100, fit_score);
      
      return {
        program_name: opp.title || opp.program_name,
        sponsor: opp.sponsor || opp.funder,
        url: opp.url || opp.application_url,
        deadline: opp.deadline,
        amount_min: opp.award_floor || opp.min_award,
        amount_max: opp.award_ceiling || opp.max_award,
        description: opp.description || opp.summary,
        eligibility_summary: Array.isArray(opp.eligibility_bullets) 
          ? opp.eligibility_bullets.join('; ')
          : (opp.eligibility_bullets || ''),
        fit_score,
        matched_fields: ['location', 'organization_type']
      };
    });
    
    // Filter to only return high-scoring opportunities
    const highScoring = scoredOpportunities.filter(o => o.fit_score >= 50);
    
    res.json({
      success: true,
      opportunities: highScoring,
      total: highScoring.length,
      page
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
    
    // Profile-based filtering
    if (profile_id) {
      const profile = req.db
        .prepare('SELECT * FROM profiles WHERE id = ?')
        .get(profile_id);
      
      if (profile && profile.state) {
        conditions.push(`(state = ? OR state IS NULL OR state = 'nationwide')`);
        params.push(profile.state);
      }
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
      conditions.push('(award_ceiling IS NULL OR award_ceiling >= ?)');
      params.push(filters.min_award);
    }
    
    if (filters.max_award) {
      conditions.push('(award_floor IS NULL OR award_floor <= ?)');
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
    const { total } = req.db.prepare(countQuery).get(...countParams);
    
    // Format results
    const results = opportunities.map(opp => ({
      id: opp.id,
      title: opp.title || opp.program_name,
      sponsor: opp.sponsor || opp.funder,
      url: opp.url || opp.application_url,
      deadline: opp.deadline,
      award_min: opp.award_floor || opp.min_award,
      award_max: opp.award_ceiling || opp.max_award,
      description: opp.description || opp.summary,
      state: opp.state,
      source: opp.source || 'database',
      eligibility: opp.eligibility_bullets
    }));
    
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
      const query = `
        UPDATE funding_opportunities 
        SET archived = 1, archived_at = CURRENT_TIMESTAMP 
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
        SET archived = 0, archived_at = NULL 
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
        WHERE archived = 1 
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
    const conditions = ['source = ?'];
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
