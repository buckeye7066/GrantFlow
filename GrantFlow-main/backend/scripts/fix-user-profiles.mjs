import Database from 'better-sqlite3';

const db = new Database('./data/grantflow.db');

console.log('=== Fixing User-Profile Links ===\n');

// Create user_profiles table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'owner',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, profile_id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_profiles_user ON user_profiles(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_profiles_profile ON user_profiles(profile_id);
`);

console.log('✓ Created/verified user_profiles table');

// Get admin user
const admin = db.prepare("SELECT id, primary_email FROM users WHERE is_admin = 1 OR primary_email = 'buckeye7066@gmail.com'").get();
if (!admin) {
  console.error('No admin user found!');
  process.exit(1);
}
console.log(`✓ Admin user: ${admin.primary_email} (${admin.id})`);

// Get all profiles
const profiles = db.prepare('SELECT id, display_name FROM profiles').all();
console.log(`✓ Found ${profiles.length} profiles`);

// Link all profiles to admin
console.log('\nLinking profiles to admin...');
const insert = db.prepare('INSERT OR IGNORE INTO user_profiles (user_id, profile_id, role) VALUES (?, ?, ?)');

let linked = 0;
for (const p of profiles) {
  const result = insert.run(admin.id, p.id, 'admin');
  if (result.changes > 0) {
    console.log(`  ✓ ${p.display_name}`);
    linked++;
  } else {
    console.log(`  - ${p.display_name} (already linked)`);
  }
}

// Also link specific users to their profiles
const userProfileMap = [
  { email: 'angelikaps.rn@gmail.com', profileName: 'Angelika Ptak' },
  { email: 'kathydaniel1975@gmail.com', profileName: 'Kathy Marie Daniel' },
  { email: 'pjandcrdasher@att.net', profileName: 'Paul Jason Dasher' },
  { email: 'rdashermiller@gmail.com', profileName: 'Rachel Miller' },
];

console.log('\nLinking users to their own profiles...');
for (const map of userProfileMap) {
  const user = db.prepare('SELECT id FROM users WHERE primary_email = ?').get(map.email.toLowerCase());
  const profile = db.prepare('SELECT id FROM profiles WHERE display_name = ?').get(map.profileName);
  
  if (user && profile) {
    insert.run(user.id, profile.id, 'owner');
    console.log(`  ✓ ${map.email} -> ${map.profileName}`);
  }
}

// Verify
console.log('\n=== VERIFICATION ===');
const links = db.prepare(`
  SELECT u.primary_email, p.display_name, up.role 
  FROM user_profiles up 
  JOIN users u ON up.user_id = u.id 
  JOIN profiles p ON up.profile_id = p.id
  ORDER BY u.primary_email, p.display_name
`).all();

console.log(`Total links: ${links.length}`);

// Group by user
const byUser = {};
for (const l of links) {
  if (!byUser[l.primary_email]) byUser[l.primary_email] = [];
  byUser[l.primary_email].push(l.display_name);
}

for (const [email, profiles] of Object.entries(byUser)) {
  console.log(`\n${email}:`);
  profiles.forEach(p => console.log(`  - ${p}`));
}

db.close();
console.log('\n✓ Done!');
