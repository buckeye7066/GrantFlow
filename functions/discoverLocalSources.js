import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { createSafeServer } from './_shared/safeHandler.js';
import {
  successResponse,
  errorResponse,
  requiresRepayment,
  getStateAbbr,
  isOpportunityActive,
  PROFILE_SECTIONS,
  extractSectionData,
  extractAllProfileData
} from './_shared/crawlerFramework.js';

// ============================================================================
// DISCOVER LOCAL SOURCES
// ============================================================================
// Discovers local funding opportunities based on an organization's profile.
//
// DEFENSIVE DESIGN:
// - Validates profile_id is present and valid before any operations.
// - Returns 400 with clear error codes for missing/invalid IDs (never a 500).
// - Returns 404 if profile does not exist in the database.
// - Gracefully handles edge cases: deleted profiles, race conditions, etc.
// ============================================================================

/**
 * Validates that a profile ID is present, non-empty, and has a valid UUID format.
 * Defensive guard clause: prevents operations on invalid/missing IDs.
 * @param {string|undefined|null} profileId - The profile ID to validate.
 * @returns {{ valid: boolean, error?: string }} Validation result.
 */
function validateProfileId(profileId) {
  if (!profileId) {
    return { valid: false, error: 'MISSING_PROFILE_ID' };
  }
  
  if (typeof profileId !== 'string') {
    return { valid: false, error: 'INVALID_PROFILE_ID_TYPE' };
  }
  
  const trimmedId = profileId.trim();
  if (trimmedId.length === 0) {
    return { valid: false, error: 'EMPTY_PROFILE_ID' };
  }
  
  // UUID format validation (standard UUID v4 pattern)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(trimmedId)) {
    return { valid: false, error: 'INVALID_PROFILE_ID_FORMAT' };
  }
  
  return { valid: true };
}

/**
 * Fetches and validates that a profile exists in the database.
 * Defensive guard clause: catches fetch errors and distinguishes 404 from 500.
 * @param {Object} sdk - The Base44 SDK instance.
 * @param {string} profileId - The profile ID to fetch.
 * @returns {Promise<{ profile?: Object, error?: string, status?: number }>}
 */
async function fetchProfile(sdk, profileId) {
  try {
    const profile = await sdk.entities.Organization.get(profileId);
    
    // Defensive: check that the returned profile actually exists and has data
    if (!profile) {
      return { error: 'PROFILE_NOT_FOUND', status: 404 };
    }
    
    // Defensive: ensure the fetched profile ID matches the requested ID
    // This guards against data integrity issues or SDK bugs
    if (profile.id !== profileId) {
      console.error(`[discoverLocalSources] Profile ID mismatch: requested ${profileId}, got ${profile.id}`);
      return { error: 'PROFILE_ID_MISMATCH', status: 400 };
    }
    
    return { profile };
  } catch (err) {
    // Defensive: distinguish between "not found" errors and other errors
    const message = err?.message?.toLowerCase() || '';
    if (message.includes('not found') || message.includes('404') || message.includes('does not exist')) {
      return { error: 'PROFILE_NOT_FOUND', status: 404 };
    }
    
    console.error(`[discoverLocalSources] Profile fetch error:`, err?.message);
    return { error: 'PROFILE_FETCH_FAILED', status: 500 };
  }
}

/**
 * Filters opportunities by geographic relevance to the profile's state.
 * @param {Array} opportunities - Array of funding opportunities.
 * @param {string} profileStateAbbr - The profile's state abbreviation.
 * @returns {Array} Filtered opportunities.
 */
function filterByGeography(opportunities, profileStateAbbr) {
  if (!profileStateAbbr) return opportunities;
  
  return opportunities.filter(opp => {
    // National opportunities are always relevant
    if (opp.is_national === true) return true;
    
    const oppState = getStateAbbr(opp.state);
    
    // If opportunity has a state, check it matches
    if (oppState && oppState !== profileStateAbbr) return false;
    
    // Check regional relevance
    const regions = (opp.regions || []).map(r => r.toLowerCase().trim());
    const statesInRegions = regions.filter(r => r.length === 2 && /^[a-z]{2}$/i.test(r));
    
    if (statesInRegions.length > 0 && !statesInRegions.includes(profileStateAbbr.toLowerCase())) {
      return false;
    }
    
    return true;
  });
}

/**
 * Scores opportunities based on profile matching.
 * Uses section-based keyword matching for better relevance.
 * @param {Object} opp - The opportunity to score.
 * @param {Object} profile - The organization profile.
 * @returns {{ score: number, reasons: Array<string> }}
 */
function scoreOpportunity(opp, profile) {
  const text = `${opp.title || ''} ${opp.descriptionMd || ''} ${opp.sponsor || ''}`.toLowerCase();
  const eligibility = (opp.eligibilityBullets || []).join(' ').toLowerCase();
  const combined = `${text} ${eligibility}`;
  
  let score = 50; // Base score
  const reasons = [];
  
  const allProfileData = extractAllProfileData(profile);
  
  for (const sectionName of PROFILE_SECTIONS) {
    const sectionData = allProfileData[sectionName] || extractSectionData(profile, sectionName);
    if (!sectionData) continue;
    
    // Extract keywords from section
    const sectionKeywords = Object.values(sectionData)
      .filter(v => typeof v === 'string')
      .flatMap(v => v.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    
    let sectionScore = 0;
    for (const keyword of sectionKeywords) {
      if (combined.includes(keyword)) {
        sectionScore += 5;
        if (sectionScore >= 20) break; // Cap per section
      }
    }
    
    if (sectionScore > 0) {
      score += sectionScore;
      reasons.push(sectionName);
    }
  }
  
  return { score: Math.min(score, 100), reasons };
}

createSafeServer(async (req) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  
  // ========================================================================
  // STEP 1: PARSE REQUEST BODY
  // Defensive: handle JSON parsing errors gracefully
  // ========================================================================
  let body = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch (e) {
    console.error(`[${requestId}] Invalid JSON in request body`);
    return Response.json(errorResponse('INVALID_JSON', 'Request body must be valid JSON'), { status: 400 });
  }
  
  const { profile_id, profile_data } = body;
  const effectiveProfileId = profile_id || profile_data?.id;
  
  // ========================================================================
  // STEP 2: VALIDATE PROFILE ID
  // Defensive: return 400 for missing/invalid IDs (never proceed without valid ID)
  // ========================================================================
  const validation = validateProfileId(effectiveProfileId);
  if (!validation.valid) {
    console.log(`[${requestId}] Profile ID validation failed: ${validation.error}`);
    return Response.json(errorResponse(validation.error), { status: 400 });
  }
  
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    
    // ======================================================================
    // STEP 3: FETCH AND VALIDATE PROFILE EXISTS
    // Defensive: return 404 if profile doesn't exist (not 500)
    // ======================================================================
    let profile = profile_data;
    if (!profile || !profile.state) {
      const fetchResult = await fetchProfile(sdk, effectiveProfileId);
      
      if (fetchResult.error) {
        console.log(`[${requestId}] Profile fetch failed: ${fetchResult.error}`);
        return Response.json(errorResponse(fetchResult.error), { status: fetchResult.status || 400 });
      }
      
      profile = fetchResult.profile;
    }
    
    // Defensive: double-check profile validity after fetch
    if (!profile || !profile.id) {
      console.log(`[${requestId}] Profile is null or missing ID after fetch`);
      return Response.json(errorResponse('PROFILE_NOT_FOUND'), { status: 404 });
    }
    
    // ======================================================================
    // STEP 4: VALIDATE PROFILE STATE
    // Defensive: ensure profile has required geographic data
    // ======================================================================
    const profileStateAbbr = getStateAbbr(profile.state);
    if (!profileStateAbbr) {
      console.log(`[${requestId}] Profile missing state: ${profile.id}`);
      return Response.json(errorResponse('PROFILE_MISSING_STATE'), { status: 400 });
    }
    
    console.log(`[${requestId}] Discovering local sources for profile ${profile.id}, state: ${profileStateAbbr}`);
    
    // ======================================================================
    // STEP 5: FETCH LOCAL OPPORTUNITIES
    // ======================================================================
    let opportunities = [];
    try {
      // Fetch opportunities for this profile's state
      const stateOpps = await sdk.entities.FundingOpportunity.filter({ state: profileStateAbbr });
      const nationalOpps = await sdk.entities.FundingOpportunity.filter({ is_national: true });
      
      // Deduplicate
      const seen = new Set();
      for (const opp of [...stateOpps, ...nationalOpps]) {
        if (!seen.has(opp.id)) {
          seen.add(opp.id);
          opportunities.push(opp);
        }
      }
    } catch (e) {
      console.error(`[${requestId}] Failed to fetch opportunities:`, e?.message);
      // Defensive: return empty results rather than 500 for fetch failures
      return Response.json(successResponse([], 'No opportunities found'));
    }
    
    console.log(`[${requestId}] Fetched ${opportunities.length} opportunities`);
    
    // ======================================================================
    // STEP 6: FILTER OPPORTUNITIES
    // ======================================================================
    
    // Filter by geography
    let filtered = filterByGeography(opportunities, profileStateAbbr);
    console.log(`[${requestId}] After geo-filter: ${filtered.length}`);
    
    // Filter out repayment-required opportunities (loans)
    filtered = filtered.filter(opp => {
      const repaymentCheck = requiresRepayment(opp);
      if (repaymentCheck.requires) {
        console.log(`[${requestId}] Excluding loan opportunity: ${opp.id}`);
        return false;
      }
      return true;
    });
    console.log(`[${requestId}] After repayment filter: ${filtered.length}`);
    
    // Filter by active status
    filtered = filtered.filter(opp => isOpportunityActive(opp));
    console.log(`[${requestId}] After active filter: ${filtered.length}`);
    
    // ======================================================================
    // STEP 7: SCORE AND RANK OPPORTUNITIES
    // ======================================================================
    const scoredResults = filtered.map(opp => {
      const { score, reasons } = scoreOpportunity(opp, profile);
      return {
        ...opp,
        match: score,
        matchReasons: ['Local/geographic match', ...reasons].slice(0, 6),
        _profile_id: effectiveProfileId
      };
    });
    
    // Return top matches
    const results = scoredResults
      .filter(r => r.match >= 50)
      .sort((a, b) => b.match - a.match)
      .slice(0, 100);
    
    console.log(`[${requestId}] Returning ${results.length} matched opportunities`);
    
    // ======================================================================
    // STEP 8: AUDIT LOG
    // ======================================================================
    try {
      await sdk.entities.CrawlLog.create({
        source: 'discoverLocalSources',
        status: 'success',
        results_count: results.length,
        profile_id: effectiveProfileId
      });
    } catch (logErr) {
      console.warn(`[${requestId}] Audit log failed:`, logErr?.message);
    }
    
    return Response.json({
      success: true,
      opportunities: results,
      count: results.length,
      analyzed: opportunities.length,
      errors: [],
      profile: {
        id: profile.id,
        name: profile.name,
        state: profileStateAbbr
      },
      metadata: {
        total_fetched: opportunities.length,
        passed_all_filters: filtered.length,
        above_threshold: results.length
      }
    });
    
  } catch (error) {
    // Defensive: catch-all for unexpected errors
    console.error(`[${requestId}] Unexpected error:`, error?.message);
    return Response.json(errorResponse('INTERNAL_ERROR', error?.message), { status: 500 });
  }
}, { name: 'discoverLocalSources' });