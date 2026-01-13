import Database from 'better-sqlite3';
import crypto from 'crypto';

const db = new Database('./data/grantflow.db');

// Get admin user ID
const adminUser = db.prepare(`SELECT id FROM users WHERE primary_email LIKE '%buckeye7066%' OR is_admin = 1`).get();
const adminId = adminUser?.id;
console.log('Admin ID:', adminId);

// Create profile
const profileId = crypto.randomUUID();
const displayName = 'Anastasia';

db.prepare(`
  INSERT INTO profiles (id, display_name, primary_type, status, tags, created_by)
  VALUES (?, ?, 'individual', 'draft', '[]', 'admin')
`).run(profileId, displayName);

// Create basic info section
const basicInfo = { 
  full_name: 'Anastasia', 
  email: '', 
  phone: '', 
  address: '', 
  notes: 'Profile created from Anastasia profile.pdf' 
};

db.prepare(`
  INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
  VALUES (?, 'basic_information', ?, 'admin')
`).run(profileId, JSON.stringify(basicInfo));

console.log('');
console.log('✅ Profile Created:');
console.log('   Name:', displayName);
console.log('   Profile ID:', profileId);
console.log('   Linked to Admin:', adminId);
console.log('');
console.log('   View at: http://localhost:5173/grantflow/profile/' + profileId);

db.close();
