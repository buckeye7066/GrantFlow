/**
 * NIH/NSF Feeds Connector
 * Research funding opportunities from NIH RePORTER and NSF Awards
 *
 * NIH RePORTER API v2: https://api.reporter.nih.gov/v2/
 *   - FOA search: POST https://api.reporter.nih.gov/v2/grants/search
 * NSF Awards API: https://api.nsf.gov/services/v1/awards.json
 *   (Note: research.gov/awardapi-service/v1/ is an older path; api.nsf.gov is canonical)
 *
 * LEGAL: Public domain federal data
 * RATE LIMIT: NIH - 100 req/min, NSF - not specified (use conservative)
 * TOS: Public use encouraged for research purposes
 */

import fetch from 'node-fetch';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('nihNsfConnector');

const NIH_BASE_URL = 'https://api.reporter.nih.gov/v2';
// NOTE: research.gov/awardapi-service/v1/ is a deprecated path.
// The canonical NSF Awards API is https://api.nsf.gov/services/v1/awards.json
const NSF_BASE_URL = 'https://api.nsf.gov/services/v1/awards.json';

const RATE_LIMIT_MS = 600; // ~100 requests per minute for NIH
const DEFAULT_VERIFY_TIMEOUT_MS = 5000;

let lastRequestTime = 0;

/**
 * Rate-limited fetch wrapper.
 *
 * Supports three response modes:
 *   - parse: 'json'     -> returns parsed JSON body (default; used for API reads)
 *   - parse: 'text'     -> returns response text
 *   - parse: 'none'     -> returns { ok, status, statusText } only (used for
 *                          lightweight HEAD verification of mechanism URLs)
 *
 * Timeouts are enforced via AbortController so a hung server can't block
 * crawler runs for minutes. On non-2xx responses we throw in 'json'/'text'
 * modes (keeping legacy behaviour) but simply return the status envelope in
 * 'none' mode so callers can make verify/no-verify decisions on their own.
 */
async function rateLimitedFetch(url, options = {}) {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < RATE_LIMIT_MS) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - timeSinceLastRequest));
  }

  lastRequestTime = Date.now();

  const parse = options.parse || 'json';
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_VERIFY_TIMEOUT_MS;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller?.signal,
      headers: {
        'User-Agent': 'GrantFlow/1.0 (grant management system)',
        ...(parse === 'json' ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });

    if (parse === 'none') {
      return { ok: response.ok, status: response.status, statusText: response.statusText };
    }

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    return parse === 'text' ? response.text() : response.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Verify a URL is reachable with a cheap HEAD request. Returns true on a 2xx
 * response, false otherwise (including aborts/timeouts). Never throws — this
 * is used opportunistically to mark baseline mechanism templates as 'active'
 * without blocking ingestion when the remote service is flaky.
 */
async function verifyUrlReachable(url, options = {}) {
  try {
    const res = await rateLimitedFetch(url, {
      ...options,
      method: 'HEAD',
      parse: 'none',
      timeoutMs: options.timeoutMs || DEFAULT_VERIFY_TIMEOUT_MS,
    });
    return Boolean(res?.ok);
  } catch (err) {
    log.debug('verify.failed', { url, error: err?.message || String(err) });
    return false;
  }
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
  log.info('fetch.baseline_mechanisms', { agency: 'NIH', verify: Boolean(params.verify) });

  // In production, real FOA ingestion would:
  // 1. Parse NIH Guide RSS feeds: https://grants.nih.gov/funding/searchguide/index.html
  // 2. Use NIH RePORTER API to identify active programs
  // 3. Cross-reference with specific open FOAs with real deadlines
  //
  // In the meantime, when `params.verify === true` we perform a lightweight
  // HEAD check against each mechanism URL through rateLimitedFetch. If the URL
  // responds 2xx we stamp `last_verified_at` and flip `is_active` so match
  // ranking can prefer mechanisms that actually resolve. We never flip to
  // is_active: true on failure — verification is opportunistic and never
  // manufactures a false signal.
  const verify = Boolean(params.verify);
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
  
  for (const mech of nihMechanisms) {
    const verifiedAt = verify && (await verifyUrlReachable(mech.url))
      ? new Date().toISOString()
      : null;

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
      eligible_applicant_types: ['institution', 'small_business', 'nonprofit'],
      // Explicitly excludes individual/family/veteran/student applicant types.
      // relevanceFilter MUST hard-reject when profile.applicant_type is
      // 'individual','family','veteran','student','caregiver' and
      // eligible_applicant_types does not include that type.
      application_url: mech.url,
      is_national: true,
      categories: ['Health', 'Research', 'Biomedical'],
      keywords: ['NIH', 'research', mech.activity_code],
      opportunity_type: 'grant',
      type: 'PROGRAM', // Baseline mechanism, not verified open opportunity
      evidence_url: 'https://grants.nih.gov/funding/searchguide/index.html',
      last_verified_at: verifiedAt,
      is_active: Boolean(verifiedAt),
      last_crawled: new Date().toISOString(),
      amount_min: 100000,
      amount_max: 500000, // Typical R01 direct costs per year; modular budget cap $250K/yr
      is_loan: false,
      requires_match: false,
      ineligibility_reasons: verifiedAt
        ? []
        : ['unverified_mechanism_template', 'no_active_foa', 'requires_verified_ingestion'],
      // DO NOT add match_decision or match_explanation here.
      // These fields are owned exclusively by computeMatchDecision() (Goal 4).
      // Callers MUST check is_active === false and type === 'PROGRAM' before
      // forwarding to saveToProfilePipeline(). The connector signals
      // non-readiness via is_active:false + type:'PROGRAM' only.
    });
  }

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
  log.info('fetch.baseline_mechanisms', { agency: 'NSF', verify: Boolean(params.verify) });

  // In production, real FOA ingestion would:
  // 1. Parse NSF funding opportunities: https://www.nsf.gov/funding/
  // 2. Use NSF Awards API to identify active programs
  // 3. Track specific deadlines from program announcements
  //
  // Verification pass (opt-in via params.verify) uses rateLimitedFetch to
  // probe each mechanism URL and stamp last_verified_at / is_active only on
  // a successful response. See searchNIHOpportunities for the same pattern.
  const verify = Boolean(params.verify);

  const nsfMechanisms = [
    {
      title: 'NSF CAREER Award (Mechanism)',
      description: 'Support for early-career faculty who have the potential to serve as academic role models in research and education',
      source_id: 'CAREER',
      url: 'https://www.nsf.gov/funding/pgm_summ.jsp?pims_id=503214',
      amount_min: 400000,
      amount_max: 500000,
      categories: ['Research', 'Education', 'STEM'],
      keywords: ['NSF', 'CAREER', 'research', 'faculty'],
    },
  ];

  const opportunities = [];
  for (const mech of nsfMechanisms) {
    const verifiedAt = verify && (await verifyUrlReachable(mech.url))
      ? new Date().toISOString()
      : null;

    opportunities.push({
      title: mech.title,
      description: mech.description,
      sponsor: 'National Science Foundation',
      source: 'nsf.gov',
      source_id: mech.source_id,
      source_url: mech.url,
      eligibility_bullets: [
        'Tenure-track faculty',
        'Within 7 years of PhD',
        'U.S. institutions'
      ],
      application_url: mech.url,
      is_national: true,
      categories: mech.categories,
      keywords: mech.keywords,
      opportunity_type: 'grant',
      type: 'PROGRAM',
      evidence_url: 'https://www.nsf.gov/funding/',
      last_verified_at: verifiedAt,
      is_active: Boolean(verifiedAt),
      last_crawled: new Date().toISOString(),
      amount_min: mech.amount_min,
      amount_max: mech.amount_max,
      is_loan: false,
      requires_match: false,
      ineligibility_reasons: verifiedAt
        ? []
        : ['unverified_mechanism_template', 'no_active_foa', 'requires_verified_ingestion'],
    });
  }

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
      // application_url intentionally absent: no verified FOA exists.
      // Callers MUST treat absence of application_url as a hard disqualifier
      // per Goal 1. Do NOT insert this record into the pipeline.
      application_url: null,
      evidence_url: `https://grants.nih.gov/grants/guide/${opportunityId}`,
      last_verified_at: null,
      is_active: false,
      ineligibility_reasons: ['unverified_mechanism_template', 'no_application_url']
    };
  } else if (agency === 'NSF') {
    return {
      title: `NSF ${opportunityId} (Mechanism)`,
      sponsor: 'National Science Foundation',
      type: 'PROGRAM',
      // application_url intentionally absent: no verified FOA exists.
      application_url: null,
      evidence_url: `https://www.nsf.gov/funding/pgm_summ.jsp?pims_id=${opportunityId}`,
      last_verified_at: null,
      is_active: false,
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
