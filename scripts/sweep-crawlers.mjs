#!/usr/bin/env node
/**
 * sweep-crawlers.mjs — Lightweight Phase 4 verification.
 * Tests every crawler_type with a realistic profile against an in-memory DB.
 * Verifies: results > 0, URLs present, match_explain present, score >= threshold.
 */
import Database from 'better-sqlite3';
import { pathToFileURL, fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');

function imp(rel) { return import(pathToFileURL(join(root, rel)).href); }

const PROFILE_ID = 'sweep-test-001';

const PROFILE = {
  id: PROFILE_ID,
  user_id: 'sweep-user',
  basic_information: JSON.stringify({
    first_name: 'Jane', last_name: 'Doe',
    date_of_birth: '1990-05-15', gender: 'female',
    state: 'TN', city: 'Nashville', zip: '37201', county: 'Davidson',
    household_size: 3, annual_income: 22000,
    primary_needs: ['housing', 'food', 'healthcare', 'utilities', 'employment'],
  }),
  education_information: JSON.stringify({
    education_level: 'some_college', enrolled: true,
    school_name: 'Tennessee State University',
    schools: [{ name: 'Tennessee State University', state: 'TN' }],
  }),
  employment_information: JSON.stringify({
    employment_status: 'unemployed',
    occupation: 'retail_worker',
    looking_for_work: true,
  }),
  health_information: JSON.stringify({
    has_disability: true, disability_type: 'physical_disability',
    health_conditions: ['diabetes'],
    needs_mental_health: true,
  }),
  financial_information: JSON.stringify({
    annual_income: 22000, household_size: 3,
    receives_snap: true, receives_medicaid: true,
  }),
  housing_information: JSON.stringify({
    housing_status: 'renting', at_risk_of_homelessness: true,
  }),
  additional_information: JSON.stringify({
    veteran: false, single_parent: true,
    has_children_under_18: true, number_of_children: 2,
    race_ethnicity: 'african_american',
    citizen: true,
  }),
};

const CRAWLER_TYPES = [
  'comprehensive',
  'curated_benefits',
  'local_funding',
  'government_funding',
  'student_grants',
  'health_resources',
  'special_needs',
  'ecf_benefits',
];

async function main() {
  const { runCrawler, SCHEMA } = await imp('backend/services/crawlers/crawlerManager.js');

  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  // funding_opportunities table — must match opportunityInserter's INSERT columns
  db.exec(`CREATE TABLE IF NOT EXISTS funding_opportunities (
    id TEXT PRIMARY KEY,
    title TEXT, description TEXT, sponsor TEXT, source TEXT,
    source_id TEXT, source_url TEXT, evidence_url TEXT,
    contact_info TEXT, record_origin TEXT,
    eligibility_bullets TEXT,
    amount_min REAL, amount_max REAL, amount_description TEXT,
    deadline TEXT, deadline_type TEXT,
    application_url TEXT,
    is_national INTEGER, state TEXT,
    categories TEXT, keywords TEXT,
    opportunity_type TEXT, funding_type TEXT, type TEXT,
    last_verified_at TEXT, profile_id TEXT,
    requires_501c3 INTEGER, requires_match INTEGER,
    match_percentage REAL, match_reasons TEXT, notes TEXT,
    is_active INTEGER DEFAULT 1, last_crawled TEXT,
    UNIQUE(source, source_id)
  )`);

  // profiles table
  db.exec(`CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY, user_id TEXT,
    basic_information TEXT, education_information TEXT,
    employment_information TEXT, health_information TEXT,
    financial_information TEXT, housing_information TEXT,
    additional_information TEXT
  )`);

  const cols = Object.keys(PROFILE);
  const placeholders = cols.map(() => '?').join(', ');
  db.prepare(`INSERT INTO profiles (${cols.join(', ')}) VALUES (${placeholders})`)
    .run(...cols.map(c => PROFILE[c]));

  // profile_sections for profileAnalyzer
  db.exec(`CREATE TABLE IF NOT EXISTS profile_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT, section_key TEXT, data TEXT
  )`);

  // unified_applications for profileAnalyzer
  db.exec(`CREATE TABLE IF NOT EXISTS unified_applications (
    id INTEGER PRIMARY KEY, profile_id TEXT, status TEXT,
    contacts TEXT, department_contacts TEXT,
    application_data TEXT, basic_information TEXT
  )`);

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  PHASE 4 — Crawler Sweep (all types, 1 profile)        ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  let pass = 0, fail = 0, gated = 0;

  for (const type of CRAWLER_TYPES) {
    process.stdout.write(`  ${type.padEnd(22)}`);
    try {
      const result = await runCrawler(db, PROFILE_ID, { crawlerType: type });
      const count = result.results.length;
      const hasUrls = result.results.every(r => r.url || r.applicationUrl);
      const hasExplain = result.results.every(r => r.match_explain);
      const topScore = count > 0 ? result.results[0].matchScore : 0;
      const isGated = result.debug?.gated;

      if (isGated) {
        console.log(`GATED  reason="${result.debug.gateReason}"`);
        gated++;
        continue;
      }

      const issues = [];
      if (count === 0) issues.push('0 results');
      if (!hasUrls) issues.push('missing URLs');
      if (!hasExplain) issues.push('missing match_explain');
      if (topScore < 30) issues.push(`top score too low (${topScore})`);

      if (issues.length === 0) {
        console.log(`PASS   ${count} results  top=${topScore}  intents=[${result.debug.intents}]`);
        pass++;
      } else {
        console.log(`FAIL   ${count} results  top=${topScore}  issues: ${issues.join(', ')}`);
        fail++;
      }
    } catch (err) {
      console.log(`ERROR  ${err.message.slice(0, 80)}`);
      fail++;
    }
  }

  console.log(`\n${'─'.repeat(58)}`);
  console.log(`  PASS: ${pass}  FAIL: ${fail}  GATED: ${gated}  TOTAL: ${CRAWLER_TYPES.length}`);
  console.log(`${'─'.repeat(58)}`);

  db.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
