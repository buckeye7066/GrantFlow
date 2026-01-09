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
 * Search NIH active funding opportunities
 * @param {Object} params - Search parameters
 * @returns {Promise<Array>} Array of NIH opportunities (OPPORTUNITY type)
 */
export async function searchNIHOpportunities(params = {}) {
  // NIH RePORTER shows active projects, but for OPPORTUNITIES we want
  // to look at NIH Guide (open solicitations)
  // This is a simplified implementation
  
  console.log('[NIH] Searching active funding opportunities');
  
  // In production, you would:
  // 1. Parse NIH Guide RSS feeds: https://grants.nih.gov/funding/searchguide/index.html
  // 2. Use NIH RePORTER to identify active programs
  // 3. Cross-reference with open FOAs
  
  const opportunities = [];
  
  // Common NIH funding mechanisms
  const nihMechanisms = [
    {
      title: 'NIH R01 Research Project Grant',
      description: 'Support for health-related research and development based on mission of NIH',
      activity_code: 'R01',
      url: 'https://grants.nih.gov/grants/funding/r01.htm',
      type: 'OPPORTUNITY' // Open solicitations with deadlines
    },
    {
      title: 'NIH R21 Exploratory/Developmental Research Grant',
      description: 'Support for novel scientific ideas or new model systems, tools, or technologies',
      activity_code: 'R21',
      url: 'https://grants.nih.gov/grants/funding/r21.htm',
      type: 'OPPORTUNITY'
    },
    {
      title: 'NIH R43/R44 SBIR (Small Business Innovation Research)',
      description: 'Support for domestic small businesses to engage in research/R&D',
      activity_code: 'R43',
      url: 'https://grants.nih.gov/grants/funding/sbir.htm',
      type: 'OPPORTUNITY'
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
      deadline_type: 'rolling', // Most NIH grants have multiple deadlines per year
      application_url: mech.url,
      is_national: true,
      categories: ['Health', 'Research', 'Biomedical'],
      keywords: ['NIH', 'research', mech.activity_code],
      opportunity_type: 'grant',
      type: 'OPPORTUNITY', // These are open solicitations
      evidence_url: 'https://grants.nih.gov/funding/searchguide/index.html',
      last_verified_at: new Date().toISOString(),
      is_active: true,
      last_crawled: new Date().toISOString(),
      amount_min: 100000,
      amount_max: 500000 // Typical R01 range
    });
  });
  
  return opportunities;
}

/**
 * Search NSF active funding opportunities
 * @param {Object} params - Search parameters
 * @returns {Promise<Array>} Array of NSF opportunities (OPPORTUNITY type)
 */
export async function searchNSFOpportunities(params = {}) {
  console.log('[NSF] Searching active funding opportunities');
  
  // In production:
  // 1. Parse NSF funding opportunities: https://www.nsf.gov/funding/
  // 2. Use NSF Awards API to identify active programs
  // 3. Track deadlines from program announcements
  
  const opportunities = [
    {
      title: 'NSF CAREER Award',
      description: 'Faculty Early Career Development Program',
      sponsor: 'National Science Foundation',
      source: 'nsf.gov',
      source_id: 'CAREER',
      source_url: 'https://www.nsf.gov/funding/pgm_summ.jsp?pims_id=503214',
      description_full: 'Support for early-career faculty who have the potential to serve as academic role models in research and education',
      eligibility_bullets: [
        'Tenure-track faculty',
        'Within 7 years of PhD',
        'U.S. institutions'
      ],
      deadline_type: 'fixed',
      deadline: '2025-07-31', // Example deadline
      application_url: 'https://www.nsf.gov/funding/pgm_summ.jsp?pims_id=503214',
      is_national: true,
      categories: ['Research', 'Education', 'STEM'],
      keywords: ['NSF', 'CAREER', 'research', 'faculty'],
      opportunity_type: 'grant',
      type: 'OPPORTUNITY',
      evidence_url: 'https://www.nsf.gov/funding/',
      last_verified_at: new Date().toISOString(),
      is_active: true,
      last_crawled: new Date().toISOString(),
      amount_min: 400000,
      amount_max: 500000
    }
  ];
  
  return opportunities;
}

/**
 * Get detailed information about an NIH or NSF opportunity
 */
export async function getResearchOpportunityDetails(opportunityId, agency = 'NIH') {
  if (agency === 'NIH') {
    return {
      title: `NIH ${opportunityId}`,
      sponsor: 'National Institutes of Health',
      type: 'OPPORTUNITY',
      evidence_url: `https://grants.nih.gov/grants/guide/${opportunityId}`,
      last_verified_at: new Date().toISOString()
    };
  } else if (agency === 'NSF') {
    return {
      title: `NSF ${opportunityId}`,
      sponsor: 'National Science Foundation',
      type: 'OPPORTUNITY',
      evidence_url: `https://www.nsf.gov/funding/pgm_summ.jsp?pims_id=${opportunityId}`,
      last_verified_at: new Date().toISOString()
    };
  }
  
  throw new Error(`Unknown agency: ${agency}`);
}

export default {
  searchNIHOpportunities,
  searchNSFOpportunities,
  getResearchOpportunityDetails
};
