import Database from 'better-sqlite3';
import crypto from 'crypto';

const db = new Database('./data/grantflow.db');

// Get admin user ID
const adminUser = db.prepare(`SELECT id FROM users WHERE primary_email LIKE '%buckeye7066%' OR is_admin = 1`).get();
const adminId = adminUser?.id;
console.log('Admin ID:', adminId);

// Profile info
const displayName = 'Kathy Marie Daniel';
const email = 'kathydaniel1975@gmail.com';
const phone = '4236611020';

// Check if user already exists
let kathyUser = db.prepare('SELECT id FROM users WHERE primary_email = ?').get(email.toLowerCase());

if (!kathyUser) {
  const userId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO users (id, primary_email, is_admin, created_at)
    VALUES (?, ?, 0, CURRENT_TIMESTAMP)
  `).run(userId, email.toLowerCase());
  kathyUser = { id: userId };
  console.log('Created user for Kathy:', userId);
} else {
  console.log('User already exists:', kathyUser.id);
}

// Create profile
const profileId = crypto.randomUUID();

db.prepare(`
  INSERT INTO profiles (id, display_name, primary_type, status, tags, created_by, user_id)
  VALUES (?, ?, 'individual', 'draft', '[]', 'admin', ?)
`).run(profileId, displayName, kathyUser.id);

// Create basic info section
const basicInfo = { 
  full_name: displayName, 
  email: email, 
  phone: phone, 
  address: ''
};

db.prepare(`
  INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
  VALUES (?, 'basic_information', ?, 'admin')
`).run(profileId, JSON.stringify(basicInfo));

console.log('');
console.log('✅ Profile Created:');
console.log('   Name:', displayName);
console.log('   Email:', email);
console.log('   Phone:', phone);
console.log('   Profile ID:', profileId);
console.log('   User ID (Kathy):', kathyUser.id);
console.log('   Linked to Admin:', adminId);
console.log('');
console.log('   View at: http://localhost:5173/grantflow/profile/' + profileId);

db.close();
