import Database from 'better-sqlite3';

const db = new Database('./data/grantflow.db');

console.log('=== Fixing Profile States ===\n');

// Map profiles to their states based on addresses in their data
const stateUpdates = [
  { name: 'Anastasia Nicole White', state: 'TN', city: 'Cleveland' },
  { name: 'Robert White', state: 'TN', city: 'Cleveland' },
  { name: 'Avanell Lea Leamon', state: 'TN', city: 'Cleveland' },
  { name: 'Brian Nicholas Newman', state: 'TN', city: 'Cleveland' },
  { name: 'Dr. John White', state: 'TN', city: 'Cleveland' },
  { name: 'Focus Forward Ministries', state: 'TN', city: 'Cleveland' },
  { name: 'Gilbert Allen McCosh', state: 'TN', city: 'Cleveland' },
  { name: 'Hollie Machelle Knox', state: 'TN', city: 'Cleveland' },
  { name: 'Kathy Marie Daniel', state: 'TN', city: 'Cleveland' },
  { name: 'Kimberly Botts', state: 'TN', city: 'Cleveland' },
  { name: 'Luibov S Samoylenko', state: 'TN', city: 'Cleveland' },
  { name: 'Olivia Beltran / Hybrid Healing', state: 'TN', city: 'Cleveland' },
  { name: 'Paul Jason Dasher', state: 'TN', city: 'Cleveland' },
  { name: 'Rachel Miller', state: 'TN', city: 'Cleveland' },
  { name: 'Angelika Ptak', state: 'TN', city: 'Cleveland' },
];

for (const update of stateUpdates) {
  const profile = db.prepare('SELECT id FROM profiles WHERE display_name = ?').get(update.name);
  if (!profile) {
    console.log(`❌ Profile not found: ${update.name}`);
    continue;
  }
  
  // Get or create basic_information section
  const existing = db.prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?')
    .get(profile.id, 'basic_information');
  
  let data = {};
  if (existing?.data) {
    try {
      data = JSON.parse(existing.data);
    } catch (e) {
      console.warn(`⚠ Failed to parse existing basic_information JSON for ${update.name}:`, e?.message || e)
      data = {}
    }
  }
  
  // Add state/location if not present
  if (!data.address) data.address = {};
  if (!data.address.state) data.address.state = update.state;
  if (!data.address.city) data.address.city = update.city;
  data.state = update.state;
  data.city = update.city;
  
  db.prepare(`
    INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
    VALUES (?, 'basic_information', ?, 'state-fix')
    ON CONFLICT(profile_id, section_key) DO UPDATE SET
      data = excluded.data,
      updated_at = CURRENT_TIMESTAMP
  `).run(profile.id, JSON.stringify(data));
  
  console.log(`✓ ${update.name}: ${update.city}, ${update.state}`);
}

console.log('\n✓ Done!');
db.close();
