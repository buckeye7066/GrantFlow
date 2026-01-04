import { base44 } from "@/api/base44Client";

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
  console.log('[runComprehensiveMatch] Starting comprehensive search');
  if (!selectedOrg) {
    throw new Error('Profile data is required to run comprehensive match.')
  }

  const stateList = extractStateList(selectedOrg)
  
  const response = await base44.functions.invoke('comprehensiveMatch', {
    profile_json: selectedOrg,
    states: stateList,
    page: 1,
    freshness_days: 60
  });

  if (!response.data?.success) {
    throw new Error(response.data?.error || 'Comprehensive match failed');
  }

  // Convert comprehensive match format to standard format
  const opportunities = (response.data.opportunities || []).map(opp => ({
    title: opp.program_name,
    sponsor: opp.sponsor,
    url: opp.url,
    deadlineAt: opp.deadline,
    awardMin: opp.amount_min,
    awardMax: opp.amount_max,
    descriptionMd: opp.description,
    eligibilityBullets: opp.eligibility_summary ? [opp.eligibility_summary] : [],
    match: opp.fit_score,
    source: 'comprehensive_match',
    matched_fields: opp.matched_fields || []
  }));

  return {
    opportunities,
    count: opportunities.length,
    message: `Found ${opportunities.length} highly relevant opportunities using comprehensive AI matching.`
  };
}

/**
 * Run ECF CHOICES service discovery
 */
export async function runECFServiceSearch(selectedOrgId, queryClient) {
  console.log('[runECFServiceSearch] Starting ECF service discovery');
  
  // First, invoke the ECF discovery function
  const discoverResponse = await base44.functions.invoke('discoverECFServices', {
    profile_id: selectedOrgId
  });

  if (!discoverResponse.data?.success) {
    throw new Error(discoverResponse.data?.error || 'ECF service discovery failed');
  }

  // Invalidate cache to ensure new funding opportunities are fetched
  queryClient.invalidateQueries({ queryKey: ['fundingOpportunities'] });
  
  // Search for newly added services
  const searchResponse = await base44.functions.invoke('searchOpportunities', {
    profile_id: selectedOrgId,
    filters: {}
  });

  if (!searchResponse.data?.success) {
    throw new Error(searchResponse.data?.error || 'Service search failed');
  }

  // Filter to only show ECF services
  const ecfServices = (searchResponse.data.results || []).filter(r => 
    r.source === 'ecf_choices_discovery'
  );

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
  console.log('[runStandardSearch] Starting standard search');
  
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

  const response = await base44.functions.invoke('searchOpportunities', searchParams);

  if (!response.data?.success) {
    throw new Error(response.data?.message || 'No opportunities matched your criteria');
  }

  return {
    opportunities: response.data.results || [],
    count: response.data.results?.length || 0,
    message: `Found ${response.data.results?.length || 0} matching opportunities using the "${template?.name}" search.`
  };
}