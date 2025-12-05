import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { createSafeServer } from './_shared/safeHandler.js';
import {
  successResponse,
  errorResponse,
  requiresRepayment,
  isOpportunityActive,
  getStateAbbr,
  PROFILE_SECTIONS,
  extractSectionData,
  safeCrawler,
  extractAllProfileData
} from './_shared/crawlerFramework.js';

// ============================================================================
// COMPREHENSIVE MATCH - Section-Sequential AI-Enhanced Matching
// ============================================================================

function opportunityMatchesState(opp, profileStateAbbr) {
  if (!profileStateAbbr) return false;
  if (opp.is_national === true) return true;
  
  const oppState = getStateAbbr(opp.state);
  if (oppState && oppState !== profileStateAbbr) return false;
  
  const regions = (opp.regions || []).map(r => r.toLowerCase().trim());
  const statesInRegions = regions.filter(r => r.length === 2 && /^[a-z]{2}$/i.test(r));
  
  if (statesInRegions.length > 0 && !statesInRegions.includes(profileStateAbbr)) {
    return false;
  }
  
  return true;
}

// Section-specific keyword extraction for matching
function extractSectionKeywords(sectionName, sectionData) {
  const keywords = [];
  
  if (sectionName === 'identity') {
    if (sectionData.applicant_type) keywords.push(sectionData.applicant_type.replace(/_/g, ' '));
  } else if (sectionName === 'education') {
    if (sectionData.intended_major) keywords.push(sectionData.intended_major);
    if (sectionData.current_college) keywords.push(sectionData.current_college);
    if (sectionData.target_colleges) keywords.push(...sectionData.target_colleges);
    if (sectionData.first_generation) keywords.push('first generation');
  } else if (sectionName === 'military') {
    if (sectionData.veteran) keywords.push('veteran', 'military');
    if (sectionData.disabled_veteran) keywords.push('disabled veteran');
    if (sectionData.military_spouse) keywords.push('military spouse');
    if (sectionData.gold_star_family) keywords.push('gold star');
    if (sectionData.military_branch) keywords.push(sectionData.military_branch);
  } else if (sectionName === 'health') {
    if (sectionData.disabilities?.length) keywords.push('disability', 'disabled');
    if (sectionData.rare_disease) keywords.push('rare disease');
    if (sectionData.medicaid_enrolled) keywords.push('medicaid');
    if (sectionData.behavioral_health_smi) keywords.push('mental health');
  } else if (sectionName === 'financials') {
    if (sectionData.low_income) keywords.push('low income', 'need based');
    if (sectionData.snap_recipient) keywords.push('snap', 'food assistance');
    if (sectionData.ssi_recipient) keywords.push('ssi');
  } else if (sectionName === 'interests') {
    if (sectionData.keywords) keywords.push(...sectionData.keywords);
    if (sectionData.focus_areas) keywords.push(...sectionData.focus_areas);
    if (sectionData.program_areas) keywords.push(...sectionData.program_areas);
  } else if (sectionName === 'household') {
    if (sectionData.single_parent) keywords.push('single parent');
    if (sectionData.homeless) keywords.push('homeless', 'housing');
    if (sectionData.caregiver) keywords.push('caregiver');
  } else if (sectionName === 'goals') {
    if (sectionData.mission) {
      const words = sectionData.mission.split(/\s+/).filter(w => w.length > 4);
      keywords.push(...words.slice(0, 5));
    }
  }
  
  return keywords.map(k => k.toLowerCase());
}

function scoreOpportunityBySection(opp, profile) {
  const text = `${opp.title || ''} ${opp.descriptionMd || ''} ${opp.sponsor || ''}`.toLowerCase();
  const eligibility = (opp.eligibilityBullets || []).join(' ').toLowerCase();
  const combined = `${text} ${eligibility}`;
  
  let totalScore = 50; // Base score
  const matchedSections = [];
  const allReasons = [];
  
  const allProfileData = extractAllProfileData(profile);
  // Prepare a global keyword set from all profile fields to increase recall
  const profileText = Object.values(profile || {}).map(v => (typeof v === 'string' ? v : '')).join(' ').toLowerCase();
  const globalKeywords = new Set((profileText.match(/\b[a-zA-Z0-9_\-]{3,}\b/g) || []).map(x => x.toLowerCase()));

  for (const sectionName of PROFILE_SECTIONS) {
    const sectionData = allProfileData[sectionName] || extractSectionData(profile, sectionName);
    if (!sectionData) continue;
    
    const sectionKeywords = extractSectionKeywords(sectionName, sectionData);
    let sectionScore = 0;
    const sectionReasons = [];
    
    for (const keyword of sectionKeywords) {
      if (combined.includes(keyword)) {
        sectionScore += 10;
        sectionReasons.push(keyword);
        if (sectionScore >= 30) break; // Cap per section
      }
    }

    // Also check global keywords for the whole profile (not only section-specific)
    // Minor boost for global matches
    for (const kw of globalKeywords) {
      if (kw.length <= 3) continue;
      if (combined.includes(kw)) {
        sectionScore += 1; // small boost per keyword match
      }
    }
    
    if (sectionScore > 0) {
      totalScore += sectionScore;
      matchedSections.push(sectionName);
      allReasons.push(`${sectionName}: ${sectionReasons.join(', ')}`);
    }
  }
  
  return {
    score: Math.min(totalScore, 100),
    matchedSections,
    reasons: allReasons
  };
}

createSafeServer(async (req) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    
    let body = {};
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text);
    } catch (e) {
      return Response.json(errorResponse('INVALID_JSON'), { status: 400 });
    }
    
    const { profile_id, profile_data } = body;
    const effectiveProfileId = profile_id || profile_data?.id;
    
    if (!effectiveProfileId) {
      return Response.json(errorResponse('MISSING_PROFILE_ID'), { status: 400 });
    }
    
    let profile = profile_data;
    if (!profile || !profile.state) {
      try {
        profile = await sdk.entities.Organization.get(effectiveProfileId);
      } catch (e) {
        return Response.json(errorResponse('PROFILE_NOT_FOUND'), { status: 400 });
      }
    }
    
    if (profile.id !== effectiveProfileId) {
      console.error(`[${requestId}] ISOLATION_VIOLATION`);
      return Response.json(errorResponse('PROFILE_MISMATCH'), { status: 400 });
    }
    
    const profileStateAbbr = getStateAbbr(profile.state);
    if (!profileStateAbbr) {
      return Response.json(errorResponse('PROFILE_MISSING_STATE'), { status: 400 });
    }
    
    // Avoid logging PHI (profile name). Log the profile id only.
    console.log(`[${requestId}] ProfileID: ${profile.id}, State: ${profileStateAbbr}`);
    
    let opportunities = [];
    try {
      const [profileOpps, nationalOpps] = await Promise.all([
        sdk.entities.FundingOpportunity.filter({ profile_id: effectiveProfileId }),
        sdk.entities.FundingOpportunity.filter({ is_national: true })
      ]);
      
      const seen = new Set();
      for (const opp of [...profileOpps, ...nationalOpps]) {
        if (!seen.has(opp.id)) {
          seen.add(opp.id);
          opportunities.push(opp);
        }
      }
    } catch (e) {
      console.error(`[${requestId}] Fetch error:`, e.message);
      return Response.json(successResponse([]));
    }
    
    console.log(`[${requestId}] Fetched ${opportunities.length} opportunities`);
    
    let filtered = opportunities.filter(opp => opportunityMatchesState(opp, profileStateAbbr));
    console.log(`[${requestId}] After geo-filter: ${filtered.length}`);
    
    filtered = filtered.filter(opp => {
      const repaymentCheck = requiresRepayment(opp);
      if (repaymentCheck.requires) {
        // Avoid logging full title text, may contain sensitive info; log the opportunity id.
        console.log(`[${requestId}] REPAYMENT_REJECT: id=${opp.id}`);
        return false;
      }
      return true;
    });
    console.log(`[${requestId}] After repayment filter: ${filtered.length}`);
    
    filtered = filtered.filter(opp => isOpportunityActive(opp));
    console.log(`[${requestId}] After active filter: ${filtered.length}`);
    
    const scoredResults = filtered.map(opp => {
      const { score, matchedSections, reasons } = scoreOpportunityBySection(opp, profile);
      
      return {
        ...opp,
        match: score,
        matchReasons: ['Geographic match', 'No repayment required', ...reasons].slice(0, 6),
        matched_sections: matchedSections,
        _profile_id: effectiveProfileId
      };
    });
    
    const results = scoredResults
      .filter(r => r.match >= 50)
      .sort((a, b) => b.match - a.match)
      .slice(0, 100);
    
    console.log(`[${requestId}] Final results: ${results.length} opportunities`);
    
    try {
      await sdk.entities.CrawlLog.create({
        source: 'comprehensiveMatch',
        status: 'success'
      });
    } catch (logErr) {
      console.warn(`[${requestId}] Audit log failed:`, logErr.message);
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
        above_threshold: results.length,
        sections_available: PROFILE_SECTIONS.filter(s => extractSectionData(profile, s))
      }
    });
    
  } catch (error) {
    console.error(`[${requestId}] ERROR:`, error.message);
    return Response.json(errorResponse(error.message), { status: 500 });
  }
});