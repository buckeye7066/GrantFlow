import Database from 'better-sqlite3';

const db = new Database('./data/grantflow.db');

console.log('=== LINKING PROFILES TO ORGANIZATIONS ===\n');

// Get profile-org links
const links = db.prepare('SELECT profile_id, organization_id FROM profile_organizations').all();
console.log(`Found ${links.length} profile-org links`);

// Update profiles with organization_id
const update = db.prepare('UPDATE profiles SET organization_id = ? WHERE id = ?');

let updated = 0;
for (const link of links) {
  const result = update.run(link.organization_id, link.profile_id);
  updated += result.changes;
}

console.log(`Updated ${updated} profiles with organization_id\n`);

// Verify all profiles
const profiles = db.prepare('SELECT id, display_name, organization_id FROM profiles').all();
console.log('Profile -> Organization Status:');

for (const p of profiles) {
  const status = p.organization_id ? '✓' : '✗';
  const orgName = p.organization_id ? p.organization_id.substring(0, 8) + '...' : 'MISSING';
  console.log(`  ${status} ${p.display_name.substring(0, 30).padEnd(30)} -> ${orgName}`);
}

// Also verify grants are linked properly
const grantCounts = db.prepare(`
  SELECT p.display_name, COUNT(g.id) as grants
  FROM profiles p
  LEFT JOIN grants g ON p.organization_id = g.organization_id
  GROUP BY p.id
  ORDER BY grants DESC
`).all();

console.log('\nGrants visible per profile:');
for (const gc of grantCounts) {
  const status = gc.grants > 0 ? '✓' : '✗';
  console.log(`  ${status} ${gc.display_name.substring(0, 30).padEnd(30)} -> ${gc.grants} grants`);
}

db.close();
console.log('\n✓ Done!');
