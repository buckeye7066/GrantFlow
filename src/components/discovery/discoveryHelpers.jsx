import client from '@/api/client';
import { createLogger } from "@/utils/logger";
import { isRenderableUrl } from '@/lib/matchDisplayThresholds';

/**
 * Helper functions for discovery operations
 */

/**
 * Run comprehensive AI match search
 */
function extractStateList(selectedOrg) {
  if (!selectedOrg || typeof selectedOrg !== "object") {
    return []
  }

  const candidates = new Set()

  // Legacy top-level fields
  if (selectedOrg.state) {
    candidates.add(selectedOrg.state)
  }
  if (selectedOrg.states && Array.isArray(selectedOrg.states)) {
    selectedOrg.states.filter(Boolean).forEach((value) => candidates.add(value))
  }

  // Signals (if enriched)
  const signalState = selectedOrg?.signals?.location?.state
  if (signalState) {
    candidates.add(signalState)
  }

  // Profile sections
  const sections = Array.isArray(selectedOrg.sections) ? selectedOrg.sections : []
  const locationSection = sections.find((section) => section?.section_key === "location_focus")
  if (locationSection?.data) {
    const sectionState = locationSection.data.state || locationSection.data.primary_state
    if (sectionState) {
      candidates.add(sectionState)
    }
    const regions = locationSection.data.regions
    if (Array.isArray(regions)) {
      regions.filter(Boolean).forEach((value) => candidates.add(value))
    }
  }

  // Basic information fallback
  const basicSection = sections.find((section) => section?.section_key === "basic_information")
  if (basicSection?.data?.state) {
    candidates.add(basicSection.data.state)
  }

  return Array.from(candidates).filter(Boolean)
}

export async function runComprehensiveMatch(selectedOrg, searchFilters) {
  const log = createLogger('runComprehensiveMatch')
  log.debug('starting comprehensive search')
  if (!selectedOrg) {
    throw new Error('Profile data is required to run comprehensive match.')
  }

  const selectedProfileId = selectedOrg?.id || selectedOrg?.profile_id
  if (!selectedProfileId) {
    throw new Error('Profile id is required so discovery can use Crawler OS profile matches.')
  }

  const stateList = extractStateList(selectedOrg)
  
  const response = await client.functions.invoke('comprehensiveMatch', {
    profile_json: selectedProfileId,
    states: stateList,
    page: 1,
    freshness_days: 60
  });

  if (!response?.success) {
    throw new Error(response?.error || 'Comprehensive match failed');
  }

  // Convert comprehensive match format to standard format
  const allOpportunities = (response.opportunities || []).map(opp => ({
    id: opp.id,
    source_id: opp.source_id,
    title: opp.program_name || opp.title,
    sponsor: opp.sponsor,
    url: (() => {
      const raw = opp.url;
      if (!isRenderableUrl(raw)) {
        if (raw) log.warn('placeholder URL rejected', { id: opp.id, title: opp.program_name, url: raw });
        return null;
      }
      return raw;
    })(),
    application_url: (() => {
      const appUrl = opp.application_url || opp.url;
      if (!isRenderableUrl(appUrl)) {
        if (appUrl) log.warn('placeholder application_url rejected', { id: opp.id, title: opp.program_name, application_url: appUrl });
        return null;
      }
      return appUrl;
    })(),
    deadlineAt: opp.deadline,
    awardMin: opp.amount_min,
    awardMax: opp.amount_max,
    amount_description: opp.amount_description,
    descriptionMd: opp.description || opp.summary,
    eligibilityBullets:
      typeof opp.eligibility_summary === 'string'
        ? opp.eligibility_summary.split('; ').filter(Boolean)
        : [],
    match: opp.fit_score || opp.match_score || 0,
    match_score: opp.fit_score || opp.match_score || 0,
    source: opp.source || 'comprehensive_match',
    matched_fields: opp.matched_fields || []
  }));

  // Return ALL opportunities from the backend â the decision engine (computeMatchDecision)
  // is the sole acceptance authority (Goal 4). Suppressing by score here would override
  // canonical ACCEPT/REVIEW decisions and hide results from the user (Goals 7, 8).
  // UI layers may sort or visually tier by match_score but must never hard-drop records.
  const suppressed = allOpportunities.filter(opp => {
    const matchScore = typeof opp.match === 'number' ? opp.match : 0;
    return matchScore < 80;
  });

  if (suppressed.length > 0) {
    log.debug('low-score opportunities retained (not suppressed) â decision engine is authority', {
      total: allOpportunities.length,
      below_80: suppressed.length,
      titles: suppressed.map(o => o.title),
    });
  }

  return {
    opportunities: allOpportunities,
    count: allOpportunities.length,
    message: `Found ${allOpportunities.length} matching opportunities. Sorted by relevance.`
  };
}

/**
 * Run ECF CHOICES service discovery
 */
export async function runECFServiceSearch(selectedOrgId, queryClient) {
  const log = createLogger('runECFServiceSearch')
  log.debug('starting ECF service discovery')
  
  // First, invoke the ECF discovery function
  const discoverResponse = await client.functions.invoke('discoverECFServices', {
    profile_id: selectedOrgId
  });

  if (!discoverResponse?.success) {
    throw new Error(discoverResponse?.error || 'ECF service discovery failed');
  }

  // Invalidate cache to ensure new funding opportunities are fetched
  queryClient.invalidateQueries({ queryKey: ['fundingOpportunities'] });
  
  // Use the profile-specific ECF endpoint response directly. Do not call the
  // generic catalog search here; profile search results must come through the
  // Crawler OS match table.
  const ecfServices = discoverResponse.services || [];

  return {
    opportunities: ecfServices,
    count: ecfServices.length,
    message: `Found ${ecfServices.length} services and benefits available in your area.`
  };
}

/**
 * Run standard search with template
 */
export async function runStandardSearch(template, selectedOrgId, searchFilters) {
  const log = createLogger('runStandardSearch')
  log.debug('starting standard search', { template: template?.id || template?.name || null })
  
  let searchParams = {
    profile_id: selectedOrgId,
    filters: searchFilters
  };

  if (template?.keywords) {
    searchParams.additional_keywords = template.keywords;
  }

  if (template?.prompt) {
    searchParams.enhanced_prompt = template.prompt;
  }

  const response = await client.functions.invoke('searchOpportunities', searchParams);

  // Empty results are a valid success response, not an error
  // Only throw if there's an actual API/network failure (success: false with error)
  if (response?.success === false && response?.error) {
    throw new Error(response.error);
  }

  return {
    opportunities: response.results || [],
    count: response.results?.length || 0,
    message: `Found ${response.results?.length || 0} matching opportunities using the "${template?.name}" search.`
  };
}
