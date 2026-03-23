/**
 * DEPRECATED: create-orgs-and-grants.mjs
 *
 * This script uses random/placeholder data (random scores, hardcoded reasons) and
 * bypasses the canonical decision engine (computeMatchDecision). It should NOT be
 * used for seeding profile pipelines.
 *
 * For development seeding, use instead:
 *   node backend/scripts/seed-profile-grants.mjs
 *   node backend/scripts/backfill-profile-pipeline-from-opportunities.mjs
 *
 * Both of the above use computeMatchDecision() as the single decision authority.
 */
import Database from 'better-sqlite3';
import crypto from 'crypto';

const db = new Database('./data/grantflow.db');

console.log('=== CREATING ORGANIZATIONS AND GRANTS ===\n');

// Get profiles
const profiles = db.prepare('SELECT id, display_name, primary_type FROM profiles').all();
console.log(`Found ${profiles.length} profiles`);

// Create organization for each profile
// First ensure profile_organizations table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS profile_organizations (
    profile_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    role TEXT DEFAULT 'owner',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (profile_id, organization_id)
  )
`);

const insertOrg = db.prepare(`
  INSERT OR IGNORE INTO organizations (id, name, created_by)
  VALUES (?, ?, 'system')
`);

const insertProfileOrg = db.prepare(`
  INSERT OR IGNORE INTO profile_organizations (profile_id, organization_id)
  VALUES (?, ?)
`);

console.log('\nCreating organizations...');
for (const profile of profiles) {
  // Use profile ID as org ID for simplicity
  const orgId = profile.id;
  const orgName = profile.display_name;
  
  insertOrg.run(orgId, orgName);
  insertProfileOrg.run(profile.id, orgId);
  console.log(`  ✓ ${orgName}`);
}

// Now seed grants
console.log('\nSeeding grants...');

const opportunities = db.prepare('SELECT * FROM funding_opportunities LIMIT 50').all();
console.log(`Using ${opportunities.length} opportunities`);

const insertGrant = db.prepare(`
  INSERT INTO grants (id, organization_id, funding_opportunity_id, title, funder, amount_requested, status, match_score, match_reasons, notes)
  VALUES (?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?)
`);

let totalGrantsCreated = 0;

for (const profile of profiles) {
  const orgId = profile.id;
  
  // Give each profile 3-5 random opportunities
  const shuffled = opportunities.sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 3 + Math.floor(Math.random() * 3));
  
  for (const opp of selected) {
    const grantId = crypto.randomUUID();
    const matchScore = 70 + Math.floor(Math.random() * 25);
    
    try {
      insertGrant.run(
        grantId,
        orgId,
        opp.id,
        opp.title,
        opp.sponsor || 'Federal',
        opp.amount_max || opp.amount_min || 5000,
        matchScore,
        JSON.stringify(['Matched by crawler', `${matchScore}% relevance`]),
        `Auto-matched for ${profile.display_name}`
      );
      totalGrantsCreated++;
    } catch (err) {
      // Skip duplicates
      if (!err.message.includes('UNIQUE') && !err.message.includes('constraint')) {
        console.log(`  Error: ${err.message.substring(0, 50)}`);
      }
    }
  }
  console.log(`  ${profile.display_name}: ${selected.length} grants`);
}

// Summary
console.log(`\n=== SUMMARY ===`);
console.log(`Organizations: ${db.prepare('SELECT COUNT(*) as c FROM organizations').get().c}`);
console.log(`Grants: ${db.prepare('SELECT COUNT(*) as c FROM grants').get().c}`);

// Show grants per profile
console.log('\nGrants per profile:');
const byProfile = db.prepare(`
  SELECT p.display_name, COUNT(g.id) as grant_count
  FROM profiles p
  LEFT JOIN grants g ON p.id = g.organization_id
  GROUP BY p.id
  ORDER BY grant_count DESC
`).all();

byProfile.forEach(p => {
  const status = p.grant_count > 0 ? '✓' : '✗';
  console.log(`  ${status} ${p.display_name}: ${p.grant_count}`);
});

db.close();
console.log('\n✓ Done!');
