/**
 * Grants.gov Connector
 * Fetches real funding opportunities from the official Grants.gov API
 * API Documentation: https://www.grants.gov/web/grants/support/technical-support/api.html
 */

import { fetchWithRetry } from './httpClient.js';
import crypto from 'crypto';

const API_BASE = 'https://www.grants.gov/grantsws/rest/opportunities/search';
const SOURCE_NAME = 'grants.gov';

/**
 * Fetch opportunities from Grants.gov
 * @param {object} options - Fetch options
 * @param {number} options.limit - Max number of records to fetch
 * @param {number} options.offset - Offset for pagination
 * @returns {Promise<object>} Normalized opportunities and metadata
 */
export async function fetchGrantsGov(options = {}) {
  const { limit = 100, offset = 0 } = options;
  
  console.log(`[grants.gov] Fetching opportunities (limit: ${limit}, offset: ${offset})`);
  
  try {
    // Build query string
    // Only fetch posted opportunities (status: posted)
    const url = `${API_BASE}/`;
    const params = {
      oppNum: '', // Empty to get all
      oppStatus: 'posted', // Only active posted opportunities
      rows: limit,
      startRecordNum: offset,
    };
    
    const data = await fetchWithRetry(url, { 
      method: 'GET',
      params,
      timeout: 60000, // 60 second timeout for this API
    });
    
    // Parse response
    const opportunities = parseGrantsGovResponse(data);
    
    console.log(`[grants.gov] Fetched ${opportunities.length} opportunities`);
    
    return {
      opportunities,
      metadata: {
        source: SOURCE_NAME,
        fetched_at: new Date().toISOString(),
        count: opportunities.length,
        offset,
        limit,
      },
    };
  } catch (error) {
    console.error(`[grants.gov] Error fetching opportunities:`, error.message);
    throw error;
  }
}

/**
 * Parse Grants.gov API response and normalize to our schema
 */
function parseGrantsGovResponse(data) {
  const opportunities = [];
  
  // The Grants.gov API returns data in various formats, handle accordingly
  let records = [];
  
  if (data && data.oppHits) {
    records = Array.isArray(data.oppHits) ? data.oppHits : [data.oppHits];
  } else if (Array.isArray(data)) {
    records = data;
  }
  
  for (const record of records) {
    try {
      const normalized = normalizeGrantsGovRecord(record);
      if (normalized) {
        opportunities.push(normalized);
      }
    } catch (error) {
      console.error('[grants.gov] Error normalizing record:', error.message);
      // Continue processing other records
    }
  }
  
  return opportunities;
}

/**
 * Normalize a single Grants.gov record to our schema
 */
function normalizeGrantsGovRecord(record) {
  // Extract fields from various possible locations
  const oppNumber = record.number || record.opportunityNumber || record.oppNumber;
  const title = record.opportunityTitle || record.title;
  const agency = record.agencyName || record.agency || record.sponsor;
  const description = record.description || record.synopsis || '';
  const closeDate = record.closeDate || record.archiveDate;
  const postDate = record.postDate || record.openDate;
  const category = record.categoryOfFundingActivity || record.category;
  const eligibility = record.eligibleApplicants || record.eligibility;
  const awardFloor = parseAmount(record.awardFloor || record.estimatedFunding);
  const awardCeiling = parseAmount(record.awardCeiling || record.estimatedFunding);
  const costSharing = record.costSharingOrMatchingRequirement;
  
  // Skip if missing required fields
  if (!oppNumber || !title) {
    console.warn('[grants.gov] Skipping record missing required fields');
    return null;
  }
  
  // Build source URL
  const sourceUrl = `https://www.grants.gov/web/grants/view-opportunity.html?oppId=${oppNumber}`;
  
  // Determine if national or state-specific
  const isNational = !record.state && !record.restrictedState;
  
  // Parse eligibility bullets
  const eligibilityBullets = [];
  if (eligibility) {
    // Eligibility codes from Grants.gov
    const codes = Array.isArray(eligibility) ? eligibility : [eligibility];
    eligibilityBullets.push(...codes.map(code => parseEligibilityCode(code)));
  }
  
  // Parse categories
  const categories = [];
  if (category) {
    const cats = Array.isArray(category) ? category : [category];
    categories.push(...cats);
  }
  
  // Determine if 501c3 required
  const requires501c3 = checkRequires501c3(eligibilityBullets, description);
  
  // Determine if matching funds required
  const requiresMatch = costSharing === 'Yes' || checkRequiresMatch(description);
  
  return {
    id: crypto.randomUUID(),
    source: SOURCE_NAME,
    source_id: oppNumber,
    source_url: sourceUrl,
    title: cleanText(title),
    sponsor: cleanText(agency),
    description: cleanText(description),
    application_url: sourceUrl,
    deadline: parseDate(closeDate),
    deadline_type: closeDate ? 'fixed' : 'rolling',
    amount_min: awardFloor || null,
    amount_max: awardCeiling || null,
    amount_description: formatAmountDescription(awardFloor, awardCeiling),
    is_national: isNational ? 1 : 0,
    state: record.state || null,
    categories: JSON.stringify(categories),
    keywords: JSON.stringify(extractKeywords(title, description, category)),
    eligibility_bullets: JSON.stringify(eligibilityBullets),
    requires_501c3: requires501c3 ? 1 : 0,
    requires_match: requiresMatch ? 1 : 0,
    match_percentage: null, // Not typically specified in the API
    opportunity_type: 'grant',
    is_active: 1,
    raw_source_payload: JSON.stringify(record),
    last_crawled: new Date().toISOString(),
  };
}

/**
 * Parse eligibility code to human-readable text
 */
function parseEligibilityCode(code) {
  const eligibilityMap = {
    '00': 'State governments',
    '01': 'County governments',
    '02': 'City or township governments',
    '04': 'Special district governments',
    '05': 'Independent school districts',
    '06': 'Public and State controlled institutions of higher education',
    '07': 'Native American tribal governments (Federally recognized)',
    '08': 'Public housing authorities/Indian housing authorities',
    '11': 'Native American tribal organizations (other than Federally recognized)',
    '12': 'Nonprofits having a 501(c)(3) status with the IRS, other than institutions of higher education',
    '13': 'Nonprofits that do not have a 501(c)(3) status with the IRS, other than institutions of higher education',
    '20': 'Private institutions of higher education',
    '21': 'Individuals',
    '22': 'For profit organizations other than small businesses',
    '23': 'Small businesses',
    '25': 'Others',
  };
  
  const codeStr = String(code).padStart(2, '0');
  return eligibilityMap[codeStr] || code;
}

/**
 * Check if 501(c)(3) status is required
 */
function checkRequires501c3(eligibilityBullets, description) {
  const text = `${eligibilityBullets.join(' ')} ${description}`.toLowerCase();
  return text.includes('501(c)(3)') || text.includes('501c3');
}

/**
 * Check if matching funds are required
 */
function checkRequiresMatch(description) {
  const text = description.toLowerCase();
  const matchTerms = ['match required', 'matching funds', 'cost sharing required'];
  return matchTerms.some(term => text.includes(term));
}

/**
 * Parse amount string to number
 */
function parseAmount(amountStr) {
  if (!amountStr) return null;
  if (typeof amountStr === 'number') return amountStr;
  const cleaned = String(amountStr).replace(/[^0-9.]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Parse date string to YYYY-MM-DD format
 */
function parseDate(dateStr) {
  if (!dateStr) return null;
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;
    return date.toISOString().split('T')[0];
  } catch {
    return null;
  }
}

/**
 * Format amount description
 */
function formatAmountDescription(min, max) {
  if (min && max) {
    return `$${min.toLocaleString()} - $${max.toLocaleString()}`;
  } else if (max) {
    return `Up to $${max.toLocaleString()}`;
  } else if (min) {
    return `From $${min.toLocaleString()}`;
  }
  return null;
}

/**
 * Extract keywords from text
 */
function extractKeywords(title, description, category) {
  const keywords = new Set();
  
  // Add category as keyword
  if (category) {
    const cats = Array.isArray(category) ? category : [category];
    cats.forEach(c => keywords.add(c.toLowerCase()));
  }
  
  // Extract key terms from title
  const titleWords = title.toLowerCase().split(/\s+/);
  titleWords.forEach(word => {
    if (word.length > 4) keywords.add(word);
  });
  
  return Array.from(keywords).slice(0, 10); // Limit to 10 keywords
}

/**
 * Clean text by removing extra whitespace
 */
function cleanText(text) {
  if (!text) return '';
  return String(text).replace(/\s+/g, ' ').trim();
}

export default {
  fetchGrantsGov,
  SOURCE_NAME,
};
