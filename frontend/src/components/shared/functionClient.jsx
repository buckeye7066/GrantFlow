/**
 * UNIFIED FUNCTION CLIENT v1.0
 * 
 * Canonical function invocation layer for all frontend calls.
 * Bypasses Base44's broken router by using the correct SDK method.
 * 
 * USAGE:
 *   import { callFunction } from '@/components/shared/functionClient';
 *   const result = await callFunction('enqueueGrant', { action: 'bulk', grant_ids: [...] });
 * 
 * @version 1.0.0
 */

import { base44 } from '@/api/base44Client';

/**
 * CANONICAL FUNCTION REGISTRY
 * Maps function names to their correct slugs.
 * All functions must be registered here.
 */
export const FUNCTION_REGISTRY = {
  // Automation & Processing
  enqueueGrant: 'enqueueGrant',
  backgroundWorker: 'backgroundWorker',
  runBatchAutomation: 'runBatchAutomation',
  runSmartAutomation: 'runSmartAutomation',
  runAutomatedDiscovery: 'runAutomatedDiscovery',
  autoMonitor: 'autoMonitor',
  
  // Grant Analysis
  analyzeGrant: 'analyzeGrant',
  analyze2grant: 'analyze2grant',
  matchGrantsForOrganization: 'matchGrantsForOrganization',
  matchProfileToGrants: 'matchProfileToGrants',
  comprehensiveMatch: 'comprehensiveMatch',
  aiGrantMatcher: 'aiGrantMatcher',
  
  // Discovery & Search
  searchOpportunities: 'searchOpportunities',
  discoverLocalSources: 'discoverLocalSources',
  searchForSource: 'searchForSource',
  discoverStudentSources: 'discoverStudentSources',
  discoverECFSources: 'discoverECFSources',
  discoverECFServices: 'discoverECFServices',
  autoDiscoverSources: 'autoDiscoverSources',
  
  // Crawlers
  crawlGrantsGov: 'crawlGrantsGov',
  crawlBenefitsGov: 'crawlBenefitsGov',
  crawlSourceDirectory: 'crawlSourceDirectory',
  crawlWebsite: 'crawlWebsite',
  crawlUniversityScholarships: 'crawlUniversityScholarships',
  crawlECFChoices: 'crawlECFChoices',
  crawlCLSFM: 'crawlCLSFM',
  crawlDSIRE: 'crawlDSIRE',
  crawlIrs990: 'crawlIrs990',
  crawlLeeUniversity: 'crawlLeeUniversity',
  scheduledCrawl: 'scheduledCrawl',
  queueCrawl: 'queueCrawl',
  
  // Proposal & Content
  generateProposalSection: 'generateProposalSection',
  generateProposalDraft: 'generateProposalDraft',
  refineProposalDraft: 'refineProposalDraft',
  generateGrantMetadata: 'generateGrantMetadata',
  generateGrantProposal: 'generateGrantProposal',
  analyzeProposal: 'analyzeProposal',
  refineProposalText: 'refineProposalText',
  refineGrantText: 'refineGrantText',
  suggestProposalKeywords: 'suggestProposalKeywords',
  generateApplicationResponse: 'generateApplicationResponse',
  
  // Application & Submission
  checkApplicationAvailability: 'checkApplicationAvailability',
  checkPendingApplications: 'checkPendingApplications',
  checkApplicationCompliance: 'checkApplicationCompliance',
  prepareGrantSubmission: 'prepareGrantSubmission',
  submitGrant: 'submitGrant',
  autoFillApplicationForm: 'autoFillApplicationForm',
  suggestDocumentsForGrant: 'suggestDocumentsForGrant',
  
  // Alerts & Notifications
  sendDeadlineAlerts: 'sendDeadlineAlerts',
  checkGrantAlerts: 'checkGrantAlerts',
  sendReportReminders: 'sendReportReminders',
  notifyAdminNewMessage: 'notifyAdminNewMessage',
  notifyAdminNewUser: 'notifyAdminNewUser',
  
  // Profile & Enhancement
  getSuggestedEnhancements: 'getSuggestedEnhancements',
  enrichProfileForSearch: 'enrichProfileForSearch',
  suggestGrantKeywords: 'suggestGrantKeywords',
  verifyProfileIsolation: 'verifyProfileIsolation',
  
  // Reporting
  generateReport: 'generateReport',
  generateProgressReport: 'generateProgressReport',
  analyzeProjectOutcomes: 'analyzeProjectOutcomes',
  
  // Email & Outreach
  sendEmailResend: 'sendEmailResend',
  sendInvoice: 'sendInvoice',
  generateOutreachMessage: 'generateOutreachMessage',
  autoGenerateBulkOutreach: 'autoGenerateBulkOutreach',
  
  // Document Processing
  parseNOFO: 'parseNOFO',
  processDocumentForFacts: 'processDocumentForFacts',
  processScannedApplication: 'processScannedApplication',
  processCrawledItem: 'processCrawledItem',
  processOpportunity: 'processOpportunity',
  processFoundation: 'processFoundation',
  processSingleGrant: 'processSingleGrant',
  
  // Funder
  parseFunderWebsite: 'parseFunderWebsite',
  matchFunderToProfile: 'matchFunderToProfile',
  
  // Tax
  analyzeTaxSituation: 'analyzeTaxSituation',
  generateTaxReturn: 'generateTaxReturn',
  requestTaxDocuments: 'requestTaxDocuments',
  exportForTaxSoftware: 'exportForTaxSoftware',
  
  // Leads & CRM
  autoCreateLead: 'autoCreateLead',
  createLead: 'createLead',
  getLeads: 'getLeads',
  getLead: 'getLead',
  updateLead: 'updateLead',
  deleteLead: 'deleteLead',
  getActivities: 'getActivities',
  getLeadActivities: 'getLeadActivities',
  
  // Public
  submitPublicApplication: 'submitPublicApplication',
  publicApplicationForm: 'publicApplicationForm',
  
  // AI
  getAIRecommendations: 'getAIRecommendations',
  
  // Profile
  getSuggestedEnhancements: 'getSuggestedEnhancements',

  // Admin & Utils
  adminBulkAdvance: 'adminBulkAdvance',
  getUserList: 'getUserList',
  deleteUser: 'deleteUser',
  authHealthCheck: 'authHealthCheck',
  runGrantBackfill: 'runGrantBackfill',
  runVerification: 'runVerification',
  runPartnerFeed: 'runPartnerFeed',
  getBackgroundJobStatus: 'getBackgroundJobStatus',
  runBackgroundAutoAdvance: 'runBackgroundAutoAdvance',
  validatePipelineAdvancement: 'validatePipelineAdvancement',
  simulatePipelineRunDebug: 'simulatePipelineRunDebug',
  deleteSourceWithCascade: 'deleteSourceWithCascade',
  deleteOrganizationWithCascade: 'deleteOrganizationWithCascade',
  searchForSource: 'searchForSource',
  searchForItem: 'searchForItem',
  getSearchJob: 'getSearchJob',
  clearProfilePipeline: 'clearProfilePipeline',
  adminBulkAdvance: 'adminBulkAdvance',

  // GitHub
  pushToGithub: 'pushToGithub',
  pushAllFunctionsToGithub: 'pushAllFunctionsToGithub',
  pushAllCodeToGithub: 'pushAllCodeToGithub',
  pullFromGithub: 'pullFromGithub',
  getAllFunctionCodes: 'getAllFunctionCodes',
  getFunctionCode: 'getFunctionCode',
  getFunctionDetails: 'getFunctionDetails',
  getMultipleFunctionCodes: 'getMultipleFunctionCodes',
  buildDependencyGraph: 'buildDependencyGraph',
  getFunctionInfluenceMap: 'getFunctionInfluenceMap',
  
  // Testing
  testSharedModules: 'testSharedModules',
  testFileSystemAPI: 'testFileSystemAPI',
  testAllFunctions: 'testAllFunctions',
  findAllFunctions: 'findAllFunctions',
  findAllFunctionsHybrid: 'findAllFunctionsHybrid',
  autoGenerateFunctionTestPayloads: 'autoGenerateFunctionTestPayloads',
  autoGenerateFunctionTestPayloadsHard: 'autoGenerateFunctionTestPayloadsHard',
  writeAllTestPayloadsNow: 'writeAllTestPayloadsNow',
  createPayloadsForAllFunctions: 'createPayloadsForAllFunctions',
  runDailyStabilityScan: 'runDailyStabilityScan',
  processApplicationEmail: 'processApplicationEmail',

  // ========================================
  // IMMUNE SYSTEM v6.0 - ROOT-LEVEL FUNCTIONS
  // ========================================
  // All immune functions are now root-level to bypass subfolder routing issues
  
  // Core Control
  orchestrator: 'immuneOrchestrator',
  'immune/orchestrator': 'immuneOrchestrator',
  immuneOrchestrator: 'immuneOrchestrator',
  
  wakeSystem: 'immuneWakeSystem',
  'immune/wakeSystem': 'immuneWakeSystem',
  immuneWakeSystem: 'immuneWakeSystem',
  
  sleepSystem: 'immuneSleepSystem',
  'immune/sleepSystem': 'immuneSleepSystem',
  immuneSleepSystem: 'immuneSleepSystem',
  
  // Scheduled & Cycle
  scheduledCycle: 'immuneScheduledCycle',
  'immune/scheduledCycle': 'immuneScheduledCycle',
  immuneScheduledCycle: 'immuneScheduledCycle',
  immuneDaemon: 'immuneScheduledCycle',
  'immune/immuneDaemon': 'immuneScheduledCycle',
  runtimeController: 'immuneOrchestrator',
  'immune/runtimeController': 'immuneOrchestrator',
  
  // Vitals & Config
  getVitals: 'immuneGetVitals',
  'immune/getVitals': 'immuneGetVitals',
  immuneGetVitals: 'immuneGetVitals',
  
  updateCrisprConfig: 'immuneUpdateConfig',
  'immune/updateCrisprConfig': 'immuneUpdateConfig',
  immuneUpdateConfig: 'immuneUpdateConfig',
  getCrisprConfig: 'immuneGetVitals',
  'immune/getCrisprConfig': 'immuneGetVitals',
  
  // Self Test
  selfTestExecutorWorker: 'immuneSelfTest',
  'immune/selfTestExecutorWorker': 'immuneSelfTest',
  immuneSelfTest: 'immuneSelfTest',
  
  // Full Scan
  runFullScan: 'immuneRunFullScan',
  'immune/runFullScan': 'immuneRunFullScan',
  immuneRunFullScan: 'immuneRunFullScan',

  // Sleep System
  sleepSystem: 'immuneSleepSystem',
  'immune/sleepSystem': 'immuneSleepSystem',
  immuneSleepSystem: 'immuneSleepSystem',
  
  // Legacy mappings - route to orchestrator for now
  sentinelWorker: 'immuneOrchestrator',
  'immune/sentinelWorker': 'immuneOrchestrator',
  tCellWorker: 'immuneOrchestrator',
  'immune/tCellWorker': 'immuneOrchestrator',
  bCellWorker: 'immuneOrchestrator',
  'immune/bCellWorker': 'immuneOrchestrator',
  nkCellWorker: 'immuneOrchestrator',
  'immune/nkCellWorker': 'immuneOrchestrator',
  staticAnalyzerWorker: 'immuneRunFullScan',
  'immune/staticAnalyzerWorker': 'immuneRunFullScan',
  frontendStaticAnalyzerWorker: 'immuneRunFullScan',
  'immune/frontendStaticAnalyzerWorker': 'immuneRunFullScan',
  continuousScannerBackendWorker: 'immuneRunFullScan',
  'immune/continuousScannerBackendWorker': 'immuneRunFullScan',
  continuousScannerFrontendWorker: 'immuneRunFullScan',
  'immune/continuousScannerFrontendWorker': 'immuneRunFullScan',
  cleanupWorker: 'immuneOrchestrator',
  'immune/cleanupWorker': 'immuneOrchestrator',
  crisprWorker: 'immuneOrchestrator',
  'immune/crisprWorker': 'immuneOrchestrator',
  repairCoordinator: 'immuneOrchestrator',
  'immune/repairCoordinator': 'immuneOrchestrator',
  rollbackWorker: 'immuneOrchestrator',
  'immune/rollbackWorker': 'immuneOrchestrator',
  domainBMemoryWorker: 'immuneOrchestrator',
  'immune/domainBMemoryWorker': 'immuneOrchestrator',
  selfMutationMemoryWorker: 'immuneOrchestrator',
  'immune/selfMutationMemoryWorker': 'immuneOrchestrator',
  authDiagnosticWorker: 'immuneOrchestrator',
  'immune/authDiagnosticWorker': 'immuneOrchestrator',
  functionClientValidator: 'immuneSelfTest',
  'immune/functionClientValidator': 'immuneSelfTest',
  routingCheckpointWorker: 'immuneSelfTest',
  'immune/routingCheckpointWorker': 'immuneSelfTest',
  getMutationHeatmap: 'immuneGetVitals',
  'immune/getMutationHeatmap': 'immuneGetVitals',
  getMutationLog: 'immuneGetVitals',
  'immune/getMutationLog': 'immuneGetVitals',
  verifyPhenotype: 'immuneRunFullScan',
  'immune/verifyPhenotype': 'immuneRunFullScan',
  getDomainRules: 'immuneGetVitals',
  'immune/getDomainRules': 'immuneGetVitals',
  updateWorkerStateAdmin: 'immuneUpdateConfig',
  'immune/updateWorkerStateAdmin': 'immuneUpdateConfig',
  getRecentEvents: 'immuneGetVitals',
  'immune/getRecentEvents': 'immuneGetVitals',
  updateSafeBlockList: 'immuneUpdateConfig',
  'immune/updateSafeBlockList': 'immuneUpdateConfig',
  updateDomainRule: 'immuneUpdateConfig',
  'immune/updateDomainRule': 'immuneUpdateConfig',
  dailySummary: 'immuneGetVitals',
  'immune/dailySummary': 'immuneGetVitals',
  };

/**
 * Call a backend function using the correct SDK method.
 * 
 * @param {string} functionName - Function name from FUNCTION_REGISTRY
 * @param {object} payload - Request payload
 * @returns {Promise<{ok: boolean, data?: any, error?: string}>}
 */
export async function callFunction(functionName, payload = {}) {
  // Validate function name
  const slug = FUNCTION_REGISTRY[functionName];
  if (!slug) {
    console.error(`[callFunction] Unknown function: ${functionName}`);
    return { ok: false, error: `Unknown function: ${functionName}`, data: null };
  }
  
  try {
    console.log(`[callFunction] Invoking: ${slug}`, payload);
    // Platform V2: payload must be wrapped in body for functions.invoke
    // IMPORTANT: Always pass body even if empty to ensure proper request format
    const wrappedPayload = { body: payload || {} };
    const response = await base44.functions.invoke(slug, wrappedPayload);
    
    // Normalize response
    const data = response?.data;
    
    console.log(`[callFunction] Raw response for ${slug}:`, JSON.stringify(data).slice(0, 500));
    
    // FIXED: Check for error envelope at multiple levels
    // immuneWrapper returns {ok, worker, data} or {ok: false, error}
    if (data?.ok === false) {
      return { ok: false, error: data.error || 'Function returned error', data: null };
    }
    
    // Check if nested data has error
    if (data?.data?.ok === false) {
      return { ok: false, error: data.data.error || 'Function returned error', data: null };
    }
    
    // For runBatchAutomation - it returns { ok: true, data: { processed, ... } }
    // Don't double-unwrap - return data directly if it has the expected fields
    if (data?.ok === true && data?.data !== undefined) {
      return { ok: true, data: data.data, error: null };
    }
    
    // Success - return the actual data
    return { ok: true, data: data?.data ?? data, error: null };
    
  } catch (error) {
    const status = error?.response?.status;
    const message = error?.response?.data?.error || error?.message || 'Unknown error';
    
    console.error(`[callFunction] ${slug} failed:`, status, message);
    
    return {
      ok: false,
      error: message,
      status,
      data: null
    };
  }
}

/**
 * Batch call multiple functions in parallel.
 * 
 * @param {Array<{name: string, payload: object}>} calls - Array of function calls
 * @returns {Promise<Array<{ok: boolean, data?: any, error?: string}>>}
 */
export async function callFunctionsBatch(calls) {
  return Promise.all(
    calls.map(({ name, payload }) => callFunction(name, payload))
  );
}

/**
 * Call a function with automatic retry on 401/500.
 * 
 * @param {string} functionName - Function name
 * @param {object} payload - Request payload
 * @param {number} maxRetries - Max retry attempts (default: 2)
 * @returns {Promise<{ok: boolean, data?: any, error?: string}>}
 */
export async function callFunctionWithRetry(functionName, payload = {}, maxRetries = 2) {
  let lastError = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await callFunction(functionName, payload);
    
    if (result.ok) {
      return result;
    }
    
    lastError = result.error;
    
    // Don't retry on validation errors
    if (result.status === 400) {
      return result;
    }
    
    // Retry on auth/server errors
    if (result.status === 401 || result.status === 500) {
      console.log(`[callFunctionWithRetry] Retry ${attempt + 1}/${maxRetries} for ${functionName}`);
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    
    // Unknown error, don't retry
    return result;
  }
  
  return { ok: false, error: lastError || 'Max retries exceeded', data: null };
}

export default callFunction;