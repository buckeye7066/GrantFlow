#!/usr/bin/env node
/**
 * Seed Real Funding Opportunities
 * 
 * This script removes fake/synthetic grants and replaces them with
 * real funding opportunities that don't require repayment or matching funds.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  FAKE_OPPORTUNITY_SOURCES,
  getPlaceholderUrlSqlPatterns,
} from '../backend/services/shared/opportunityPolicy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../backend/data/grantflow.db');

console.log('=== Seed Real Funding Opportunities ===\n');
console.log('Database:', DB_PATH);

// Connect to database
const db = new Database(DB_PATH);

// Load real opportunities data
const candidatePaths = [
  // Primary (runtime) location; may be excluded from some repo distributions.
  path.join(__dirname, '../backend/data/crawlers/real_funding_opportunities.json'),
  // Repo-tracked fallback fixture so `npm run seed:demo` works on fresh clones.
  path.join(__dirname, '../backend/fixtures/crawlers/real_funding_opportunities.json'),
];
const realOppsPath = candidatePaths.find((p) => fs.existsSync(p)) || null;
if (!realOppsPath) {
  console.error(
    '[seed:demo] Missing real opportunities seed file. Expected one of:\n' +
      candidatePaths.map((p) => `- ${p}`).join('\n') +
      '\n\nFix: add the seed file (or run an ingestion pipeline).',
  );
  process.exit(1);
}
const realOpps = JSON.parse(fs.readFileSync(realOppsPath, 'utf-8'));
console.log('[seed:demo] Using seed file:', realOppsPath);

// Step 1: Remove fake/synthetic opportunities.
//
// Rules sourced from the canonical opportunity policy module so production
// crawlers and seed scripts use the same definitions of "fake". Do NOT add
// new patterns here -- add them to backend/services/shared/opportunityPolicy.js.
console.log('\n1. Removing fake opportunities...');

const fakeSources = FAKE_OPPORTUNITY_SOURCES;

// Script-local synthetic-title patterns remain here because they are
// historical artifacts from older seeds and are not part of the canonical
// opportunity-origin policy. If any of these recur in production data,
// promote them to opportunityPolicy.js.
const fakeTitlePatterns = [
  '%Community Anchor Impact Grant%',
  '%Resilience Boost Opportunity%',
  '%Infrastructure Spark Fund%',
  '%Faith & Community Partnership%',
  '%Diversity & Inclusion Community%',
  '%Generations Support Initiative%',
  '%Safety Net Assistance%',
  '%Family Strengthening Grant%',
  '%(ZIP %'
];

let deleteCount = 0;
for (const source of fakeSources) {
  const result = db.prepare('DELETE FROM funding_opportunities WHERE source = ?').run(source);
  deleteCount += result.changes;
}

for (const pattern of fakeTitlePatterns) {
  const result = db.prepare('DELETE FROM funding_opportunities WHERE title LIKE ?').run(pattern);
  deleteCount += result.changes;
}

// Delete opportunities whose URLs hit any canonical placeholder host.
const _placeholderPatterns = getPlaceholderUrlSqlPatterns();
for (const pattern of _placeholderPatterns) {
  const r = db
    .prepare(
      `DELETE FROM funding_opportunities
       WHERE application_url LIKE ?
          OR url LIKE ?
          OR source_url LIKE ?`,
    )
    .run(pattern, pattern, pattern);
  deleteCount += r.changes;
}

console.log(`   Removed ${deleteCount} fake opportunities (sources=${fakeSources.join(',')}; placeholder_patterns=${_placeholderPatterns.join(',')})`);

// Also clean up grants that reference deleted opportunities
const orphanedGrants = db.prepare(`
  DELETE FROM grants 
  WHERE funding_opportunity_id IS NOT NULL 
  AND funding_opportunity_id NOT IN (SELECT id FROM funding_opportunities)
`).run();
console.log(`   Removed ${orphanedGrants.changes} orphaned grants`);

// Step 2: Insert real opportunities
console.log('\n2. Inserting real funding opportunities...');

const insertStmt = db.prepare(`
  INSERT OR REPLACE INTO funding_opportunities (
    id, title, sponsor, description, amount_min, amount_max, amount_description,
    deadline, application_url, categories, keywords, eligibility_bullets,
    requires_match, requires_501c3, state, source, source_id, is_active,
    opportunity_type, created_at, updated_at
  ) VALUES (
    @id, @title, @sponsor, @description, @amount_min, @amount_max, @amount_description,
    @deadline, @application_url, @categories, @keywords, @eligibility_bullets,
    @requires_match, @requires_501c3, @state, @source, @source_id, 1,
    'grant', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
`);

let insertCount = 0;

// Process all categories
const categories = [
  'federal_grants',
  'foundation_grants', 
  'state_programs',
  'disability_assistance',
  'veteran_assistance',
  'nonprofit_grants'
];

for (const category of categories) {
  const opps = realOpps[category] || [];
  console.log(`   Processing ${category}: ${opps.length} opportunities`);
  
  for (const opp of opps) {
    try {
      insertStmt.run({
        id: crypto.randomUUID(),
        title: opp.title,
        sponsor: opp.sponsor,
        description: opp.description,
        amount_min: opp.amount_min || null,
        amount_max: opp.amount_max || null,
        amount_description: opp.amount_description || null,
        deadline: opp.deadline || null,
        application_url: opp.application_url,
        categories: JSON.stringify(opp.categories || []),
        keywords: JSON.stringify(opp.keywords || []),
        eligibility_bullets: JSON.stringify(opp.eligibility_bullets || []),
        requires_match: opp.requires_match ? 1 : 0,
        requires_501c3: opp.requires_501c3 ? 1 : 0,
        state: opp.state || 'nationwide',
        source: 'verified_real',
        source_id: opp.id
      });
      insertCount++;
    } catch (err) {
      console.error(`   Error inserting ${opp.title}:`, err.message);
    }
  }
}

console.log(`   Inserted ${insertCount} real opportunities`);

// Step 3: Summary
console.log('\n3. Database Summary:');
const totalOpps = db.prepare('SELECT COUNT(*) as count FROM funding_opportunities').get();
const realOppsCount = db.prepare("SELECT COUNT(*) as count FROM funding_opportunities WHERE source = 'verified_real'").get();
const totalGrants = db.prepare('SELECT COUNT(*) as count FROM grants').get();

console.log(`   Total funding opportunities: ${totalOpps.count}`);
console.log(`   Verified real opportunities: ${realOppsCount.count}`);
console.log(`   Total grants in pipeline: ${totalGrants.count}`);

// List sources
const sources = db.prepare('SELECT source, COUNT(*) as count FROM funding_opportunities GROUP BY source').all();
console.log('\n   Opportunities by source:');
for (const s of sources) {
  console.log(`     - ${s.source}: ${s.count}`);
}

db.close();
console.log('\n✅ Done! Database now contains real funding opportunities.');
