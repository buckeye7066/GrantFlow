import { base44 } from "@/api/base44Client";

const SCOPE = '[DiscoveryHelpers]';

// Safe logging utility
const log = {
  info: (...args) => console.log('[INFO]', SCOPE, ...args),
  warn: (...args) => console.warn('[WARN]', SCOPE, ...args),
  error: (...args) => console.error('[ERROR]', SCOPE, ...args),
  debug: (...args) => console.log('[DEBUG]', SCOPE, ...args),
};

// ============================================================================
// PIPELINE ISOLATION GUARDS - Imported from shared module pattern
// ============================================================================

/**
 * Validate pipeline context - STRICT, NO FALLBACKS
 * @param {string} organization_id 
 * @param {string} profile_id 
 * @param {string} functionName 
 * @returns {{ valid: boolean, error?: string }}
 */
function validatePipelineContext(organization_id, profile_id, functionName = 'unknown') {
  if (!organization_id || typeof organization_id !== 'string' || organization_id.trim().length === 0) {
    log.error(`PIPELINE_ISOLATION_ERROR [${functionName}]: Missing organization_id`);
    return { valid: false, error: 'Pipeline operation requires organization_id - no fallback allowed' };
  }
  
  if (!profile_id || typeof profile_id !== 'string' || profile_id.trim().length === 0) {
    log.error(`PIPELINE_ISOLATION_ERROR [${functionName}]: Missing profile_id`);
    return { valid: false, error: 'Pipeline operation requires profile_id - no fallback allowed' };
  }
  
  return { valid: true };
}

/**
 * Check for cross-profile contamination after reads
 * @param {array} grants 
 * @param {string} expectedProfileId 
 * @param {string} functionName 
 * @returns {{ clean: boolean, contaminated: array }}
 */
function checkPipelineContamination(grants, expectedProfileId, functionName = 'unknown') {
  if (!grants || !Array.isArray(grants)) {
    return { clean: true, contaminated: [] };
  }
  
  if (!expectedProfileId) {
    log.error(`[${functionName}] CONTAMINATION_CHECK_FAILED: No expectedProfileId`);
    return { clean: false, contaminated: grants.map(g => g?.id).filter(Boolean) };
  }
  
  const contaminated = [];
  for (const grant of grants) {
    if (grant?.profile_id && grant.profile_id !== expectedProfileId) {
      log.error(`[${functionName}] CROSS_PROFILE_CONTAMINATION:`, {
        grantId: grant.id,
        grantTitle: grant.title?.substring(0, 40),
        expectedProfileId,
        actualProfileId: grant.profile_id
      });
      contaminated.push(grant.id);
    }
  }
  
  return { clean: contaminated.length === 0, contaminated };
}

/**
 * Log pipeline operation to Sentinel
 * @param {string} operation 
 * @param {object} context 
 */
function logPipelineOperation(operation, context) {
  const { organization_id, profile_id, functionName, grantCount, error } = context;
  
  const logEntry = {
    timestamp: new Date().toISOString(),
    operation,
    organization_id: organization_id || 'MISSING',
    profile_id: profile_id || 'MISSING',
    functionName: functionName || 'unknown',
    grantCount: grantCount || 0,
    hasError: !!error,
    errorMessage: error || null
  };
  
  console.log('[PipelineIsolation]', JSON.stringify(logEntry));
  
  // Log to Sentinel if error
  if (error) {
    logToSystemSentinel(`Pipeline ${operation} failed`, { ...logEntry, reason: error });
  }
}

/**
 * Build filter query with BOTH isolation fields - NO FALLBACKS
 * @param {string} organization_id 
 * @param {string} profile_id 
 * @param {object} additionalFilters 
 * @returns {object}
 */
function buildPipelineFilter(organization_id, profile_id, additionalFilters = {}) {
  if (!organization_id || !profile_id) {
    throw new Error('buildPipelineFilter requires both organization_id and profile_id - no fallback');
  }
  
  return {
    organization_id,
    profile_id,
    ...additionalFilters
  };
}

/**
 * Build grant data with isolation fields enforced - NO FALLBACKS
 * @param {object} grantData 
 * @param {string} organization_id 
 * @param {string} profile_id 
 * @param {string} organizationCreatedBy 
 * @returns {object}
 */
function buildPipelineGrantData(grantData, organization_id, profile_id, organizationCreatedBy = null) {
  if (!organization_id || !profile_id) {
    throw new Error('buildPipelineGrantData requires both organization_id and profile_id - no fallback');
  }
  
  return {
    ...grantData,
    organization_id,
    profile_id,
    organization_created_by: organizationCreatedBy || grantData.organization_created_by,
  };
}

// ============================================================================
// PIPELINE CLEANUP GUARD - DISABLED UNTIL CONTAMINATION IS RESOLVED
// ============================================================================

/**
 * CRITICAL: This function guards against any cleanup/deletion logic.
 * Until cross-profile contamination is fully resolved, ALL deletions are blocked.
 * 
 * @param {string} profile_id - Profile ID from context
 * @param {string} organization_id - Organization ID from context
 * @param {object} normalizedProfile - Normalized profile object
 * @returns {{ allowed: boolean, reason?: string, error?: string, skipped: boolean, message: string }}
 */
export function validatePipelineCleanup(profile_id, organization_id, normalizedProfile = null) {
  // PART 1: Enforce required parameters
  if (!profile_id) {
    log.error('CLEANUP_BLOCKED: missing_profile_id');
    logToSystemSentinel('Pipeline cleanup skipped due to missing profile_id', {
      profile_id: null,
      organization_id,
      reason: 'missing_profile_id'
    });
    return {
      allowed: false,
      error: 'missing_profile_id',
      skipped: true,
      message: 'Pipeline cleanup skipped due to missing profile_id.'
    };
  }

  if (!organization_id) {
    log.error('CLEANUP_BLOCKED: missing_organization_id');
    logToSystemSentinel('Pipeline cleanup skipped due to missing organization_id', {
      profile_id,
      organization_id: null,
      reason: 'missing_organization_id'
    });
    return {
      allowed: false,
      error: 'missing_organization_id',
      skipped: true,
      message: 'Pipeline cleanup skipped due to missing organization_id.'
    };
  }

  // PART 2: Check for contaminated profile
  if (normalizedProfile && normalizedProfile.profileId !== profile_id) {
    log.error('CLEANUP_BLOCKED: contaminated_profile_cache', {
      expected: profile_id,
      actual: normalizedProfile.profileId
    });
    logToSystemSentinel('Contaminated profile used for pipeline cleanup', {
      expected: profile_id,
      actual: normalizedProfile.profileId,
      reason: 'contaminated_profile_cache'
    });
    return {
      allowed: false,
      error: 'contaminated_profile_cache',
      skipped: true,
      message: 'Pipeline cleanup blocked due to contaminated profile cache.'
    };
  }

  // PART 3: DISABLE AUTOMATIC DELETIONS TEMPORARILY
  // Until all contamination is resolved, disable automatic deletions entirely
  log.warn('CLEANUP_DISABLED_GLOBALLY: All deletions blocked pending contamination resolution');
  return {
    allowed: false,
    skipped: true,
    message: 'Pipeline cleanup disabled to prevent accidental grant deletion.'
  };
}

/**
 * Block any deletion attempt and log to SystemSentinel
 * 
 * @param {string} profile_id - Profile ID
 * @param {string} organization_id - Organization ID  
 * @param {object} normalizedProfile - Normalized profile
 * @param {number} deletionTargetCount - Number of grants targeted for deletion
 */
export function blockDeletionAttempt(profile_id, organization_id, normalizedProfile, deletionTargetCount) {
  log.error('DELETION_ATTEMPT_BLOCKED', {
    profile_id,
    organization_id,
    deletionTargetCount,
    timestamp: new Date().toISOString()
  });

  logToSystemSentinel('Pipeline deletion attempt blocked', {
    profile_id,
    organization_id,
    normalizedProfile: normalizedProfile ? {
      profileId: normalizedProfile.profileId,
      profile_id: normalizedProfile.profile_id,
      signature: normalizedProfile._signature
    } : null,
    deletionTargetCount,
    timestamp: new Date().toISOString(),
    callStack: new Error().stack
  });

  return {
    blocked: true,
    reason: 'All pipeline deletions are currently disabled',
    grantsPreserved: deletionTargetCount
  };
}

/**
 * Log critical events to SystemSentinel for monitoring
 */
async function logToSystemSentinel(message, context) {
  try {
    console.error('[SystemSentinel]', message, JSON.stringify(context));
    const { data, error } = await base44.functions.invoke('sendErrorReport', {
      body: {
        errorReport: {
          id: `cleanup-guard-${Date.now()}`,
          timestamp: new Date().toISOString(),
          errorType: 'CLEANUP_GUARD',
          functionName: 'discoveryHelpers',
          error: { message },
          context,
          explanation: {
            summary: message,
            cause: context?.reason || 'Pipeline cleanup safety guard triggered',
            fix: 'Resolve cross-profile contamination before enabling deletions'
          },
          severity: 'high'
        }
      }
    });
    if (error) console.error('[SystemSentinel] Backend reported error:', error?.message || error);
    if (!data?.success) console.warn('[SystemSentinel] sendErrorReport returned non-success:', data);
  } catch (err) {
    console.error('[SystemSentinel] Failed to send alert:', err?.message || err);
  }
}

/**
 * Save discovered opportunities to the Grant pipeline for an organization
 * 
 * CRITICAL: Uses profile_id for per-profile isolation.
 * The SAME grant can exist in multiple profile pipelines independently.
 * Deduplication is scoped to (url, organization_id, profile_id) - the UNIQUE KEY
 * 
 * @param {Array} opportunities - Array of opportunity objects from search
 * @param {Object} profile - The organization profile (MUST have .id)
 * @returns {Object} - { saved: number, skipped: number, errors: number }
 */
export async function saveOpportunitiesToPipeline(opportunities, profile) {
  const functionName = 'saveOpportunitiesToPipeline';
  log.info('Saving opportunities to pipeline', { count: opportunities?.length, orgId: profile?.id });
  
  if (!opportunities || opportunities.length === 0) {
    return { saved: 0, skipped: 0, errors: 0 };
  }
  
  // STRICT VALIDATION: Both organization_id AND profile_id required - NO FALLBACK
  const organization_id = profile?.id;
  const profile_id = profile?.id; // For profiles, org_id and profile_id are the same
  
  const validation = validatePipelineContext(organization_id, profile_id, functionName);
  if (!validation.valid) {
    log.error('PIPELINE_ISOLATION_ERROR:', validation.error);
    logPipelineOperation('create', {
      organization_id,
      profile_id,
      functionName,
      grantCount: opportunities.length,
      error: validation.error
    });
    logToSystemSentinel('Pipeline save blocked - isolation validation failed', {
      profile_id,
      organization_id,
      opportunitiesCount: opportunities.length,
      reason: validation.error
    });
    return { saved: 0, skipped: 0, errors: opportunities.length };
  }
  
  log.info('PIPELINE_ISOLATION: Validated org_id + profile_id', { organization_id, profile_id });
  
  let saved = 0;
  let skipped = 0;
  let errors = 0;
  
  // Get existing grants using SAFE FILTER with both isolation fields
  let existingGrants = [];
  try {
    const filter = buildPipelineFilter(organization_id, profile_id, {});
    existingGrants = await base44.entities.Grant.filter(filter);
    
    // CHECK FOR CONTAMINATION after read
    const contamination = checkPipelineContamination(existingGrants, profile_id, functionName);
    if (!contamination.clean) {
      log.error('CONTAMINATION_DETECTED in existing grants:', contamination.contaminated.length);
      existingGrants = existingGrants.filter(g => !contamination.contaminated.includes(g.id));
    }
    
    log.info('Found existing grants for profile:', existingGrants.length);
    
    logPipelineOperation('read', {
      organization_id,
      profile_id,
      functionName,
      grantCount: existingGrants.length
    });
  } catch (err) {
    log.warn('Could not fetch existing grants:', err?.message || err);
  }
  
  // UNIQUE KEY: (url, organization_id, profile_id) - Only use URL for deduplication
  const existingUrls = new Set(
    existingGrants
      .map(g => g.url?.toLowerCase().trim())
      .filter(url => url && url.length > 10)
  );
  
  for (const opp of opportunities) {
    try {
      const url = opp?.url?.toLowerCase().trim();
      
      // UNIQUE KEY CHECK: (url, organization_id, profile_id)
      if (url && url.length > 10 && existingUrls.has(url)) {
        log.debug('Skipping duplicate (URL match):', (opp?.title || '').substring(0, 40));
        skipped++;
        continue;
      }
      
      // Build grant data with ENFORCED isolation fields
      const grantData = buildPipelineGrantData({
        funding_opportunity_id: opp?.id || opp?.source_id || null,
        title: opp?.title || 'Untitled Opportunity',
        funder: opp?.sponsor || opp?.funder || 'Unknown',
        url: opp?.url || '',
        deadline: opp?.deadlineAt || opp?.deadline || null,
        status: 'discovered',
        program_description: buildDescription(opp),
        application_status: 'unknown',
        eligibility_checked: false,
        notify_when_open: false
      }, organization_id, profile_id, profile.created_by);
      
      await base44.entities.Grant.create(grantData);
      saved++;
      
      // Track for deduplication within this batch
      if (url && url.length > 10) existingUrls.add(url);
      
    } catch (err) {
      log.error('Error saving opportunity:', err?.message || err);
      errors++;
    }
  }
  
  logPipelineOperation('create', {
    organization_id,
    profile_id,
    functionName,
    grantCount: saved
  });
  
  log.info('Pipeline save complete:', { saved, skipped, errors, organization_id, profile_id });
  return { saved, skipped, errors };
}

/**
 * Build description from opportunity fields
 */
function buildDescription(opp) {
  const parts = [];
  
  if (opp?.descriptionMd || opp?.description) {
    parts.push(opp.descriptionMd || opp.description);
  }
  
  if (Array.isArray(opp?.eligibilityBullets) && opp.eligibilityBullets.length > 0) {
    parts.push('\n\nEligibility:\n• ' + opp.eligibilityBullets.join('\n• '));
  }
  
  if (opp?.awardMin || opp?.awardMax) {
    const min = opp.awardMin ? `$${Number(opp.awardMin).toLocaleString()}` : '';
    const max = opp.awardMax ? `$${Number(opp.awardMax).toLocaleString()}` : '';
    if (min && max) {
      parts.push(`\n\nAward Range: ${min} - ${max}`);
    } else if (max) {
      parts.push(`\n\nAward: Up to ${max}`);
    } else if (min) {
      parts.push(`\n\nAward: Starting at ${min}`);
    }
  }
  
  if (opp?.match) {
    parts.push(`\n\nMatch Score: ${opp.match}%`);
  }
  
  if (Array.isArray(opp?.matchReasons) && opp.matchReasons.length > 0) {
    parts.push('\n\nWhy this matches: ' + opp.matchReasons.join(', '));
  }
  
  return parts.join('') || 'No description available.';
}

/**
 * Trigger auto-advance processing for an organization's grants
 * @param {string} organizationId - The organization ID
 * @returns {Object} - { success, job_id, message, error? }
 */
export async function triggerAutoAdvance(organizationId) {
  log.info('Triggering auto-advance for org:', organizationId);
  
  if (!organizationId) {
    return { success: false, error: 'No organization ID provided' };
  }
  
  try {
    const { data, error } = await base44.functions.invoke('runBackgroundAutoAdvance', {
      body: { organization_id: organizationId }
    });
    if (error) {
      log.error('Auto-advance error:', error?.message || error);
      return { success: false, error: error?.message || 'Auto-advance failed' };
    }
    
    const job_id = data?.job_id || data?.jobId || data?.job?.id;
    log.info('Auto-advance triggered:', job_id);
    
    return {
      success: Boolean(data?.success),
      job_id,
      message: data?.message || 'Auto-advance started'
    };
  } catch (err) {
    log.error('Failed to trigger auto-advance:', err?.message || err);
    return { success: false, error: err?.message || 'Failed to trigger auto-advance' };
  }
}

/**
 * Save opportunities and trigger auto-advance in one call
 * @param {Array} opportunities - Found opportunities
 * @param {Object} profile - Organization profile
 * @returns {Object} - Combined results
 */
export async function saveAndAutoAdvance(opportunities, profile) {
  log.info('Save and auto-advance:', { count: opportunities?.length, orgId: profile?.id });
  
  // First save opportunities to pipeline
  const saveResult = await saveOpportunitiesToPipeline(opportunities, profile);
  
  // If we saved any, trigger auto-advance
  let advanceResult = { success: false, message: 'No new grants to process' };
  if (saveResult.saved > 0) {
    advanceResult = await triggerAutoAdvance(profile.id);
  }
  
  return {
    pipeline: saveResult,
    autoAdvance: advanceResult,
    summary: `Saved ${saveResult.saved} grants to pipeline${saveResult.skipped > 0 ? ` (${saveResult.skipped} duplicates skipped)` : ''}${advanceResult.success ? ', AI processing started' : ''}`
  };
}

// Helper to extract meaningful error message from any error type
function getErrorMessage(error) {
  if (!error) return 'Unknown error occurred';
  if (typeof error === 'string') return error;
  // Axios-like envelopes
  const respData = error?.response?.data;
  if (respData) {
    if (typeof respData === 'string') return respData;
    return respData.error || respData.message || JSON.stringify(respData);
  }
  // Function invoke envelopes
  if (error?.data) {
    return error.data.error || error.data.message || JSON.stringify(error.data);
  }
  if (error.message) return error.message;
  if (error.error && typeof error.error === 'string') return error.error;
  if (typeof error === 'object') {
    try { return JSON.stringify(error); } catch { return 'Error object could not be stringified'; }
  }
  return String(error);
}

// ID pattern validators - exported for use in other components
export const ID_PATTERN = /^[0-9a-f]{24}$/i;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate that a profile ID is in the correct format
 * EXPORTED for use in other components
 */
export function isValidProfileId(id) {
  if (!id || typeof id !== 'string') return false;
  const trimmed = id.trim();
  return ID_PATTERN.test(trimmed) || UUID_PATTERN.test(trimmed);
}

/**
 * Validate profile object before making any API call
 * EXPORTED for use in other components
 */
export function validateProfile(profile) {
  if (!profile) {
    return { valid: false, error: 'No profile provided' };
  }
  if (!profile.id) {
    return { valid: false, error: 'Profile is missing ID' };
  }
  if (!isValidProfileId(profile.id)) {
    return { valid: false, error: `Invalid profile ID format: ${profile.id}` };
  }
  if (profile.id === profile.name) {
    return { valid: false, error: 'Profile ID appears to be a name, not an ID' };
  }
  return { valid: true };
}

/**
 * Run AI-powered smart matching
 * CRITICAL: Always pass profile.id (UUID), never profile.name
 * Now uses section-sequential crawling with repayment filtering
 */
export async function runAISmartMatch(profile, filters = {}) {
  log.info('Starting AI smart match', { profileId: profile?.id, profileName: profile?.name });
  
  const validation = validateProfile(profile);
  if (!validation.valid) {
    log.warn('AI smart match skipped - profile validation:', validation.error, { profileId: profile?.id, profileName: profile?.name });
    return {
      success: false,
      error: validation.error,
      opportunities: [],
      count: 0
    };
  }

  // Payload with both profile_id and profile_data for section-sequential processing
  const payload = { 
    profile_id: profile.id,
    profile_data: profile,
    search_filters: filters || {}
  };
  log.info('Using profile_id:', profile.id);
  console.log('[DiscoveryHelpers] Calling comprehensiveMatch with section-sequential processing');

  try {
    const { data, error } = await base44.functions.invoke('comprehensiveMatch', { body: payload });
    if (error) {
      const errMsg = error?.message || 'AI matcher error';
      log.error('comprehensiveMatch error:', errMsg);
      return { success: false, error: errMsg, opportunities: [], count: 0 };
    }
    
    const responseData = data;
    
    console.log('[DiscoveryHelpers] comprehensiveMatch response:', JSON.stringify({
      hasData: !!responseData,
      success: responseData?.success,
      error: responseData?.error,
      count: responseData?.opportunities?.length || responseData?.count,
      sectionsUsed: responseData?.metadata?.sections_available
    }));

    if (responseData?.success) {
      // Filter already applied by backend: repayment-free, active, geo-matched
      const opportunities = responseData.opportunities || responseData.results || responseData.matches || [];
      
      log.info(`AI smart match found ${opportunities.length} repayment-free opportunities`);
      
      return {
        success: true,
        count: opportunities.length,
        opportunities,
        metadata: {
          total_analyzed: responseData.analyzed || opportunities.length,
          method: 'ai_smart_match',
          sections_used: responseData.metadata?.sections_available || [],
          repayment_free: true
        }
      };
    }
    
    const errorMessage = responseData?.error || responseData?.message || 'AI matching returned no results';
    log.warn('AI matching returned:', errorMessage);
    
    return {
      success: false,
      error: errorMessage,
      opportunities: [],
      count: 0
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    // Downgrade MISSING_PROFILE_ID from error to warning - it's expected when profile isn't selected
    if (errorMessage.includes('MISSING_PROFILE_ID') || errorMessage.includes('profile_id')) {
      log.warn('AI smart match skipped - no profile selected:', errorMessage);
    } else {
      log.error('AI smart match catch:', errorMessage);
    }
    
    return {
      success: false,
      error: errorMessage,
      opportunities: [],
      count: 0
    };
  }
}

/**
 * Run comprehensive AI match search
 * CRITICAL: Always pass selectedOrg.id (UUID), never selectedOrg.name
 * Now uses section-sequential crawling with repayment filtering
 */
export async function runComprehensiveMatch(selectedOrg, searchFilters, retryCount = 0) {
  log.info('Starting comprehensive search (section-sequential)', { orgId: selectedOrg?.id, orgName: selectedOrg?.name, retryCount });
  
  const validation = validateProfile(selectedOrg);
  if (!validation.valid) {
    log.error('Profile validation failed:', validation.error);
    throw new Error(validation.error);
  }

  // Payload with both profile_id and profile_data for section-sequential processing
  const payload = { 
    profile_id: selectedOrg.id,
    profile_data: selectedOrg,
    search_filters: searchFilters || {}
  };
  log.info('Using profile_id:', selectedOrg.id);
  console.log('[DiscoveryHelpers] Calling comprehensiveMatch (section-sequential, repayment-free)');
  
  try {
    let data;
    try {
      const res = await base44.functions.invoke('comprehensiveMatch', { body: payload });
      if (res.error) throw res.error;
      data = res.data;
    } catch (networkErr) {
      const isNetworkError = networkErr?.message?.includes('Network Error') || 
                             networkErr?.code === 'ERR_NETWORK' ||
                             (typeof navigator !== 'undefined' && !navigator.onLine);
      if (isNetworkError && retryCount < 2) {
        log.info('Network error, retrying comprehensive match...', { retryCount: retryCount + 1 });
        await new Promise(resolve => setTimeout(resolve, 2000 * (retryCount + 1)));
        return runComprehensiveMatch(selectedOrg, searchFilters, retryCount + 1);
      }
      throw new Error(isNetworkError ? 'Network connection lost. Please check your internet and try again.' : (networkErr?.message || 'Request failed'));
    }
    
    console.log('[DiscoveryHelpers] runComprehensiveMatch response:', JSON.stringify({
      hasData: !!data,
      success: data?.success,
      error: data?.error,
      count: data?.opportunities?.length || data?.count,
      sectionsUsed: data?.metadata?.sections_available
    }));
    
    if (!data?.success) {
      const errorMessage = data?.error || data?.message || 'Comprehensive match failed';
      log.error('Function returned error:', errorMessage);
      throw new Error(errorMessage);
    }

    // All opportunities from backend are already: repayment-free, active, geo-matched
    const opportunities = (data.opportunities || []).map((opp) => ({
      title: opp.title || opp.program_name || 'Untitled Opportunity',
      sponsor: opp.sponsor || 'Unknown Sponsor',
      url: opp.url || '',
      deadlineAt: opp.deadlineAt || opp.deadline || null,
      awardMin: opp.awardMin || opp.amount_min || null,
      awardMax: opp.awardMax || opp.amount_max || null,
      descriptionMd: opp.descriptionMd || opp.description || '',
      eligibilityBullets: opp.eligibilityBullets || (opp.eligibility_summary ? [opp.eligibility_summary] : []),
      match: opp.match || opp.match_confidence || opp.fit_score || 0,
      matchReasons: opp.matchReasons || [],
      matched_sections: opp.matched_sections || [],
      source: 'comprehensive_match',
      repayment_free: true
    }));

    log.info('Search completed successfully', { count: opportunities.length });

    return {
      opportunities,
      count: opportunities.length,
      message: `Found ${opportunities.length} repayment-free opportunities using section-sequential AI matching.`
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    log.error('Search failed:', errorMessage);
    
    if (errorMessage.toLowerCase().includes('not found') || 
        errorMessage.toLowerCase().includes('profile') ||
        errorMessage.includes('PROFILE_NOT_FOUND')) {
      throw new Error('Profile no longer available. Please refresh and select a different profile.');
    }
    
    throw new Error(errorMessage);
  }
}

/**
 * Run ECF CHOICES service discovery
 */
export async function runECFServiceSearch(selectedOrgId, queryClient, selectedOrg = null, retryCount = 0) {
  log.info('Starting ECF service discovery', { orgId: selectedOrgId, retryCount });
  
  if (!isValidProfileId(selectedOrgId)) {
    throw new Error('Invalid profile ID format');
  }
  
  try {
    // Payload with profile_id and profile_data if available
    const discoverPayload = { 
      profile_id: selectedOrgId,
      ...(selectedOrg ? { profile_data: selectedOrg } : {})
    };
    log.info('Using profile_id:', selectedOrgId);
    console.log('[DiscoveryHelpers] Calling discoverECFServices with payload:', JSON.stringify({ profile_id: selectedOrgId, hasProfileData: !!selectedOrg }));

    let discoverData;
    try {
      const res = await base44.functions.invoke('discoverECFServices', { body: discoverPayload });
      if (res.error) throw res.error;
      discoverData = res.data;
    } catch (networkErr) {
      const isNetworkError = networkErr?.message?.includes('Network Error') || 
                             networkErr?.code === 'ERR_NETWORK' ||
                             (typeof navigator !== 'undefined' && !navigator.onLine);
      if (isNetworkError && retryCount < 2) {
        log.info('Network error, retrying ECF discovery...', { retryCount: retryCount + 1 });
        await new Promise(resolve => setTimeout(resolve, 2000 * (retryCount + 1)));
        return runECFServiceSearch(selectedOrgId, queryClient, selectedOrg, retryCount + 1);
      }
      throw new Error(isNetworkError ? 'Network connection lost. Please check your internet and try again.' : (networkErr?.message || 'Request failed'));
    }

    if (!discoverData?.success) {
      const errorMsg = discoverData?.error || discoverData?.message || 'ECF service discovery failed';
      if (retryCount < 2 && (discoverData?.statusCode >= 500)) {
        log.info('Retrying ECF discovery...', { retryCount: retryCount + 1 });
        await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
        return runECFServiceSearch(selectedOrgId, queryClient, selectedOrg, retryCount + 1);
      }
      throw new Error(errorMsg);
    }

    queryClient.invalidateQueries({ queryKey: ['fundingOpportunities'] });
    
    // Now run a follow-up search
    const searchPayload = { 
      profile_id: selectedOrgId,
      ...(selectedOrg ? { profile_data: selectedOrg } : {})
    };
    log.info('Using profile_id:', selectedOrgId);
    console.log('[DiscoveryHelpers] Calling searchOpportunities with payload:', JSON.stringify({ profile_id: selectedOrgId, hasProfileData: !!selectedOrg }));

    let searchData;
    try {
      const res = await base44.functions.invoke('searchOpportunities', { body: searchPayload });
      if (res.error) throw res.error;
      searchData = res.data;
    } catch (networkErr) {
      const isNetworkError = networkErr?.message?.includes('Network Error') || networkErr?.code === 'ERR_NETWORK';
      throw new Error(isNetworkError ? 'Network connection lost during search. Please try again.' : (networkErr?.message || 'Request failed'));
    }

    if (!searchData?.success) {
      throw new Error(searchData?.error || searchData?.message || 'Service search failed');
    }

    const ecfServices = (searchData.results || []).filter((r) => 
      r.source === 'ecf_choices_discovery'
    );

    log.info('ECF search completed', { count: ecfServices.length });

    return {
      opportunities: ecfServices,
      count: ecfServices.length,
      message: `Found ${ecfServices.length} services and benefits available in your area.`
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    log.error('ECF search failed:', errorMessage);
    throw new Error(errorMessage);
  }
}

/**
 * Run standard search with template
 * CRITICAL: selectedOrgId must be a UUID, never a name
 */
export async function runStandardSearch(template, selectedOrgId, searchFilters, selectedOrg = null, retryCount = 0) {
  log.info('Starting standard search', { template: template?.name, orgId: selectedOrgId, retryCount });
  
  if (!isValidProfileId(selectedOrgId)) {
    const errorMsg = 'Invalid profile ID format - must be a UUID';
    log.error(errorMsg, { selectedOrgId });
    throw new Error(errorMsg);
  }
  
  try {
    // Payload with profile_id, profile_data (if available), and filters
    const searchParams = { 
      profile_id: selectedOrgId,
      ...(selectedOrg ? { profile_data: selectedOrg } : {}),
      filters: searchFilters || {}
    };
    log.info('Using profile_id:', selectedOrgId);
    console.log('[DiscoveryHelpers] Calling searchOpportunities with payload:', JSON.stringify({ profile_id: selectedOrgId, hasProfileData: !!selectedOrg }));

    let data;
    try {
      const res = await base44.functions.invoke('searchOpportunities', { body: searchParams });
      if (res.error) throw res.error;
      data = res.data;
    } catch (networkErr) {
      const isNetworkError = networkErr?.message?.includes('Network Error') || 
                             networkErr?.code === 'ERR_NETWORK' ||
                             (typeof navigator !== 'undefined' && !navigator.onLine);
      if (isNetworkError && retryCount < 2) {
        log.info('Network error, retrying search...', { retryCount: retryCount + 1 });
        await new Promise(resolve => setTimeout(resolve, 2000 * (retryCount + 1)));
        return runStandardSearch(template, selectedOrgId, searchFilters, selectedOrg, retryCount + 1);
      }
      throw new Error(isNetworkError ? 'Network connection lost. Please check your internet and try again.' : (networkErr?.message || 'Request failed'));
    }
    
    console.log('[DiscoveryHelpers] searchOpportunities response:', JSON.stringify({
      hasData: !!data,
      success: data?.success,
      error: data?.error,
      count: data?.results?.length || data?.opportunities?.length
    }));

    if (!data?.success) {
      const errorMsg = data?.message || data?.error || 'No opportunities matched your criteria';
      throw new Error(errorMsg);
    }

    const count = data.results?.length || data.opportunities?.length || 0;
    log.info('Standard search completed', { count });

    return {
      opportunities: data.results || data.opportunities || [],
      count,
      message: `Found ${count} matching opportunities using the "${template?.name}" search.`
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    log.error('Standard search failed:', errorMessage);
    throw new Error(errorMessage);
  }
}