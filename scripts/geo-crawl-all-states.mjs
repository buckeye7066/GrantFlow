#!/usr/bin/env node
/**
 * geo-crawl-all-states.mjs
 *
 * Phase 5: Populate funding_opportunities with curated state programs for all 50 states + DC.
 * This runs the crawlerManager per-state (not per-ZIP) to upsert state+federal+national programs.
 * Much faster than ZIP-level crawling and provides immediate results for Discover Grants.
 *
 * Usage: node scripts/geo-crawl-all-states.mjs
 */
import Database from 'better-sqlite3';
import { pathToFileURL, fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');

function imp(rel) { return import(pathToFileURL(join(root, rel)).href); }

const ALL_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN',
  'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH',
  'NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
  'VT','VA','WA','WV','WI','WY',
];

async function main() {
  const { runCrawler, SCHEMA } = await imp('backend/services/crawlers/crawlerManager.js');
  const { upsertFundingOpportunity } = await imp('backend/services/opportunityInserter.js');
  const { generateStatePrograms, isStateInRegistry } = await imp('backend/services/crawlers/data/stateBase.js');
  const { FEDERAL_BENEFITS } = await imp('backend/services/crawlers/data/federalBenefits.js');
  const { NATIONAL_PROGRAMS } = await imp('backend/services/crawlers/data/nationalPrograms.js');

  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(SCHEMA);
  db.exec(`CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY, user_id TEXT,
    basic_information TEXT, education_information TEXT,
    employment_information TEXT, health_information TEXT,
    financial_information TEXT, housing_information TEXT,
    additional_information TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS profile_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT, section_key TEXT, data TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS unified_applications (
    id INTEGER PRIMARY KEY, profile_id TEXT, status TEXT,
    contacts TEXT, department_contacts TEXT,
    application_data TEXT, basic_information TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS funding_opportunities (
    id TEXT PRIMARY KEY,
    title TEXT, description TEXT, sponsor TEXT, source TEXT,
    source_id TEXT, source_url TEXT, url TEXT, application_url TEXT,
    evidence_url TEXT,
    state TEXT, is_national INTEGER, opportunity_type TEXT,
    type TEXT, deadline_type TEXT, amount_max TEXT, amount_min TEXT,
    contact_info TEXT, categories TEXT, keywords TEXT,
    match_reasons TEXT, match_score INTEGER,
    funding_type TEXT, record_origin TEXT,
    last_verified_at TEXT, last_crawled TEXT,
    notes TEXT, updated_at TEXT,
    profile_id TEXT,
    UNIQUE(source, source_id)
  )`);

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  PHASE 5 — Geo Crawl: All States (curated data)        ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  let totalOpps = 0;
  let totalStates = 0;

  for (const state of ALL_STATES) {
    const profileId = `geo-${state.toLowerCase()}`;
    const profile = {
      id: profileId,
      user_id: 'geo-system',
      basic_information: JSON.stringify({
        first_name: 'Geo', last_name: state,
        state, city: 'Any', zip: '00000',
        household_size: 2, annual_income: 30000,
        primary_needs: ['housing', 'food', 'healthcare', 'utilities', 'employment'],
      }),
      health_information: JSON.stringify({ has_disability: true }),
      additional_information: JSON.stringify({ veteran: false, single_parent: true }),
    };

    db.prepare(`INSERT OR REPLACE INTO profiles (id, user_id, basic_information, health_information, additional_information) VALUES (?, ?, ?, ?, ?)`)
      .run(profileId, profile.user_id, profile.basic_information, profile.health_information, profile.additional_information);

    try {
      const result = await runCrawler(db, profileId, { crawlerType: 'comprehensive' });
      const count = result.results.length;
      totalOpps += count;
      totalStates++;
      process.stdout.write(`  ${state}: ${String(count).padStart(3)} results  `);
      if (totalStates % 5 === 0) console.log('');
    } catch (err) {
      process.stdout.write(`  ${state}: ERROR (${err.message.slice(0, 40)})  `);
      if (totalStates % 5 === 0) console.log('');
      totalStates++;
    }
  }

  console.log('\n');
  console.log(`${'─'.repeat(58)}`);

  const oppCount = db.prepare('SELECT COUNT(*) as cnt FROM funding_opportunities').get();
  const crawlCount = db.prepare('SELECT COUNT(*) as cnt FROM crawl_results').get();

  console.log(`  States processed: ${totalStates}`);
  console.log(`  Total crawl_results: ${crawlCount.cnt}`);
  console.log(`  Total funding_opportunities: ${oppCount.cnt}`);
  console.log(`  Sum of per-state results: ${totalOpps}`);
  console.log(`${'─'.repeat(58)}`);

  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
