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

import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { upsertFundingOpportunity } from './opportunityInserter.js';
import { createLogger } from '../utils/logger.js'
const log = createLogger('countyFundingCrawler')

// This crawler historically synthesized one templated "program" per county×org
// (e.g. "United Way of Franklin County") whose application_url was a NATIONAL
// locator page — a dishonest geo-stub that violates the real-URL / honest-
// directory rules and flooded profile pipelines. It is now:
//   1. OFF by default (opt in with COUNTY_FUNDING_CRAWLER_ENABLED=true), and
//   2. when on, emits HONEST DIRECTORY resources (real locator as source_url,
//      application_url=null, "find your local …" titles) — never fake
//      county-specific direct opportunities.
export function isCountyCrawlerEnabled() {
  return String(process.env.COUNTY_FUNDING_CRAWLER_ENABLED || 'false').toLowerCase() === 'true'
}

// NOTE: In some hosted environments, the complete county dataset file may not be present
// (e.g. older deploy artifacts / missing repo data folder). We fall back to the bundled JSON.
let COMPLETE_US_COUNTIES = [];
let COUNTY_STATS = { totalCounties: 0, totalStates: 0, source: 'unknown' };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRootDir = join(__dirname, '..', '..');
const fallbackCountiesPath = join(repoRootDir, 'county_batch1.json');

try {
  // Prefer the complete dataset if available.
  // Use dynamic import so a missing file doesn't crash the whole service.
  const mod = await import('../data/completeCounties.js');
  COMPLETE_US_COUNTIES = mod.COMPLETE_US_COUNTIES || [];
  COUNTY_STATS = mod.COUNTY_STATS || COUNTY_STATS;
} catch (error) {
  try {
    const raw = fs.readFileSync(fallbackCountiesPath, 'utf8');
    const parsed = JSON.parse(raw);
    // county_batch1.json format: { [state]: { [countyName]: [zip,...] } } or similar
    const counties = [];
    const states = Object.keys(parsed || {});
    for (const state of states) {
      const byCounty = parsed[state] || {};
      for (const countyName of Object.keys(byCounty)) {
        counties.push({ state, county: countyName });
      }
    }
    COMPLETE_US_COUNTIES = counties;
    COUNTY_STATS = {
      totalCounties: counties.length,
      totalStates: states.length,
      source: 'county_batch1.json fallback',
    };
    console.warn('[CountyCrawler] Falling back to county_batch1.json (completeCounties.js missing)', {
      totalCounties: COUNTY_STATS.totalCounties,
      totalStates: COUNTY_STATS.totalStates,
    });
  } catch (fallbackError) {
    console.error('[CountyCrawler] Failed to load counties dataset', {
      error: String(error?.message || error),
      fallbackError: String(fallbackError?.message || fallbackError),
    });
    COMPLETE_US_COUNTIES = [];
    COUNTY_STATS = { totalCounties: 0, totalStates: 0, source: 'none' };
  }
}

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
    resourceLabel: 'United Way chapter',
    title_template: (county, state) => `United Way of ${county} County`,
    description: 'Local United Way chapter providing community support, emergency assistance, and volunteer coordination.'
  },
  food_bank: {
    pattern: (county, state) => [
      `https://www.feedingamerica.org/find-your-local-foodbank`,
    ],
    fallback: 'https://www.feedingamerica.org/find-your-local-foodbank',
    category: 'food',
    resourceLabel: 'food bank',
    title_template: (county, state) => `Food Bank - ${county} County`,
    description: 'Local food bank providing emergency food assistance to families in need.'
  },
  housing_authority: {
    pattern: (county, state) => [
      // HUD PHA contacts page uses state parameter as query string, not path segment
      `https://www.hud.gov/program_offices/public_indian_housing/pha/contacts?state=${state.toUpperCase()}`,
    ],
    fallback: 'https://www.hud.gov/program_offices/public_indian_housing/pha/contacts',
    category: 'housing',
    resourceLabel: 'public housing authority (Section 8 / vouchers)',
    title_template: (county, state) => `${county} County Housing Authority`,
    description: 'Public housing authority offering Section 8 vouchers and affordable housing programs.'
  },
  community_action: {
    pattern: (county, state) => [
      `https://communityactionpartnership.com/find-a-cap/`,
    ],
    fallback: 'https://communityactionpartnership.com/find-a-cap/',
    category: 'poverty',
    resourceLabel: 'Community Action Agency',
    title_template: (county, state) => `Community Action Agency - ${county} County`,
    description: 'Local Community Action Agency helping families with housing, utilities, food, and employment.'
  },
  salvation_army: {
    pattern: (county, state) => [
      `https://www.salvationarmyusa.org/usn/locate-a-salvation-army/`,
    ],
    fallback: 'https://www.salvationarmyusa.org/usn/locate-a-salvation-army/',
    category: 'emergency',
    resourceLabel: 'Salvation Army office',
    title_template: (county, state) => `Salvation Army - ${county} County`,
    description: 'Emergency assistance with rent, utilities, food, and disaster relief.'
  },
  // Volunteer fire departments — FEMA AFG and SAFER grants, plus state fire assistance
  volunteer_fire_dept: {
    pattern: (county, state) => [
      `https://www.fema.gov/grants/preparedness/firefighters`,
    ],
    fallback: 'https://www.fema.gov/grants/preparedness/firefighters',
    category: 'fire_department',
    resourceLabel: 'fire department grant resources (FEMA AFG/SAFER)',
    title_template: (county, state) => `Volunteer Fire Department Grants - ${county} County`,
    description: 'FEMA Assistance to Firefighters Grant (AFG) and SAFER grants for volunteer fire departments. Equipment, training, and staffing/recruitment grants available annually.'
  },
};

/**
 * US Counties with their states - loaded from data file or built dynamically
 */
// Use complete census-based county data (imported at compile time)
const CRAWLER_VERSION = '3.0'; // Using complete census data

async function loadCounties() {
  log.info(`[CountyCrawler] Using ${COUNTY_STATS.totalCounties} counties from ${COUNTY_STATS.totalStates} states (${COUNTY_STATS.source})`);
  return COMPLETE_US_COUNTIES;
}

/**
 * Create opportunity entry for a county-level organization
 */
function createCountyOpportunity(county, state, orgType, orgConfig) {
  const id = `${orgType}-${state.toLowerCase()}-${county.toLowerCase().replace(/\s+/g, '-')}`;
  // HONEST DIRECTORY shape: this is a finder/locator for a local resource near
  // the county, NOT a specific county program. application_url is null so the
  // policy + relevanceFilter treat it as a directory (never a direct
  // opportunity); the real national locator stays as source_url evidence.
  const resourceLabel = orgConfig.resourceLabel || 'local assistance';
  const title = `Find your local ${resourceLabel} — ${county} County, ${state}`;

  return {
    id,
    title,
    sponsor: orgConfig.resourceLabel || title,
    source: 'county_crawler',
    source_id: id,
    source_url: orgConfig.fallback,
    application_url: null,            // directory: no direct application URL
    url: orgConfig.fallback,
    description: `Directory: ${orgConfig.description} Use this national locator to find the chapter/office serving ${county} County, ${state}.`,
    is_national: false,
    state: state,
    county: county,
    categories: [orgConfig.category, 'local', 'community', 'directory'],
    keywords: [county.toLowerCase(), state.toLowerCase(), orgConfig.category, 'local', 'directory', 'find local'],
    opportunity_type: 'directory',
    opportunity_kind: 'DIRECTORY',
    record_type: 'directory_resource',
    requires_501c3: false,
    requires_match: false,
  };
}

/**
 * Upsert opportunity to database
 */
async function upsertOpportunity(db, opp) {
  try {
    const result = await upsertFundingOpportunity(db, {
      ...opp,
      record_origin: 'live_crawl',
      evidence_url: opp.source_url ?? opp.application_url ?? null,
    })
    return result
  } catch (error) {
    console.error(`[CountyCrawler] DB error for ${opp?.id || opp?.title}: ${error.message}`);
    return { error: error.message };
  }
}

/**
 * Crawl counties for a specific state
 */
export async function crawlStateCounties(db, state, options = {}) {
  if (!isCountyCrawlerEnabled() && options.force !== true) {
    log.info('[CountyCrawler] disabled (set COUNTY_FUNDING_CRAWLER_ENABLED=true to emit honest directory resources)')
    return { inserted: 0, updated: 0, errors: 0, disabled: true };
  }
  const counties = await loadCounties();
  const stateCounties = counties.filter(c => c.state === state);
  
  if (stateCounties.length === 0) {
    log.info(`[CountyCrawler] No counties found for state: ${state}`);
    return { inserted: 0, updated: 0, errors: 0 };
  }
  
  log.info(`[CountyCrawler] Processing ${stateCounties.length} counties in ${state}...`);
  
  let inserted = 0, updated = 0, errors = 0;
  
  for (const county of stateCounties) {
    for (const [orgType, orgConfig] of Object.entries(ORG_PATTERNS)) {
      const opp = createCountyOpportunity(county, state, orgType, orgConfig);
      const result = await upsertOpportunity(db, opp);
      
      if (result.inserted) inserted++;
      else if (result.updated) updated++;
      else if (result.error) errors++;
      else if (result.rejected) {
        log.info(`[CountyCrawler] Suppressed (relevanceFilter): ${opp.id} — ${result.reason}`);
      }
    }
  }
  
  log.info(`[CountyCrawler] ${state}: ${inserted} inserted, ${updated} updated, ${errors} errors`);
  return { inserted, updated, errors, counties: stateCounties.length };
}

/**
 * Crawl all counties in all states
 */
export async function crawlAllCounties(db, options = {}) {
  if (!isCountyCrawlerEnabled() && options.force !== true) {
    log.info('[CountyCrawler] disabled (set COUNTY_FUNDING_CRAWLER_ENABLED=true to emit honest directory resources)')
    return { states: 0, counties: 0, inserted: 0, updated: 0, errors: 0, disabled: true };
  }
  const { batchSize = 5, delayMs = 100 } = options;
  const counties = await loadCounties();
  const states = [...new Set(counties.map(c => c.state))];
  
  log.info(`[CountyCrawler] Starting crawl of ${states.length} states...`);
  
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
  
  log.info(`[CountyCrawler] Complete: ${totalCounties} counties, ${totalInserted} inserted, ${totalUpdated} updated`);
  
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
export async function getCrawlerStatus(db) {
  const totalRow = await db
    .prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE source = ?')
    .get('county_crawler')
  const total = Number(totalRow?.count || 0)

  const byState = await db
    .prepare(`
      SELECT state, COUNT(*) as count 
      FROM funding_opportunities 
      WHERE source = 'county_crawler' 
      GROUP BY state
    `)
    .all()
  
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
