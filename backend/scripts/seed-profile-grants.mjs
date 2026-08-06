import Database from 'better-sqlite3';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import {
  computeMatchDecision,
  normalizeProfile,
  normalizeOpportunity,
  computeProfileFingerprint,
  computeOpportunityFingerprint,
  MATCHER_VERSION,
} from '../services/matchDecisionEngine.js';

// Safety guard: refuse to run in production or when seeding is explicitly disabled.
const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase()
const disableSeeding = String(process.env.DISABLE_SEEDING || '').trim().toLowerCase()
if (nodeEnv === 'production' || disableSeeding === 'true' || disableSeeding === '1') {
  console.error('[seed-profile-grants] Refusing to run in production environment. Seeding disabled.')
  process.exit(1)
}

if (/^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || '')) {
  console.error('[seed-profile-grants] Refusing to seed a PostgreSQL target; this helper is SQLite-only.')
  process.exit(1)
}

const db = new Database('./data/grantflow.db');

console.log('=== SEEDING GRANTS FOR PROFILES ===\n');

// Get profiles
const profiles = db.prepare('SELECT * FROM profiles').all();
console.log(`Found ${profiles.length} profiles`);

// Get funding opportunities
const opportunities = db.prepare('SELECT * FROM funding_opportunities WHERE is_active = 1 OR is_active IS NULL LIMIT 500').all();
console.log(`Found ${opportunities.length} opportunities\n`);

// Detect whether decision columns are present in the grants table
const _grantsCols = db.prepare('PRAGMA table_info(grants)').all().map(c => c.name);
const _hasDecisionCols = _grantsCols.includes('match_decision');

// Insert grants — include profile_id for correct pipeline scoping
// When decision columns are present (migrated schema), store full canonical metadata.
const insertGrant = _hasDecisionCols
  ? db.prepare(`
      INSERT INTO grants (
        id, organization_id, profile_id, funding_opportunity_id, title, funder,
        amount_requested, status, match_score, match_reasons, notes,
        match_decision, match_explanation, matched_needs, eligibility_status,
        ineligibility_reasons, profile_fingerprint, opportunity_fingerprint,
        matcher_version, evaluated_at, match_confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
  : db.prepare(`
      INSERT INTO grants (id, organization_id, profile_id, funding_opportunity_id, title, funder, amount_requested, status, match_score, match_reasons, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?)
    `);

let totalGrantsCreated = 0;

for (const profile of profiles) {
  console.log(`\n${profile.display_name}:`);

  // Get profile sections
  const sectionRows = db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profile.id);
  const sections = {};
  for (const row of sectionRows) {
    try { sections[row.section_key] = JSON.parse(row.data || '{}'); } catch { sections[row.section_key] = {}; }
  }

  // Adjudicate the complete query-bounded set before ranking. The canonical
  // ACCEPT state is the only automatic pipeline admission state.
  const acceptedCandidates = [];
  for (const opp of opportunities) {
    try {
      const decision = computeMatchDecision(profile, opp, { profileSections: sections });
      if (decision.decision === 'ACCEPT') acceptedCandidates.push({ opp, decision });
    } catch (error) {
      console.warn(
        `  Canonical adjudication failed for ${opp.id || opp.title || 'unknown'}:`,
        error?.message || error,
      );
    }
  }
  acceptedCandidates.sort(
    (a, b) => Number(b.decision.score || 0) - Number(a.decision.score || 0),
  );
  console.log(
    `  Canonically adjudicated ${opportunities.length} candidates; ` +
    `${acceptedCandidates.length} ACCEPT`,
  );

  const profileFingerprint = _hasDecisionCols
    ? computeProfileFingerprint(normalizeProfile(profile, sections)) ?? null
    : null;

  for (const { opp, decision } of acceptedCandidates) {
    const score = decision.score;
    const grantId = crypto.randomUUID();
    // Ensure org exists
    let orgId = profile.organization_id;
    if (!orgId) {
      const existingOrg = db.prepare('SELECT id FROM organizations WHERE name = ?').get(profile.display_name || '');
      orgId = existingOrg?.id || crypto.randomUUID();
      if (!existingOrg) {
        db.prepare(`INSERT INTO organizations (id, name, applicant_type, created_at, updated_at) VALUES (?, ?, 'individual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(orgId, profile.display_name || 'Default Org');
      }
      db.prepare('UPDATE profiles SET organization_id = ? WHERE id = ?').run(orgId, profile.id);
      profile.organization_id = orgId;
    }
    try {
      if (_hasDecisionCols) {
        const opportunityFingerprint = computeOpportunityFingerprint(normalizeOpportunity(opp)) ?? null;
        insertGrant.run(
          grantId,
          orgId,
          profile.id,
          opp.id,
          opp.title,
          opp.sponsor || opp.source,
          opp.amount_max || opp.amount_min || null,
          score,
          JSON.stringify(decision.matchedNeeds ?? []),
          `Auto-matched for ${profile.display_name}`,
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
          grantId,
          orgId,
          profile.id,
          opp.id,
          opp.title,
          opp.sponsor || opp.source,
          opp.amount_max || opp.amount_min || null,
          score,
          JSON.stringify(decision.matchedNeeds ?? []),
          `Auto-matched for ${profile.display_name}`,
        );
      }
      console.log(`  ✓ ${opp.title.substring(0, 50)}... (canonical score ${score}; ${decision.decision})`);
      totalGrantsCreated++;
    } catch (err) {
      // Skip duplicates
      if (!err.message.includes('UNIQUE')) {
        console.log(`  ✗ ${err.message.substring(0, 50)}`);
      }
    }
  }
}

console.log(`\n=== SUMMARY ===`);
console.log(`Total grants created: ${totalGrantsCreated}`);

// Verify
const grantCount = db.prepare('SELECT COUNT(*) as c FROM grants').get().c;
console.log(`Grants in database: ${grantCount}`);

// Show grants per profile
console.log('\nGrants per profile:');
const byProfile = db.prepare(`
  SELECT p.display_name, COUNT(g.id) as grant_count
  FROM profiles p
  LEFT JOIN grants g ON p.id = g.profile_id
  GROUP BY p.id
  ORDER BY grant_count DESC
`).all();

byProfile.forEach(p => {
  console.log(`  ${p.display_name}: ${p.grant_count}`);
});

db.close();
console.log('\n✓ Done!');
