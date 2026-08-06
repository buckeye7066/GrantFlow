#!/usr/bin/env node
/**
 * Seed Profile Grants
 * 
 * Seeds each profile with real grants evaluated by the canonical decision engine.
 * Every loaded candidate is adjudicated before canonical ACCEPT rows are ranked
 * and bounded. No heuristic score or secondary relevance filter participates.
 * Only uses verified real funding opportunities - no fakes.
 */

// Safety guard: refuse to run in production or when seeding is explicitly disabled.
const _nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase()
const _disableSeeding = String(process.env.DISABLE_SEEDING || '').trim().toLowerCase()
if (_nodeEnv === 'production' || _disableSeeding === 'true' || _disableSeeding === '1') {
  console.error('[seed-profile-grants] Seeding disabled in production.')
  process.exit(1)
}

if (/^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || '')) {
  console.error('ERROR: This script only supports SQLite databases. DATABASE_URL points to PostgreSQL.')
  console.error('Use the application API or a Postgres client instead.')
  process.exit(1)
}

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  computeMatchDecision,
  normalizeProfile,
  normalizeOpportunity,
  computeProfileFingerprint,
  computeOpportunityFingerprint,
  MATCHER_VERSION,
} from '../backend/services/matchDecisionEngine.js';
import {
  FAKE_OPPORTUNITY_SOURCES,
  getPlaceholderUrlSqlPatterns,
} from '../backend/services/shared/opportunityPolicy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../backend/data/grantflow.db');

console.log('=== Seed Profile Grants (canonical ACCEPT only) ===\n');
console.log('Database:', DB_PATH);

// Connect to database
const db = new Database(DB_PATH);

// Load real opportunities from all data files
function loadAllRealOpportunities() {
  const opportunities = [];
  
  // Load main real opportunities
  const realOppsPath = path.join(__dirname, '../backend/data/crawlers/real_funding_opportunities.json');
  if (fs.existsSync(realOppsPath)) {
    const data = JSON.parse(fs.readFileSync(realOppsPath, 'utf-8'));
    const categories = ['federal_grants', 'foundation_grants', 'state_programs', 
                       'disability_assistance', 'veteran_assistance', 'nonprofit_grants'];
    for (const cat of categories) {
      if (data[cat]) {
        opportunities.push(...data[cat].map(o => ({ ...o, source_category: cat })));
      }
    }
  }
  
  // Load local opportunities
  const localPath = path.join(__dirname, '../backend/data/crawlers/local_opportunities.json');
  if (fs.existsSync(localPath)) {
    const local = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
    opportunities.push(...local.map(o => ({ ...o, source_category: 'local' })));
  }
  
  // Load scholarships
  const scholarPath = path.join(__dirname, '../backend/data/crawlers/scholarship_opportunities.json');
  if (fs.existsSync(scholarPath)) {
    const scholarships = JSON.parse(fs.readFileSync(scholarPath, 'utf-8'));
    opportunities.push(...scholarships.map(o => ({ ...o, source_category: 'scholarship' })));
  }
  
  // Load item funding
  const itemPath = path.join(__dirname, '../backend/data/crawlers/item_funding_sources.json');
  if (fs.existsSync(itemPath)) {
    const items = JSON.parse(fs.readFileSync(itemPath, 'utf-8'));
    opportunities.push(...items.map(o => ({ ...o, source_category: 'item_funding' })));
  }
  
  return opportunities;
}


// Main seeding logic
console.log('\n1. Loading all real funding opportunities...');
const allOpportunities = loadAllRealOpportunities();
console.log(`   Loaded ${allOpportunities.length} real opportunities`);

console.log('\n2. Getting all profiles...');
const profiles = db.prepare('SELECT * FROM profiles WHERE id IS NOT NULL').all();
console.log(`   Found ${profiles.length} profiles`);

// First, clean up any fake grants from profiles using the canonical
// policy lists (backend/services/shared/opportunityPolicy.js). This is the
// SAME source of truth production paths use -- no script-local drift.
console.log('\n3. Removing fake grants from all profiles...');
const _fakeSourcePlaceholders = FAKE_OPPORTUNITY_SOURCES.map(() => '?').join(', ');
const fakeGrantsRemoved = db.prepare(`
  DELETE FROM grants
  WHERE funding_opportunity_id IN (
    SELECT id FROM funding_opportunities
    WHERE source IN (${_fakeSourcePlaceholders})
  )
`).run(...FAKE_OPPORTUNITY_SOURCES);
console.log(`   Removed ${fakeGrantsRemoved.changes} fake grants (canonical sources: ${FAKE_OPPORTUNITY_SOURCES.join(', ')})`);

// Remove grants whose application_url matches a canonical placeholder host.
const _placeholderUrlPatterns = getPlaceholderUrlSqlPatterns();
let _placeholderGrantsTotal = 0;
for (const _pat of _placeholderUrlPatterns) {
  const r = db.prepare(`DELETE FROM grants WHERE application_url LIKE ?`).run(_pat);
  _placeholderGrantsTotal += r.changes;
}
console.log(`   Removed ${_placeholderGrantsTotal} placeholder grants (patterns: ${_placeholderUrlPatterns.join(', ')})`);

// Prepare insert statement — detect whether decision columns are present
const _grantCols = db.prepare('PRAGMA table_info(grants)').all().map(c => c.name);
const _hasDecisionCols = _grantCols.includes('match_decision');

const insertGrant = _hasDecisionCols
  ? db.prepare(`
      INSERT INTO grants (
        id, organization_id, profile_id, title, funder, deadline, status,
        match_score, match_reasons, application_url, amount_requested, notes,
        funding_opportunity_id,
        match_decision, match_explanation, matched_needs, eligibility_status,
        ineligibility_reasons, profile_fingerprint, opportunity_fingerprint,
        matcher_version, evaluated_at, match_confidence
      ) VALUES (?, ?, ?, ?, ?, ?, 'interested', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
  : db.prepare(`
      INSERT INTO grants (
        id, organization_id, profile_id, title, funder, deadline, status,
        match_score, match_reasons, application_url, amount_requested, notes
      ) VALUES (?, ?, ?, ?, ?, ?, 'interested', ?, ?, ?, ?, ?)
    `);

const checkExisting = db.prepare(`
  SELECT id FROM grants WHERE profile_id = ? AND title = ?
`);

console.log('\n4. Seeding grants for each profile...');

let totalGrantsAdded = 0;

for (const profile of profiles) {
  console.log(`\n   Processing: ${profile.display_name || profile.id}`);
  
  // Get profile sections
  const sections = db.prepare('SELECT * FROM profile_sections WHERE profile_id = ?').all(profile.id);

  // Convert sections array to object format for canonical decision engine
  const sectionsObj = {};
  for (const row of sections) {
    try { sectionsObj[row.section_key] = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {}); } catch { sectionsObj[row.section_key] = {}; }
  }
  
  // Get or create organization for this profile
  let orgId = profile.organization_id;
  if (!orgId) {
    // Check if org exists
    const existingOrg = db.prepare('SELECT id FROM organizations WHERE name = ?')
      .get(profile.display_name || 'Default Organization');
    
    if (existingOrg) {
      orgId = existingOrg.id;
    } else {
      orgId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO organizations (id, name, applicant_type, created_at, updated_at)
        VALUES (?, ?, 'individual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(orgId, profile.display_name || 'Default Organization');
    }
    
    // Link profile to org
    db.prepare('UPDATE profiles SET organization_id = ? WHERE id = ?').run(orgId, profile.id);
  }
  
  // Adjudicate the complete loaded set before ranking or applying the output
  // bound. Canonical ACCEPT is the only automatic pipeline admission state.
  const acceptedCandidates = [];
  for (const opp of allOpportunities) {
    try {
      const decision = computeMatchDecision(profile, opp, { profileSections: sectionsObj });
      if (decision.decision === 'ACCEPT') acceptedCandidates.push({ opp, decision });
    } catch (error) {
      console.warn(
        `   Canonical adjudication failed for ${opp.id || opp.title || 'unknown'}:`,
        error?.message || error,
      );
    }
  }
  const candidatePool = acceptedCandidates
    .sort((a, b) => Number(b.decision.score || 0) - Number(a.decision.score || 0))
    .slice(0, 200);
  console.log(
    `   Canonically adjudicated ${allOpportunities.length} candidates; ` +
    `${acceptedCandidates.length} ACCEPT; seeding top ${candidatePool.length}`,
  );

  let addedForProfile = 0;
  const profileFingerprint = _hasDecisionCols
    ? computeProfileFingerprint(normalizeProfile(profile, sectionsObj)) ?? null
    : null;
  for (const { opp, decision } of candidatePool) {
    // Check if already exists for this profile
    const existing = checkExisting.get(profile.id, opp.title);
    if (existing) continue;

    // Use canonical score as the stored match score
    const finalScore = decision.score;

    try {
      if (_hasDecisionCols) {
        const opportunityFingerprint = computeOpportunityFingerprint(normalizeOpportunity(opp)) ?? null;
        insertGrant.run(
          crypto.randomUUID(),
          orgId,
          profile.id,
          opp.title,
          opp.sponsor,
          opp.deadline || null,
          finalScore,
          JSON.stringify(decision.matchedNeeds ?? []),
          opp.application_url || null,
          opp.amount_max || opp.amount_min || null,
          opp.description ? opp.description.substring(0, 500) : null,
          opp.id || null,
          decision.decision,
          decision.explanation ?? null,
          JSON.stringify(decision.matchedNeeds ?? []),
          String(decision.eligible),
          JSON.stringify(decision.ineligibilityReasons ?? []),
          profileFingerprint,
          opportunityFingerprint,
          decision.matcherVersion ?? MATCHER_VERSION,
          decision.evaluatedAt ?? new Date().toISOString(),
          decision.confidence ?? null,
        );
      } else {
        insertGrant.run(
          crypto.randomUUID(),
          orgId,
          profile.id,
          opp.title,
          opp.sponsor,
          opp.deadline || null,
          finalScore,
          JSON.stringify(decision.matchedNeeds ?? []),
          opp.application_url || null,
          opp.amount_max || opp.amount_min || null,
          opp.description ? opp.description.substring(0, 500) : null,
        );
      }
      addedForProfile++;
      totalGrantsAdded++;
    } catch (err) {
      // Ignore duplicate errors
      if (!err.message.includes('UNIQUE')) {
        console.error(`   Error adding ${opp.title}:`, err.message);
      }
    }
  }
  
  console.log(`   Added ${addedForProfile} grants to pipeline`);
}

// Final summary
console.log('\n5. Summary:');
console.log(`   Total grants added: ${totalGrantsAdded}`);

const grantsByProfile = db.prepare(`
  SELECT p.display_name, COUNT(g.id) as grant_count
  FROM profiles p
  LEFT JOIN grants g ON p.id = g.profile_id
  GROUP BY p.id
`).all();

console.log('\n   Grants per profile:');
for (const row of grantsByProfile) {
  console.log(`     - ${row.display_name || 'Unknown'}: ${row.grant_count} grants`);
}

// Verify no fake grants remain (canonical placeholder host list)
const _verifyPatterns = getPlaceholderUrlSqlPatterns();
let _fakeCount = 0;
for (const _pat of _verifyPatterns) {
  const r = db.prepare(`SELECT COUNT(*) AS count FROM grants WHERE application_url LIKE ?`).get(_pat);
  _fakeCount += Number(r?.count || 0);
}
console.log(`\n   Fake grants remaining: ${_fakeCount}`);

db.close();
console.log('\n✅ Done! Each profile now has real grants evaluated by the canonical decision engine.');
