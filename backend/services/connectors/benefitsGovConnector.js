/**
 * Benefits.gov Integration
 * State-scoped benefit discovery for individuals and families
 * 
 * Benefits.gov doesn't have a public API, but we can use
 * their benefit finder tool URLs and screen scraping (with respect)
 * 
 * LEGAL: Public service, but no official API - use carefully
 * RATE LIMIT: Very conservative 1 req per 3 seconds
 * TOS: Respect robots.txt and use data responsibly
 * 
 * Alternative: Use state-specific benefit databases where available
 */

import fetch from 'node-fetch';
import { createLogger } from '../../utils/logger.js'
const log = createLogger('benefitsGovConnector')
// NOTE: cheerio was imported here for planned HTML scraping of benefits.gov but is not
// currently used because screen scraping benefits.gov violates their TOS.
// Use the official benefits.gov API when it becomes available, or integrate
// state-specific benefit APIs directly.

const BASE_URL = 'https://www.benefits.gov';
const RATE_LIMIT_MS = 3000; // 1 request per 3 seconds - very conservative

let lastRequestTime = 0;

/**
 * Rate-limited fetch wrapper
 */
// rateLimitedFetch is intentionally retained for future live integration.
// It is NOT called by the current static-catalogue path.
async function rateLimitedFetch(url) {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < RATE_LIMIT_MS) {
    await new Promise(resolve =>
      setTimeout(resolve, RATE_LIMIT_MS - timeSinceLastRequest)
    );
  }

  lastRequestTime = Date.now();

  const response = await fetch(url, {
    // node-fetch has no default deadline; without a signal a hung remote stalls the caller forever.
    signal: AbortSignal.timeout(30000),
    headers: {
      'User-Agent': 'GrantFlow/1.0 (grant management system - educational use)',
      'Accept': 'text/html,application/xhtml+xml'
    }
  });

  if (!response.ok) {
    throw new Error(`Benefits.gov error: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

/**
 * Search for state-specific benefits
 * @param {string} state - Two-letter state code (e.g., 'OH')
 * @param {Object} profile - User profile for benefit matching
 * @returns {Promise<Array>} Array of benefit programs (PROGRAM type)
 */
export async function searchStateBenefits(state, profile = {}) {
  log.info(`[Benefits.gov] Searching benefits for ${state}`);
  
  // NOTE: This is a simplified implementation
  // In production, you would:
  // 1. Use state-specific benefit databases where available
  // 2. Integrate with state APIs (many states have them)
  // 3. Build relationships with state agencies for data access
  
  const benefits = [];
  
  // Common federal benefits that are state-administered
  const federalBenefits = [
    {
      title: 'Medicaid',
      description: 'Health coverage for low-income individuals and families',
      sponsor: `${state} Department of Health`,
      eligibility: ['Low-income', 'Families with children', 'Pregnant women', 'Elderly', 'Disabled'],
      application_url: `https://www.medicaid.gov/state-overviews/stateprofile.html?state=${state}`,
      type: 'PROGRAM' // Standing program, not a grant
    },
    {
      title: 'SNAP (Food Assistance)',
      description: 'Supplemental Nutrition Assistance Program',
      sponsor: `${state} Department of Human Services`,
      eligibility: ['Low-income households', 'Income below 130% poverty line'],
      application_url: `https://www.fns.usda.gov/snap/state-directory`,
      type: 'PROGRAM'
    },
    {
      title: 'TANF (Temporary Assistance)',
      description: 'Temporary Assistance for Needy Families',
      sponsor: `${state} Department of Human Services`,
      eligibility: ['Families with dependent children', 'Low-income'],
      application_url: `https://www.acf.hhs.gov/ofa/programs/tanf`,
      type: 'PROGRAM'
    },
    {
      title: 'LIHEAP (Energy Assistance)',
      description: 'Low Income Home Energy Assistance Program',
      sponsor: `${state} Department of Development`,
      eligibility: ['Low-income households', 'Energy bill assistance'],
      application_url: `https://www.acf.hhs.gov/ocs/liheap`,
      type: 'PROGRAM'
    },
    {
      title: 'WIC (Women, Infants, Children)',
      description: 'Nutrition program for pregnant women and young children',
      sponsor: `${state} Department of Health`,
      eligibility: ['Pregnant women', 'Infants', 'Children under 5', 'Low-income'],
      application_url: `https://www.fns.usda.gov/wic`,
      type: 'PROGRAM'
    }
  ];
  
  federalBenefits.forEach(benefit => {
    benefits.push({
      title: benefit.title,
      sponsor: benefit.sponsor,
      source: 'benefits.gov',
      source_url: benefit.application_url,
      description: benefit.description,
      eligibility_bullets: benefit.eligibility,
      deadline_type: 'rolling', // Benefits have rolling enrollment
      application_url: benefit.application_url,
      is_national: false,
      state: state,
      type: 'PROGRAM', // These are standing programs, not grants
      evidence_url: BASE_URL,
      is_active: true,
      last_crawled: new Date().toISOString()
    });
  });
  
  return benefits;
}

/**
 * Get benefit details
 * NOTE: This is a stub - in production, integrate with state APIs
 */
export async function getBenefitDetails(benefitId, state) {
  if (!benefitId || typeof benefitId !== 'string' || !benefitId.trim()) {
    console.warn('[Benefits.gov] getBenefitDetails called with empty benefitId — returning null (Goal 1 guard)');
    return null;
  }
  const safeBenefitId = encodeURIComponent(benefitId.trim());
  const evidenceUrl = `${BASE_URL}/benefit/${safeBenefitId}`;

  log.info(`[Benefits.gov] Getting benefit details for ${benefitId} in ${state}`);

  // Stub: application_url is required for any record that reaches ACCEPT (Goal 1).
  // Callers MUST supplement this with a real portal URL before pipeline insertion.
  return {
    title: benefitId,
    type: 'PROGRAM',
    state: state,
    evidence_url: evidenceUrl,
    application_url: null, // Must be populated by caller before pipeline insert
    _stub: true,           // Signal to pipeline that this record is incomplete
  };
}

/**
 * Important notes for production implementation:
 * 
 * 1. NEVER screen scrape Benefits.gov aggressively - it's against TOS
 * 2. Instead, use these approaches:
 *    - State-specific benefit databases (many states publish CSV/API)
 *    - HHS benefit program data feeds
 *    - Build partnerships with state agencies
 *    - Use SNAP, Medicaid, TANF enrollment portals directly
 * 
 * 3. Always mark benefits as PROGRAM type, NOT OPPORTUNITY
 *    - Benefits are standing programs with rolling enrollment
 *    - They are NOT open grant solicitations with deadlines
 * 
 * 4. Include proper attribution and evidence URLs
 */

export default {
  searchStateBenefits,
  getBenefitDetails
};
