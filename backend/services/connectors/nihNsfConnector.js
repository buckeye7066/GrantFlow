/**
 * NIH/NSF Feeds Connector
 * Research funding opportunities from NIH RePORTER and NSF Awards
 * 
 * NIH RePORTER API: https://api.reporter.nih.gov/
 * NSF Awards API: https://www.research.gov/common/webapi/awardapisearch-v1.htm
 * 
 * LEGAL: Public domain federal data
 * RATE LIMIT: NIH - 100 req/min, NSF - not specified (use conservative)
 * TOS: Public use encouraged for research purposes
 */

import fetch from 'node-fetch';

const NIH_BASE_URL = 'https://api.reporter.nih.gov/v2';
const NSF_BASE_URL = 'https://www.research.gov/awardapi-service/v1/awards.json';

const RATE_LIMIT_MS = 600; // ~100 requests per minute for NIH

let lastRequestTime = 0;

/**
 * Rate-limited fetch wrapper
 */
// rateLimitedFetch is intentionally unused in this baseline-only connector.
// TODO: Wire rateLimitedFetch into searchNIHOpportunities and searchNSFOpportunities
// once NIH Guide RSS and NSF funding announcement ingestion is implemented.
// Until then, this connector returns PROGRAM-type templates only (is_active:false).
async function rateLimitedFetch(url, options = {}) {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < RATE_LIMIT_MS) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - timeSinceLastRequest));
  }
  
  lastRequestTime = Date.now();
  
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'GrantFlow/1.0 (grant management system)',
      ...options.headers
    }
  });
  
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }
  
  return response.json();
}

/**
 * Search NIH funding mechanisms (BASELINE/UNVERIFIED)
 * @param {Object} params - Search parameters
 * @returns {Promise<Array>} Array of NIH program baseline entries (PROGRAM type)
 * 
 * NOTE: These are funding mechanism templates, NOT verified open opportunities.
 * Real FOA ingestion requires parsing NIH Guide RSS feeds.
 */
export async function searchNIHOpportunities(params = {}) {
  console.log('[NIH] Fetching baseline funding mechanisms');
  
  // In production, real FOA ingestion would:
  // 1. Parse NIH Guide RSS feeds: https://grants.nih.gov/funding/searchguide/index.html
  // 2. Use NIH RePORTER API to identify active programs
  // 3. Cross-reference with specific open FOAs with real deadlines
  
  const opportunities = [];
  
  // Common NIH funding mechanisms (baseline templates, not verified opportunities)
  const nihMechanisms = [
    {
      title: 'NIH R01 Research Project Grant (Mechanism)',
      description: 'Support for health-related research and development based on mission of NIH',
      activity_code: 'R01',
      url: 'https://grants.nih.gov/grants/funding/r01.htm'
    },
    {
      title: 'NIH R21 Exploratory/Developmental Research Grant (Mechanism)',
      description: 'Support for novel scientific ideas or new model systems, tools, or technologies',
      activity_code: 'R21',
      url: 'https://grants.nih.gov/grants/funding/r21.htm'
    },
    {
      title: 'NIH R43/R44 SBIR (Small Business Innovation Research) (Mechanism)',
      description: 'Support for domestic small businesses to engage in research/R&D',
      activity_code: 'R43',
      url: 'https://grants.nih.gov/grants/funding/sbir.htm'
    }
  ];
  
  nihMechanisms.forEach(mech => {
    opportunities.push({
      title: mech.title,
      sponsor: 'National Institutes of Health',
      source: 'nih.gov',
      source_id: mech.activity_code,
      source_url: mech.url,
      description: mech.description,
      eligibility_bullets: [
        'Research institutions',
        'Small businesses (for SBIR)',
        'Nonprofit organizations',
        'U.S. entities'
      ],
      application_url: mech.url,
      is_national: true,
      categories: ['Health', 'Research', 'Biomedical'],
      keywords: ['NIH', 'research', mech.activity_code],
      opportunity_type: 'grant',
      type: 'PROGRAM', // Baseline mechanism, not verified open opportunity
      evidence_url: 'https://grants.nih.gov/funding/searchguide/index.html',
      last_verified_at: null, // Not verified - baseline only
      is_active: false,
      last_crawled: new Date().toISOString(),
      amount_min: 100000,
      amount_max: 500000, // Typical R01 range
      is_loan: false,
      requires_match: false,
      ineligibility_reasons: ['unverified_mechanism_template', 'no_active_foa', 'requires_verified_ingestion'],
      match_decision: 'SKIP',
      match_explanation: 'Baseline mechanism template only. No active FOA verified. Must not enter pipeline until cross-referenced with NIH Guide RSS feed for an open, dated announcement.'
    });
  });
  
  return opportunities;
}

/**
 * Search NSF funding mechanisms (BASELINE/UNVERIFIED)
 * @param {Object} params - Search parameters
 * @returns {Promise<Array>} Array of NSF program baseline entries (PROGRAM type)
 * 
 * NOTE: These are funding mechanism templates, NOT verified open opportunities.
 * Real FOA ingestion requires parsing NSF funding announcements.
 */
export async function searchNSFOpportunities(params = {}) {
  console.log('[NSF] Fetching baseline funding mechanisms');
  
  // In production, real FOA ingestion would:
  // 1. Parse NSF funding opportunities: https://www.nsf.gov/funding/
  // 2. Use NSF Awards API to identify active programs
  // 3. Track specific deadlines from program announcements
  
  const opportunities = [
    {
      title: 'NSF CAREER Award (Mechanism)',
      description: 'Support for early-career faculty who have the potential to serve as academic role models in research and education',
      sponsor: 'National Science Foundation',
      source: 'nsf.gov',
      source_id: 'CAREER',
      source_url: 'https://www.nsf.gov/funding/pgm_summ.jsp?pims_id=503214',
      eligibility_bullets: [
        'Tenure-track faculty',
        'Within 7 years of PhD',
        'U.S. institutions'
      ],
      application_url: 'https://www.nsf.gov/funding/pgm_summ.jsp?pims_id=503214',
      is_national: true,
      categories: ['Research', 'Education', 'STEM'],
      keywords: ['NSF', 'CAREER', 'research', 'faculty'],
      opportunity_type: 'grant',
      type: 'PROGRAM', // Baseline mechanism, not verified open opportunity
      evidence_url: 'https://www.nsf.gov/funding/',
      last_verified_at: null, // Not verified - baseline only
      is_active: false,
      last_crawled: new Date().toISOString(),
      amount_min: 400000,
      amount_max: 500000,
      is_loan: false,
      requires_match: false,
      ineligibility_reasons: ['unverified_mechanism_template', 'no_active_foa', 'requires_verified_ingestion'],
      match_decision: 'SKIP',
      match_explanation: 'Baseline mechanism template only. No active FOA verified. Must not enter pipeline until cross-referenced with NSF funding announcements for an open, dated solicitation.'
    }
  ];
  
  return opportunities;
}

/**
 * Get detailed information about an NIH or NSF funding mechanism (baseline)
 */
export async function getResearchOpportunityDetails(opportunityId, agency = 'NIH') {
  if (agency === 'NIH') {
    return {
      title: `NIH ${opportunityId} (Mechanism)`,
      sponsor: 'National Institutes of Health',
      type: 'PROGRAM',
      application_url: null,
      evidence_url: `https://grants.nih.gov/grants/guide/${opportunityId}`,
      last_verified_at: null,
      is_active: false,
      match_decision: 'SKIP',
      ineligibility_reasons: ['unverified_mechanism_template', 'no_application_url']
    };
  } else if (agency === 'NSF') {
    return {
      title: `NSF ${opportunityId} (Mechanism)`,
      sponsor: 'National Science Foundation',
      type: 'PROGRAM',
      application_url: null,
      evidence_url: `https://www.nsf.gov/funding/pgm_summ.jsp?pims_id=${opportunityId}`,
      last_verified_at: null,
      is_active: false,
      match_decision: 'SKIP',
      ineligibility_reasons: ['unverified_mechanism_template', 'no_application_url']
    };
  }
  
  throw new Error(`Unknown agency: ${agency}`);
}

export default {
  searchNIHOpportunities,
  searchNSFOpportunities,
  getResearchOpportunityDetails
};
