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
import { createLogger } from '../utils/logger.js';
import { warmCountyCache, countyCachePath } from '../startup/warmCountyCache.js';

const log = createLogger('countyFundingCrawler');

// This crawler historically synthesized one templated "program" per county×org
// (e.g. "United Way of Franklin County") whose application_url was a NATIONAL
// locator page — a dishonest geo-stub that violates the real-URL / honest-
// directory rules and flooded profile pipelines. It is now:
//   1. OFF by default (opt in with COUNTY_FUNDING_CRAWLER_ENABLED=true), and
//   2. when on, emits HONEST DIRECTORY resources (real locator as source_url,
//      application_url=null, "find your local …" titles) — never fake
//      county-specific direct opportunities.
export function isCountyCrawlerEnabled() {
  return String(process.env.COUNTY_FUNDING_CRAWLER_ENABLED || 'false').toLowerCase() === 'true';
}

let COMPLETE_US_COUNTIES = [];
let COUNTY_STATS = { totalCounties: 0, totalStates: 0, source: 'unloaded' };
let countyLoadPromise = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRootDir = join(__dirname, '..', '..');
const fallbackCountiesPath = join(repoRootDir, 'county_batch1.json');

function cleanCountyName(value) {
  return String(value || '').trim();
}

function countyDisplayLabel(value) {
  const county = cleanCountyName(value);
  if (!county) return '';
  return /\b(county|parish|borough|census area|municipality|city and borough|district)$/i.test(county)
    ? county
    : `${county} County`;
}

function countyRowsFromStateMap(parsed) {
  const counties = [];
  const states = Object.keys(parsed || {}).filter((state) => /^[A-Z]{2}$/.test(String(state).toUpperCase()));

  for (const rawState of states) {
    const state = String(rawState).toUpperCase();
    const stateValue = parsed[rawState];
    const countyNames = Array.isArray(stateValue)
      ? stateValue
      : Object.keys(stateValue && typeof stateValue === 'object' ? stateValue : {});

    const seen = new Set();
    for (const value of countyNames) {
      const county = cleanCountyName(value);
      const key = county.toLowerCase();
      if (!county || seen.has(key)) continue;
      seen.add(key);
      counties.push({ state, county });
    }
  }

  return { counties, states: new Set(counties.map((row) => row.state)).size };
}

function installCountyRows(counties, source) {
  COMPLETE_US_COUNTIES = Array.isArray(counties) ? counties : [];
  COUNTY_STATS = {
    totalCounties: COMPLETE_US_COUNTIES.length,
    totalStates: new Set(COMPLETE_US_COUNTIES.map((row) => row.state)).size,
    source,
  };
  return COMPLETE_US_COUNTIES;
}

async function loadLegacyCountyDataset() {
  try {
    const mod = await import('../data/completeCounties.js');
    const counties = Array.isArray(mod.COMPLETE_US_COUNTIES) ? mod.COMPLETE_US_COUNTIES : [];
    if (counties.length > 0) return installCountyRows(counties, 'completeCounties.js');
  } catch {
    // Legacy generated file is optional. Fall through to the next real source.
  }

  try {
    const raw = fs.readFileSync(fallbackCountiesPath, 'utf8');
    const parsed = JSON.parse(raw);
    const { counties } = countyRowsFromStateMap(parsed);
    if (counties.length > 0) return installCountyRows(counties, 'county_batch1.json');
  } catch {
    // Legacy root fallback is optional. The canonical generated cache below is
    // the durable on-demand fallback for clean checkouts and Railway boots.
  }

  return null;
}

/**
 * Load the county authority lazily. Disabled crawler imports do not probe
 * optional files or emit false startup errors. When the crawler is enabled on a
 * clean checkout, reuse GrantFlow's existing offline ZIP-backed county cache
 * generator instead of requiring an untracked data file.
 */
export async function loadCounties() {
  if (COMPLETE_US_COUNTIES.length > 0) return COMPLETE_US_COUNTIES;
  if (countyLoadPromise) return countyLoadPromise;

  countyLoadPromise = (async () => {
    const legacy = await loadLegacyCountyDataset();
    if (legacy?.length) return legacy;

    const warmResult = await warmCountyCache();
    const cachePath = warmResult?.path || countyCachePath();

    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const { counties } = countyRowsFromStateMap(parsed);
      if (counties.length > 0) {
        return installCountyRows(counties, 'zipcodes-backed counties_by_state cache');
      }
    } catch (error) {
      const warmReason = warmResult?.error || warmResult?.skipped || 'unknown';
      throw new Error(
        `County dataset unavailable after cache warm (${warmReason}): ${error?.message || error}`,
      );
    }

    throw new Error(
      `County dataset unavailable after cache warm (${warmResult?.error || warmResult?.skipped || 'empty cache'})`,
    );
  })().catch((error) => {
    countyLoadPromise = null;
    COMPLETE_US_COUNTIES = [];
    COUNTY_STATS = { totalCounties: 0, totalStates: 0, source: 'unavailable' };
    log.error(`[CountyCrawler] County dataset unavailable: ${error?.message || error}`);
    throw error;
  });

  const counties = await countyLoadPromise;
  log.info(
    `[CountyCrawler] Using ${COUNTY_STATS.totalCounties} counties from ${COUNTY_STATS.totalStates} states (${COUNTY_STATS.source})`,
  );
  return counties;
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

const CRAWLER_VERSION = '3.1';

/**
 * Create opportunity entry for a county-level organization
 */
function createCountyOpportunity(county, state, orgType, orgConfig) {
  const countyLabel = countyDisplayLabel(county);
  const id = `${orgType}-${state.toLowerCase()}-${cleanCountyName(county).toLowerCase().replace(/\s+/g, '-')}`;
  // HONEST DIRECTORY shape: this is a finder/locator for a local resource near
  // the county, NOT a specific county program. application_url is null so the
  // policy + relevanceFilter treat it as a directory (never a direct
  // opportunity); the real national locator stays as source_url evidence.
  const resourceLabel = orgConfig.resourceLabel || 'local assistance';
  const title = `Find your local ${resourceLabel} — ${countyLabel}, ${state}`;

  return {
    id,
    title,
    sponsor: orgConfig.resourceLabel || title,
    source: 'county_crawler',
    source_id: id,
    source_url: orgConfig.fallback,
    application_url: null,
    url: orgConfig.fallback,
    description: `Directory: ${orgConfig.description} Use this national locator to find the chapter/office serving ${countyLabel}, ${state}.`,
    is_national: false,
    state,
    county: cleanCountyName(county),
    categories: [orgConfig.category, 'local', 'community', 'directory'],
    keywords: [cleanCountyName(county).toLowerCase(), state.toLowerCase(), orgConfig.category, 'local', 'directory', 'find local'],
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
    });
    return result;
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
    log.info('[CountyCrawler] disabled (set COUNTY_FUNDING_CRAWLER_ENABLED=true to emit honest directory resources)');
    return { inserted: 0, updated: 0, errors: 0, disabled: true };
  }
  const counties = await loadCounties();
  const stateCode = String(state || '').trim().toUpperCase();
  const stateCounties = counties.filter(c => c.state === stateCode);

  if (stateCounties.length === 0) {
    log.info(`[CountyCrawler] No counties found for state: ${stateCode}`);
    return { inserted: 0, updated: 0, errors: 0, counties: 0 };
  }

  log.info(`[CountyCrawler] Processing ${stateCounties.length} counties in ${stateCode}...`);

  let inserted = 0, updated = 0, errors = 0;

  for (const county of stateCounties) {
    for (const [orgType, orgConfig] of Object.entries(ORG_PATTERNS)) {
      const opp = createCountyOpportunity(county.county, stateCode, orgType, orgConfig);
      const result = await upsertOpportunity(db, opp);

      if (result.inserted) inserted++;
      else if (result.updated) updated++;
      else if (result.error) errors++;
      else if (result.rejected) {
        log.info(`[CountyCrawler] Suppressed (relevanceFilter): ${opp.id} — ${result.reason}`);
      }
    }
  }

  log.info(`[CountyCrawler] ${stateCode}: ${inserted} inserted, ${updated} updated, ${errors} errors`);
  return { inserted, updated, errors, counties: stateCounties.length };
}

/**
 * Crawl all counties in all states
 */
export async function crawlAllCounties(db, options = {}) {
  if (!isCountyCrawlerEnabled() && options.force !== true) {
    log.info('[CountyCrawler] disabled (set COUNTY_FUNDING_CRAWLER_ENABLED=true to emit honest directory resources)');
    return { states: 0, counties: 0, inserted: 0, updated: 0, errors: 0, disabled: true };
  }
  const { batchSize = 5, delayMs = 100 } = options;
  void batchSize;
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
    .get('county_crawler');
  const total = Number(totalRow?.count || 0);

  const byState = await db
    .prepare(`
      SELECT state, COUNT(*) as count
      FROM funding_opportunities
      WHERE source = 'county_crawler'
      GROUP BY state
    `)
    .all();

  return {
    total_county_opportunities: total,
    by_state: byState,
    org_types: Object.keys(ORG_PATTERNS).length,
    estimated_per_county: Object.keys(ORG_PATTERNS).length,
    crawler_version: CRAWLER_VERSION,
    dataset: { ...COUNTY_STATS },
  };
}

export default {
  crawlAllCounties,
  crawlStateCounties,
  getCrawlerStatus,
  loadCounties,
  ORG_PATTERNS,
};
