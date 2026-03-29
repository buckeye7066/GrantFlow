import Database from 'better-sqlite3';
import crypto from 'crypto';

if (/^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || '')) {
  console.error('ERROR: This script only supports SQLite databases. DATABASE_URL points to PostgreSQL.')
  console.error('Use the application API or a Postgres client instead.')
  process.exit(1)
}

const db = new Database('./data/grantflow.db');

// Get admin user ID
const adminUser = db.prepare(`SELECT id FROM users WHERE primary_email LIKE '%buckeye7066%' OR is_admin = 1`).get();
const adminId = adminUser?.id || null;
console.log('Admin user ID:', adminId);

// Helper to create user and profile
function createUserAndProfile({ displayName, email, linkedUsers = [] }) {
  const profileId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  
  // Check if user already exists
  let actualUser = db.prepare('SELECT id FROM users WHERE primary_email = ?').get(email.toLowerCase());
  
  if (!actualUser) {
    // Create user if doesn't exist
    db.prepare(`
      INSERT INTO users (id, primary_email, is_admin, created_at)
      VALUES (?, ?, 0, CURRENT_TIMESTAMP)
    `).run(userId, email.toLowerCase());
    actualUser = { id: userId };
  }
  
  const actualUserId = actualUser.id;
  
  // Create profile
  db.prepare(`
    INSERT INTO profiles (id, display_name, primary_type, status, tags, created_by, user_id)
    VALUES (?, ?, 'individual', 'draft', '[]', 'admin', ?)
  `).run(profileId, displayName, actualUserId);
  
  // Create basic_information section with email
  const basicInfo = {
    full_name: displayName,
    email: email,
    phone: '',
    address: ''
  };
  db.prepare(`
    INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
    VALUES (?, 'basic_information', ?, 'admin')
  `).run(profileId, JSON.stringify(basicInfo));
  
  // Link profile to admin if admin exists - check if table exists first
  if (adminId) {
    try {
      const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='user_profile_access'`).get();
      if (tableExists) {
        db.prepare(`
          INSERT OR IGNORE INTO user_profile_access (user_id, profile_id, access_level, granted_by)
          VALUES (?, ?, 'admin', 'system')
        `).run(adminId, profileId);
      }
    } catch (e) {
      console.log('Note: Could not link to admin:', e.message);
    }
  }
  
  return { profileId, userId: actualUserId, displayName, email };
}

// Create the three profiles
console.log('\n=== Creating Profiles ===\n');

const profiles = [
  {
    displayName: 'Paul Jason Dasher',
    email: 'Pjandcrdasher@att.net',
    linkedUsers: ['Jason Dasher', 'Carrie Dasher']
  },
  {
    displayName: 'Angelika Ptak',
    email: 'angelikaps.rn@gmail.com',
    linkedUsers: ['Angelika']
  },
  {
    displayName: 'Rachel Miller',
    email: 'rdashermiller@gmail.com',
    linkedUsers: ['Rachel Miller']
  }
];

profiles.forEach(p => {
  const result = createUserAndProfile(p);
  console.log(`✅ Created: ${result.displayName}`);
  console.log(`   Profile ID: ${result.profileId}`);
  console.log(`   User ID: ${result.userId}`);
  console.log(`   Email: ${result.email}`);
  console.log('');
});

console.log('=== All profiles created successfully! ===');
console.log('\nThese users can now log in with their email addresses.');
db.close();
