import express from 'express';
import { ensureProfileAccess, isAdminUser, requireAuthenticatedUser } from '../utils/accessControl.js'

const router = express.Router();

// Discovery endpoints can reference stored profiles; require auth globally.
router.use((req, res, next) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  return next()
})

/**
 * Extract all demographic signals from profile, organization, and sections
 * Returns an object with all matchable attributes
 */
function buildDemographicSignals(profile, organization, sections) {
  const signals = {
    keywords: new Set(),
    demographics: new Set(),
    assistance: new Set(),
    military: new Set(),
    education: new Set(),
    health: new Set(),
    family: new Set(),
    location: new Set(),
    financial: new Set()
  };
  
  // Add profile tags
  try {
    const tags = typeof profile.tags === 'string' ? JSON.parse(profile.tags) : (profile.tags || []);
    tags.forEach(t => signals.keywords.add(t.toLowerCase()));
  } catch (e) { /* ignore */ }
  
  // Add profile primary_type
  if (profile.primary_type) {
    signals.keywords.add(profile.primary_type.toLowerCase().replace(/_/g, ' '));
  }

  // Organization demographics
  if (organization) {
    if (organization.applicant_type) signals.demographics.add(organization.applicant_type.replace(/_/g, ' '));
    if (organization.veteran) { signals.military.add('veteran'); signals.keywords.add('veteran'); }
    if (organization.disabled_veteran) { signals.military.add('disabled veteran'); signals.keywords.add('disabled veteran'); }
    if (organization.military_spouse) { signals.military.add('military spouse'); signals.keywords.add('military spouse'); }
    if (organization.gold_star_family) { signals.military.add('gold star family'); signals.keywords.add('gold star'); }
    if (organization.military_branch) signals.military.add(organization.military_branch.toLowerCase());
    
    if (organization.single_parent) { signals.family.add('single parent'); signals.keywords.add('single parent'); }
    if (organization.homeless) { signals.family.add('homeless'); signals.keywords.add('homeless'); }
    if (organization.foster_care) { signals.family.add('foster care'); signals.keywords.add('foster'); }
    if (organization.first_generation) { signals.education.add('first generation'); signals.keywords.add('first generation'); }
    
    if (organization.ssi_recipient) { signals.assistance.add('ssi'); signals.keywords.add('ssi'); }
    if (organization.ssdi_recipient) { signals.assistance.add('ssdi'); signals.keywords.add('ssdi'); }
    if (organization.snap_recipient) { signals.assistance.add('snap'); signals.keywords.add('snap'); signals.keywords.add('food assistance'); }
    if (organization.tanf_recipient) { signals.assistance.add('tanf'); signals.keywords.add('tanf'); }
    if (organization.medicaid_enrolled) { signals.assistance.add('medicaid'); signals.keywords.add('medicaid'); }
    if (organization.medicare_recipient) { signals.assistance.add('medicare'); signals.keywords.add('medicare'); }
    if (organization.section8_housing) { signals.assistance.add('section 8'); signals.keywords.add('housing assistance'); }
    
    if (organization.rare_disease) { signals.health.add('rare disease'); signals.keywords.add('rare disease'); }
    
    // Parse JSON arrays
    try {
      const disabilities = JSON.parse(organization.disabilities || '[]');
      disabilities.forEach(d => { signals.health.add(d.toLowerCase()); signals.keywords.add(d.toLowerCase()); });
    } catch (e) { /* ignore */ }
    
    try {
      const assistance = JSON.parse(organization.government_assistance || '[]');
      assistance.forEach(a => { signals.assistance.add(a.toLowerCase()); signals.keywords.add(a.toLowerCase()); });
    } catch (e) { /* ignore */ }
    
    try {
      const keywords = JSON.parse(organization.keywords || '[]');
      keywords.forEach(k => signals.keywords.add(k.toLowerCase()));
    } catch (e) { /* ignore */ }
    
    try {
      const focusAreas = JSON.parse(organization.focus_areas || '[]');
      focusAreas.forEach(f => signals.keywords.add(f.toLowerCase()));
    } catch (e) { /* ignore */ }
    
    // Financial indicators
    if (organization.household_income && organization.household_income < 50000) {
      signals.financial.add('low income');
      signals.keywords.add('low income');
    }
    
    // Age-based signals
    if (organization.age) {
      if (organization.age < 25) { signals.demographics.add('youth'); signals.keywords.add('youth'); signals.keywords.add('young adult'); }
      if (organization.age >= 55) { signals.demographics.add('senior'); signals.keywords.add('senior'); signals.keywords.add('elderly'); }
    }
    
    // Location
    if (organization.state) signals.location.add(organization.state.toLowerCase());
    if (organization.city) signals.location.add(organization.city.toLowerCase());
    if (organization.zip) signals.location.add(organization.zip);
  }

  // Profile sections data
  if (sections.demographics) {
    const demo = sections.demographics;
    if (demo.hispanic_latino) { signals.demographics.add('hispanic'); signals.demographics.add('latino'); signals.keywords.add('hispanic'); signals.keywords.add('latino'); }
    if (demo.african_american || demo.black) { signals.demographics.add('african american'); signals.keywords.add('african american'); }
    if (demo.asian) { signals.demographics.add('asian'); signals.keywords.add('asian'); }
    if (demo.native_american || demo.indigenous) { signals.demographics.add('native american'); signals.demographics.add('indigenous'); signals.keywords.add('indigenous'); }
    if (demo.pacific_islander) { signals.demographics.add('pacific islander'); signals.keywords.add('pacific islander'); }
    if (demo.female || demo.woman) { signals.demographics.add('women'); signals.keywords.add('women'); }
    if (demo.lgbtq) { signals.demographics.add('lgbtq'); signals.keywords.add('lgbtq'); }
  }

  if (sections.family_life) {
    const fam = sections.family_life;
    if (fam.family_caregiver || fam.caregiver) { signals.family.add('caregiver'); signals.keywords.add('caregiver'); }
    if (fam.single_parent) { signals.family.add('single parent'); signals.keywords.add('single parent'); }
    if (fam.first_time_parent) { signals.family.add('new parent'); signals.keywords.add('new parent'); }
    if (fam.domestic_violence_survivor) { signals.family.add('domestic violence survivor'); signals.keywords.add('domestic violence'); }
    if (fam.child_count && fam.child_count > 0) { signals.family.add('family with children'); signals.keywords.add('children'); }
  }

  if (sections.location_focus) {
    const loc = sections.location_focus;
    if (loc.appalachian_region) { signals.location.add('appalachian'); signals.keywords.add('appalachian'); signals.keywords.add('appalachia'); }
    if (loc.rural_area) { signals.location.add('rural'); signals.keywords.add('rural'); }
    if (loc.urban_area) { signals.location.add('urban'); signals.keywords.add('urban'); }
    if (loc.geographic_focus) signals.keywords.add(loc.geographic_focus.toLowerCase());
  }

  if (sections.financial_information) {
    const fin = sections.financial_information;
    if (fin.financial_need_level === 'High' || fin.financial_need_level === 'Critical') {
      signals.financial.add('high need');
      signals.keywords.add('financial hardship');
    }
    if (fin.household_income && fin.household_income < 50000) {
      signals.financial.add('low income');
      signals.keywords.add('low income');
    }
  }

  if (sections.health_disabilities) {
    const health = sections.health_disabilities;
    if (health.disability) { signals.health.add('disability'); signals.keywords.add('disability'); }
    if (health.chronic_illness) { signals.health.add('chronic illness'); signals.keywords.add('chronic'); }
    if (health.mental_health) { signals.health.add('mental health'); signals.keywords.add('mental health'); }
    if (health.epilepsy) { signals.health.add('epilepsy'); signals.keywords.add('epilepsy'); }
  }

  if (sections.education) {
    const edu = sections.education;
    if (edu.first_generation) { signals.education.add('first generation'); signals.keywords.add('first generation'); }
    if (edu.current_student) { signals.education.add('student'); signals.keywords.add('student'); }
    if (edu.intended_major) signals.keywords.add(edu.intended_major.toLowerCase());
  }

  if (sections.organization_details) {
    const org = sections.organization_details;
    if (org.organization_type) signals.keywords.add(org.organization_type.toLowerCase());
    if (org.mission) {
      // Extract key terms from mission
      const missionTerms = ['wellness', 'health', 'education', 'community', 'youth', 'senior', 
        'disability', 'veteran', 'faith', 'ministry', 'nonprofit', 'food', 'housing'];
      missionTerms.forEach(term => {
        if (org.mission.toLowerCase().includes(term)) {
          signals.keywords.add(term);
        }
      });
    }
  }

  if (sections.narrative) {
    const narr = sections.narrative;
    if (narr.primary_goal) {
      const goalTerms = ['expand', 'health', 'wellness', 'community', 'services', 'equipment', 
        'training', 'education', 'housing', 'food', 'assistance'];
      goalTerms.forEach(term => {
        if (narr.primary_goal.toLowerCase().includes(term)) {
          signals.keywords.add(term);
        }
      });
    }
  }

  // Military service section (important for veterans)
  if (sections.military_service) {
    const mil = sections.military_service;
    if (mil.veteran) { signals.military.add('veteran'); signals.keywords.add('veteran'); }
    if (mil.disabled_veteran) { signals.military.add('disabled veteran'); signals.keywords.add('disabled veteran'); }
    if (mil.military_spouse) { signals.military.add('military spouse'); signals.keywords.add('military spouse'); }
    if (mil.gold_star_family) { signals.military.add('gold star'); signals.keywords.add('gold star'); }
    if (mil.military_branch) signals.military.add(mil.military_branch.toLowerCase());
  }

  // Health/medical section
  if (sections.health_medical) {
    const health = sections.health_medical;
    if (health.disability) { signals.health.add('disability'); signals.keywords.add('disability'); }
    if (health.chronic_illness) { signals.health.add('chronic illness'); signals.keywords.add('chronic'); }
    if (health.mental_health) { signals.health.add('mental health'); signals.keywords.add('mental health'); }
  }

  // Occupation section
  if (sections.occupation) {
    const occ = sections.occupation;
    if (occ.public_servant) { signals.keywords.add('public servant'); }
    if (occ.nonprofit_employee) { signals.keywords.add('nonprofit'); }
    if (occ.small_business_owner) { signals.keywords.add('small business'); }
  }

  return signals;
}

/**
 * Calculate match score between profile signals and opportunity
 * ENHANCED: Uses ALL profile data points for comprehensive matching
 * Scoring designed to achieve 80%+ matches for well-aligned opportunities
 */
function calculateMatchScore(signals, opp) {
  let score = 40; // Start at 40% base - must earn the rest
  const matchedFields = [];
  let matchStrength = 0; // Track how many categories match
  
  // Parse opportunity keywords and categories
  let oppKeywords = [];
  let oppCategories = [];
  let eligibility = [];
  
  try { oppKeywords = JSON.parse(opp.keywords || '[]'); } catch (e) { /* ignore */ }
  try { oppCategories = JSON.parse(opp.categories || '[]'); } catch (e) { /* ignore */ }
  try { eligibility = JSON.parse(opp.eligibility_bullets || '[]'); } catch (e) { /* ignore */ }
  
  // Combine all opportunity terms for matching
  const oppTerms = new Set([
    ...oppKeywords.map(k => k.toLowerCase()),
    ...oppCategories.map(c => c.toLowerCase()),
    ...eligibility.map(e => e.toLowerCase())
  ]);
  
  // Also check opportunity title and description
  const oppText = `${opp.title || ''} ${opp.description || ''}`.toLowerCase();
  
  // Keyword matching (up to 30 points) - INCREASED
  let keywordMatches = 0;
  signals.keywords.forEach(keyword => {
    // Check in structured terms
    for (const term of oppTerms) {
      if (term.includes(keyword) || keyword.includes(term)) {
        keywordMatches++;
        matchedFields.push(keyword);
        break;
      }
    }
    // Also check in title/description for bonus
    if (oppText.includes(keyword)) {
      keywordMatches += 0.5;
    }
  });
  score += Math.min(30, Math.floor(keywordMatches * 5));
  
  // Demographic matching (up to 15 points)
  let demoMatches = 0;
  signals.demographics.forEach(demo => {
    for (const term of oppTerms) {
      if (term.includes(demo) || demo.includes(term)) {
        demoMatches++;
        matchedFields.push('demographic: ' + demo);
        break;
      }
    }
  });
  score += Math.min(15, demoMatches * 5);
  
  // Military status matching (up to 20 points) - INCREASED significantly
  if (signals.military.size > 0) {
    let militaryScore = 0;
    signals.military.forEach(mil => {
      for (const term of oppTerms) {
        if (term.includes(mil) || mil.includes(term) || oppText.includes(mil)) {
          militaryScore += 7;
          matchedFields.push('military: ' + mil);
          break;
        }
      }
    });
    score += Math.min(20, militaryScore);
  }
  
  // Faith-based/ministry matching (up to 15 points) - NEW
  const faithTerms = ['faith-based', 'faith', 'ministry', 'missions', 'religious', 'church'];
  let faithMatches = 0;
  faithTerms.forEach(ft => {
    if (signals.keywords.has(ft)) {
      for (const term of oppTerms) {
        if (term.includes(ft) || ft.includes(term)) {
          faithMatches++;
          matchedFields.push('faith: ' + ft);
          break;
        }
      }
    }
  });
  score += Math.min(15, faithMatches * 5);
  
  // Assistance program matching (up to 10 points)
  let assistMatches = 0;
  signals.assistance.forEach(assist => {
    for (const term of oppTerms) {
      if (term.includes(assist) || assist.includes(term)) {
        assistMatches++;
        matchedFields.push('assistance: ' + assist);
        break;
      }
    }
  });
  score += Math.min(10, assistMatches * 5);
  
  // Family situation matching (up to 10 points)
  let familyMatches = 0;
  signals.family.forEach(fam => {
    for (const term of oppTerms) {
      if (term.includes(fam) || fam.includes(term)) {
        familyMatches++;
        matchedFields.push('family: ' + fam);
        break;
      }
    }
  });
  score += Math.min(10, familyMatches * 5);
  
  // Health/disability matching (up to 15 points) - INCREASED
  let healthMatches = 0;
  signals.health.forEach(h => {
    for (const term of oppTerms) {
      if (term.includes(h) || h.includes(term)) {
        healthMatches++;
        matchedFields.push('health: ' + h);
        break;
      }
    }
    // Also check description
    if (oppText.includes(h)) {
      healthMatches += 0.5;
    }
  });
  score += Math.min(15, Math.floor(healthMatches * 5));
  
  // Location matching (up to 10 points) - INCREASED
  if (opp.state) {
    for (const loc of signals.location) {
      if (opp.state.toLowerCase() === loc || (opp.description && opp.description.toLowerCase().includes(loc))) {
        score += 10;
        matchedFields.push('location: ' + loc);
        matchStrength++;
        break;
      }
    }
  }
  
  // Education level matching (up to 10 points)
  if (signals.education && signals.education.size > 0) {
    signals.education.forEach(edu => {
      for (const term of oppTerms) {
        if (term.includes(edu) || edu.includes(term) || oppText.includes(edu)) {
          score += 5;
          matchedFields.push('education: ' + edu);
          matchStrength++;
          break;
        }
      }
    });
  }
  
  // Financial need matching (up to 10 points)
  if (signals.financial && signals.financial.size > 0) {
    signals.financial.forEach(fin => {
      for (const term of oppTerms) {
        if (term.includes(fin) || fin.includes(term) || oppText.includes(fin)) {
          score += 5;
          matchedFields.push('financial: ' + fin);
          matchStrength++;
          break;
        }
      }
    });
  }
  
  // BONUS: Multiple category matches (up to 15 points)
  // If matching in 3+ categories, likely a strong fit
  if (matchStrength >= 5) {
    score += 15;
    matchedFields.push('strong multi-category match');
  } else if (matchStrength >= 3) {
    score += 10;
    matchedFields.push('good multi-category match');
  } else if (matchStrength >= 2) {
    score += 5;
  }
  
  return { score: Math.min(100, score), matchedFields };
}

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

    // Get profile from database if profile_id is provided
    let profile = profile_json;
    if (typeof profile_json === 'string') {
      if (!(await ensureProfileAccess(req, res, profile_json))) return
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
    } else if (!isAdminUser(user)) {
      // Prevent non-admin callers from submitting arbitrary profile JSON blobs that could be
      // confused with stored profiles in downstream code.
      return res.status(403).json({
        success: false,
        error: 'Non-admin requests must provide a profile_id string',
      })
    }

    // Fetch linked organization for demographic data
    let organization = null;
    if (profile.organization_id) {
      organization = req.db
        .prepare('SELECT * FROM organizations WHERE id = ?')
        .get(profile.organization_id);
    }

    // Fetch all profile sections for detailed data
    const profileSections = {};
    const sectionRows = req.db
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(profile.id);
    
    sectionRows.forEach(row => {
      try {
        profileSections[row.section_key] = JSON.parse(row.data || '{}');
      } catch (e) {
        profileSections[row.section_key] = {};
      }
    });

    // Build comprehensive demographic signals from all sources
    const demographicSignals = buildDemographicSignals(profile, organization, profileSections);

    // Extract search criteria from profile
    const searchKeywords = [];
    const profileStates = states.length > 0 ? states : 
      [organization?.state, profileSections?.location_focus?.state].filter(Boolean);
    
    // Build search query based on profile characteristics
    const conditions = [];
    const params = [];
    
    // Exclude fake/synthetic sources
    conditions.push(`(source IS NULL OR source NOT IN ('comprehensive_crawler', 'synthetic', 'template', 'fake'))`);
    
    const isPostgres = req.db?.dialect === 'postgres'

    // Exclude opportunities that require matching funds
    conditions.push(
      isPostgres
        ? '(requires_match IS NULL OR requires_match = FALSE)'
        : '(requires_match = 0 OR requires_match IS NULL)',
    );
    
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
    
    // Build the query
    let query =
      req.db?.dialect === 'postgres'
        ? 'SELECT * FROM funding_opportunities WHERE is_active = TRUE'
        : 'SELECT * FROM funding_opportunities WHERE is_active = 1';
    if (conditions.length > 0) {
      query += ' AND ' + conditions.join(' AND ');
    }
    query += ' ORDER BY RANDOM() LIMIT 100';
    
    const opportunities = await req.db.prepare(query).all(...params);
    
    console.log(`[comprehensiveMatch] Query found ${opportunities.length} opportunities`);
    console.log(`[comprehensiveMatch] Profile signals:`, JSON.stringify({
      keywords: [...demographicSignals.keywords].slice(0, 15),
      military: [...demographicSignals.military],
      health: [...demographicSignals.health],
      family: [...demographicSignals.family]
    }));
    
    // Calculate fit scores for each opportunity using comprehensive demographic signals
    const scoredOpportunities = opportunities.map(opp => {
      // Use the new comprehensive scoring function
      const { score: fit_score, matchedFields } = calculateMatchScore(demographicSignals, opp);
      
      // Filter out placeholder URLs
      let url = opp.url || opp.application_url;
      if (url && (url.includes('example.org') || url.includes('example.com') || url.includes('placeholder'))) {
        url = null;
      }
      
      return {
        id: opp.id,
        source_id: opp.source_id,
        program_name: opp.title || opp.program_name,
        sponsor: opp.sponsor || opp.funder,
        url: url,
        deadline: opp.deadline,
        amount_min: opp.award_floor || opp.amount_min,
        amount_max: opp.award_ceiling || opp.amount_max,
        description: opp.description || opp.summary,
        eligibility_summary: Array.isArray(opp.eligibility_bullets) 
          ? opp.eligibility_bullets.join('; ')
          : (opp.eligibility_bullets || ''),
        fit_score,
        matched_fields: matchedFields.slice(0, 10) // Return top 10 matched fields
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
    
    // Filter opportunities - lowered threshold to 60% for better results
    // Veterans, disabled, and single parents should match many opportunities
    const matchThreshold = 60;
    const highScoring = scoredOpportunities
      .filter(o => o.fit_score >= matchThreshold)
      .sort((a, b) => b.fit_score - a.fit_score);
    
    res.json({
      success: true,
      opportunities: highScoring,
      total: highScoring.length,
      page,
      threshold_used: matchThreshold,
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
    
    // Profile-based filtering
    if (profile_id) {
      if (!(await ensureProfileAccess(req, res, String(profile_id)))) return
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
    
    const opportunities = await req.db.prepare(query).all(...params);
    
    // Count total for pagination
    let countQuery = 'SELECT COUNT(*) as total FROM funding_opportunities';
    if (conditions.length > 0) {
      countQuery += ' WHERE ' + conditions.join(' AND ');
    }
    const countParams = params.slice(0, -2); // Remove LIMIT and OFFSET params
    const countRow = await req.db.prepare(countQuery).get(...countParams);
    const total = Number(countRow?.total ?? 0) || 0;
    
    // Format results
    const results = (opportunities || []).map(opp => {
      // Filter out placeholder URLs
      let url = opp.url || opp.application_url;
      if (url && (url.includes('example.org') || url.includes('example.com') || url.includes('placeholder'))) {
        url = null;
      }
      
      return {
        id: opp.id,
        title: opp.title || opp.program_name,
        sponsor: opp.sponsor || opp.funder,
        url: url,
        deadline: opp.deadline,
      award_min: opp.award_floor || opp.min_award,
      award_max: opp.award_ceiling || opp.max_award,
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
      const query = `
        UPDATE funding_opportunities 
        SET archived = 1, archived_at = CURRENT_TIMESTAMP 
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
      const query = `
        UPDATE funding_opportunities 
        SET archived = 0, archived_at = NULL 
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
