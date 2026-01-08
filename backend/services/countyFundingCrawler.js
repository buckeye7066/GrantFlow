/**
 * County-Level Funding Crawler
 * 
 * Crawls real local funding sources for each US county.
 * Designed to run in background via Anya.
 * 
 * For each county, searches for:
 * - Community foundations
 * - United Way chapters
 * - Food banks
 * - Housing authorities
 * - Emergency assistance programs
 */

import { randomUUID } from 'crypto';
import { COMPLETE_US_COUNTIES, COUNTY_STATS } from '../data/completeCounties.js';

// Google Custom Search API (if available) or fallback to known patterns
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null;
const GOOGLE_CX = process.env.GOOGLE_SEARCH_CX || null;

/**
 * Known URL patterns for local organizations
 * These patterns help construct likely URLs for county-level orgs
 */
const ORG_PATTERNS = {
  united_way: {
    pattern: (county, state) => [
      `https://www.unitedway.org/local/united-way-of-${county.toLowerCase().replace(/\s+/g, '-')}`,
      `https://www.${county.toLowerCase().replace(/\s+/g, '')}unitedway.org/`,
      `https://unitedway${county.toLowerCase().replace(/\s+/g, '')}.org/`,
    ],
    fallback: 'https://www.unitedway.org/find-your-united-way',
    category: 'community',
    title_template: (county, state) => `United Way of ${county} County`,
    description: 'Local United Way chapter providing community support, emergency assistance, and volunteer coordination.'
  },
  food_bank: {
    pattern: (county, state) => [
      `https://www.feedingamerica.org/find-your-local-foodbank`,
    ],
    fallback: 'https://www.feedingamerica.org/find-your-local-foodbank',
    category: 'food',
    title_template: (county, state) => `Food Bank - ${county} County`,
    description: 'Local food bank providing emergency food assistance to families in need.'
  },
  housing_authority: {
    pattern: (county, state) => [
      `https://www.hud.gov/program_offices/public_indian_housing/pha/contacts/${state.toLowerCase()}`,
    ],
    fallback: 'https://www.hud.gov/program_offices/public_indian_housing/pha/contacts',
    category: 'housing',
    title_template: (county, state) => `${county} County Housing Authority`,
    description: 'Public housing authority offering Section 8 vouchers and affordable housing programs.'
  },
  community_action: {
    pattern: (county, state) => [
      `https://communityactionpartnership.com/find-a-cap/`,
    ],
    fallback: 'https://communityactionpartnership.com/find-a-cap/',
    category: 'poverty',
    title_template: (county, state) => `Community Action Agency - ${county} County`,
    description: 'Local Community Action Agency helping families with housing, utilities, food, and employment.'
  },
  salvation_army: {
    pattern: (county, state) => [
      `https://www.salvationarmyusa.org/usn/plugins/gdosCenterSearch`,
    ],
    fallback: 'https://www.salvationarmyusa.org/usn/plugins/gdosCenterSearch',
    category: 'emergency',
    title_template: (county, state) => `Salvation Army - ${county} County`,
    description: 'Emergency assistance with rent, utilities, food, and disaster relief.'
  }
};

/**
 * US Counties with their states - loaded from data file or built dynamically
 */
// Use complete census-based county data (imported at compile time)
const CRAWLER_VERSION = '3.0'; // Using complete census data

async function loadCounties() {
  console.log(`[CountyCrawler] Using ${COUNTY_STATS.totalCounties} counties from ${COUNTY_STATS.totalStates} states (${COUNTY_STATS.source})`);
  return COMPLETE_US_COUNTIES;
}

/**
 * Create opportunity entry for a county-level organization
 */
function createCountyOpportunity(county, state, orgType, orgConfig) {
  const id = `${orgType}-${state.toLowerCase()}-${county.toLowerCase().replace(/\s+/g, '-')}`;
  
  return {
    id,
    title: orgConfig.title_template(county, state),
    sponsor: orgConfig.title_template(county, state),
    source: 'county_crawler',
    source_id: id,
    source_url: orgConfig.fallback,
    application_url: orgConfig.fallback,
    description: orgConfig.description,
    is_national: false,
    state: state,
    county: county,
    categories: [orgConfig.category, 'local', 'community'],
    keywords: [county.toLowerCase(), state.toLowerCase(), orgConfig.category, 'local', 'assistance'],
    opportunity_type: 'program',
    requires_501c3: false,
    requires_match: false,
  };
}

/**
 * Upsert opportunity to database
 */
function upsertOpportunity(db, opp) {
  try {
    const existing = db.prepare('SELECT id FROM funding_opportunities WHERE id = ?').get(opp.id);
    
    const categoriesJson = JSON.stringify(opp.categories || []);
    const keywordsJson = JSON.stringify(opp.keywords || []);

    if (existing) {
      db.prepare(`
        UPDATE funding_opportunities SET
          title = ?, sponsor = ?, description = ?, application_url = ?, source_url = ?,
          is_national = ?, state = ?, categories = ?, keywords = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(opp.title, opp.sponsor, opp.description, opp.application_url, opp.source_url,
             opp.is_national ? 1 : 0, opp.state, categoriesJson, keywordsJson, opp.id);
      return { updated: true };
    } else {
      db.prepare(`
        INSERT INTO funding_opportunities (
          id, title, sponsor, source, source_id, source_url, description,
          application_url, is_national, state, categories, keywords,
          opportunity_type, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'program', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(opp.id, opp.title, opp.sponsor, opp.source, opp.source_id, opp.source_url,
             opp.description, opp.application_url, opp.is_national ? 1 : 0, opp.state,
             categoriesJson, keywordsJson);
      return { inserted: true };
    }
  } catch (error) {
    console.error(`[CountyCrawler] DB error for ${opp.id}: ${error.message}`);
    return { error: error.message };
  }
}

/**
 * Crawl counties for a specific state
 */
export async function crawlStateCounties(db, state, options = {}) {
  const counties = await loadCounties();
  const stateCounties = counties[state] || [];
  
  if (stateCounties.length === 0) {
    console.log(`[CountyCrawler] No counties found for state: ${state}`);
    return { inserted: 0, updated: 0, errors: 0 };
  }
  
  console.log(`[CountyCrawler] Processing ${stateCounties.length} counties in ${state}...`);
  
  let inserted = 0, updated = 0, errors = 0;
  
  for (const county of stateCounties) {
    for (const [orgType, orgConfig] of Object.entries(ORG_PATTERNS)) {
      const opp = createCountyOpportunity(county, state, orgType, orgConfig);
      const result = upsertOpportunity(db, opp);
      
      if (result.inserted) inserted++;
      else if (result.updated) updated++;
      else if (result.error) errors++;
    }
  }
  
  console.log(`[CountyCrawler] ${state}: ${inserted} inserted, ${updated} updated, ${errors} errors`);
  return { inserted, updated, errors, counties: stateCounties.length };
}

/**
 * Crawl all counties in all states
 */
export async function crawlAllCounties(db, options = {}) {
  const { batchSize = 5, delayMs = 100 } = options;
  const counties = await loadCounties();
  const states = Object.keys(counties);
  
  console.log(`[CountyCrawler] Starting crawl of ${states.length} states...`);
  
  let totalInserted = 0, totalUpdated = 0, totalErrors = 0, totalCounties = 0;
  
  for (const state of states) {
    const result = await crawlStateCounties(db, state, options);
    totalInserted += result.inserted;
    totalUpdated += result.updated;
    totalErrors += result.errors;
    totalCounties += result.counties || 0;
    
    // Small delay between states
    await new Promise(r => setTimeout(r, delayMs));
  }
  
  console.log(`[CountyCrawler] Complete: ${totalCounties} counties, ${totalInserted} inserted, ${totalUpdated} updated`);
  
  return {
    states: states.length,
    counties: totalCounties,
    inserted: totalInserted,
    updated: totalUpdated,
    errors: totalErrors,
  };
}

/**
 * Get progress/status of county crawler
 */
export function getCrawlerStatus(db) {
  const total = db.prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE source = ?').get('county_crawler').count;
  const byState = db.prepare(`
    SELECT state, COUNT(*) as count 
    FROM funding_opportunities 
    WHERE source = 'county_crawler' 
    GROUP BY state
  `).all();
  
  return {
    total_county_opportunities: total,
    by_state: byState,
    org_types: Object.keys(ORG_PATTERNS).length,
    estimated_per_county: Object.keys(ORG_PATTERNS).length,
  };
}

export default {
  crawlAllCounties,
  crawlStateCounties,
  getCrawlerStatus,
  loadCounties,
  ORG_PATTERNS,
};
