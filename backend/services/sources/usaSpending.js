/**
 * USASpending.gov Connector
 * Fetches real federal funding opportunities from USASpending.gov API
 * API Documentation: https://api.usaspending.gov/docs/
 */

import { fetchWithRetry } from './httpClient.js';
import crypto from 'crypto';
import { createLogger } from '../../utils/logger.js'
const log = createLogger('usaSpending')

const API_BASE = 'https://api.usaspending.gov/api/v2';
const SOURCE_NAME = 'usaspending.gov';

/**
 * Fetch opportunities from USASpending.gov
 * @param {object} options - Fetch options
 * @param {number} options.limit - Max number of records to fetch
 * @param {number} options.page - Page number for pagination
 * @param {string} [options.keyword] - single profile term to keyword-filter awards by
 * @param {string[]} [options.keywords] - multiple terms (merged with keyword)
 * @returns {Promise<object>} Normalized opportunities and metadata
 */
export async function fetchUSASpending(options = {}) {
  const { limit = 100, page = 1, keyword = null, keywords = null } = options;

  // Keyword-filter so a profile pulls the slice of federal awards that match its
  // needs (→ the agencies that fund those needs), not just the biggest awards.
  const kwList = [keyword, ...(Array.isArray(keywords) ? keywords : [])]
    .map((k) => (k === null || k === undefined ? '' : String(k).trim()))
    .filter((k) => k.length >= 3 && k.length <= 60);

  log.info(
    `[usaspending.gov] Fetching opportunities (limit: ${limit}, page: ${page}, terms: ${kwList.length})`,
  );

  try {
    // Use the spending by award endpoint to find recent grants
    const url = `${API_BASE}/search/spending_by_award/`;

    // Build request payload
    const filters = {
      award_type_codes: ['02', '03', '04', '05'], // Grant types
      time_period: [
        {
          start_date: getDateMonthsAgo(12), // Last 12 months
          end_date: getCurrentDate(),
        },
      ],
    };
    if (kwList.length > 0) filters.keywords = kwList;

    const payload = {
      filters,
      fields: [
        'Award ID',
        'Recipient Name',
        'Award Amount',
        'Description',
        'Start Date',
        'End Date',
        'Awarding Agency',
        'Awarding Sub Agency',
        'recipient_location_state_code',
        'Award Type',
        'prime_award_base_transaction_description',
      ],
      page,
      limit,
      order: 'desc',
      sort: 'Award Amount',
    };
    
    const data = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      data: payload,
      timeout: 60000,
    });
    
    // Parse response
    const opportunities = parseUSASpendingResponse(data);
    
    log.info(`[usaspending.gov] Fetched ${opportunities.length} opportunities`);
    
    return {
      opportunities,
      metadata: {
        source: SOURCE_NAME,
        fetched_at: new Date().toISOString(),
        count: opportunities.length,
        page,
        limit,
      },
    };
  } catch (error) {
    console.error(`[usaspending.gov] Error fetching opportunities:`, error.message);
    throw error;
  }
}

/**
 * Parse USASpending.gov API response and normalize to our schema
 */
function parseUSASpendingResponse(data) {
  const opportunities = [];
  
  const results = data?.results || [];
  
  for (const record of results) {
    try {
      const normalized = normalizeUSASpendingRecord(record);
      if (normalized) {
        opportunities.push(normalized);
      }
    } catch (error) {
      console.error('[usaspending.gov] Error normalizing record:', error.message);
      // Continue processing other records
    }
  }
  
  return opportunities;
}

/**
 * Normalize a single USASpending.gov record to our schema
 */
function normalizeUSASpendingRecord(record) {
  const awardId = record['Award ID'] || record.generated_internal_id;
  const recipientName = record['Recipient Name'];
  const awardAmount = parseAmount(record['Award Amount']);
  const description = record.Description || record.prime_award_base_transaction_description || '';
  const startDate = record['Start Date'];
  const endDate = record['End Date'];
  const agency = record['Awarding Agency'] || record['Awarding Sub Agency'];
  const state = record.recipient_location_state_code;
  const awardType = record['Award Type'];
  
  // Skip if missing required fields
  if (!awardId || !recipientName) {
    console.warn('[usaspending.gov] Skipping record missing required fields');
    return null;
  }
  
  // Build source URL
  const sourceUrl = `https://www.usaspending.gov/award/${awardId}`;
  
  // Generate a title from available data
  const title = generateTitle(agency, awardType, recipientName);
  
  // Determine if national (no specific state) or state-specific
  const isNational = !state || state === 'XX';
  
  // Extract keywords from description and agency
  const keywords = extractKeywords(title, description, agency);
  
  // Parse categories from award type
  const categories = parseAwardType(awardType);
  
  // IMPORTANT: USAspending records are PAST AWARDS, not open opportunities.
  // They are stored as type DIRECTORY / is_active=0 so they do not surface
  // as actionable grants. They serve as intelligence for identifying active agencies.
  return {
    id: crypto.randomUUID(),
    source: SOURCE_NAME,
    source_id: awardId,
    source_url: sourceUrl,
    title: cleanText(title),
    sponsor: cleanText(agency),
    description: `[Past award — not an open opportunity] ${cleanText(description)}`,
    application_url: 'https://www.grants.gov/', // Direct users to grants.gov for open solicitations
    deadline: null, // Past awards do not have application deadlines
    deadline_type: 'rolling',
    amount_min: null, // Do NOT fabricate a min amount from award totals
    amount_max: awardAmount,
    amount_description: awardAmount ? `Historical award: $${awardAmount.toLocaleString()}` : null,
    is_national: isNational ? 1 : 0,
    state: isNational ? null : state,
    categories: JSON.stringify(categories),
    keywords: JSON.stringify(keywords),
    eligibility_bullets: JSON.stringify([
      'Historical award data — verify if program is currently accepting applications',
      'Search Grants.gov for open solicitations from this agency',
    ]),
    requires_501c3: 0, // Unknown from this data source
    requires_match: 0, // Unknown from this data source
    match_percentage: null,
    opportunity_type: 'grant',
    // CRITICAL: mark as inactive — this is historical intelligence, not an open grant
    is_active: 0,
    record_origin: 'usaspending_award_history',
    raw_source_payload: JSON.stringify(record),
    last_crawled: new Date().toISOString(),
  };
}

/**
 * Generate a descriptive title
 */
function generateTitle(agency, awardType, recipient) {
  const cleanAgency = agency ? agency.replace(/^Department of /i, '').trim() : 'Federal';
  const cleanType = awardType || 'Grant';
  
  // Keep it concise
  return `${cleanAgency} ${cleanType} Program`;
}

/**
 * Parse award type into categories
 */
function parseAwardType(awardType) {
  const categories = [];
  
  if (!awardType) return categories;
  
  const type = awardType.toLowerCase();
  
  if (type.includes('research')) categories.push('Research');
  if (type.includes('block')) categories.push('Block Grant');
  if (type.includes('formula')) categories.push('Formula Grant');
  if (type.includes('project')) categories.push('Project Grant');
  if (type.includes('cooperative')) categories.push('Cooperative Agreement');
  
  // Default
  if (categories.length === 0) categories.push('Federal Grant');
  
  return categories;
}

/**
 * Extract keywords from text
 */
function extractKeywords(title, description, agency) {
  const keywords = new Set();
  
  // Add agency as keyword
  if (agency) {
    const agencyWords = agency.toLowerCase().split(/\s+/);
    agencyWords.forEach(word => {
      if (word.length > 3 && !['the', 'and', 'for', 'of'].includes(word)) {
        keywords.add(word);
      }
    });
  }
  
  // Extract key terms from title
  const titleWords = title.toLowerCase().split(/\s+/);
  titleWords.forEach(word => {
    if (word.length > 4) keywords.add(word);
  });
  
  // Extract terms from description (first 200 chars)
  const descWords = description.substring(0, 200).toLowerCase().split(/\s+/);
  descWords.forEach(word => {
    if (word.length > 6) keywords.add(word);
  });
  
  return Array.from(keywords).slice(0, 10); // Limit to 10 keywords
}

/**
 * Parse amount string to number
 */
function parseAmount(amountStr) {
  if (!amountStr) return null;
  if (typeof amountStr === 'number') return Math.round(amountStr);
  const cleaned = String(amountStr).replace(/[^0-9.]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : Math.round(parsed);
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
 * Get current date in YYYY-MM-DD format
 */
function getCurrentDate() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get date N months ago in YYYY-MM-DD format
 */
function getDateMonthsAgo(months) {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString().split('T')[0];
}

/**
 * Clean text by removing extra whitespace
 */
function cleanText(text) {
  if (!text) return '';
  return String(text).replace(/\s+/g, ' ').trim();
}

export default {
  fetchUSASpending,
  SOURCE_NAME,
};
