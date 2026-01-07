#!/usr/bin/env node
/**
 * Reattach users to their profiles
 * Links Rachel, Josh, Olivia, Avanell, Hollie, Brian to their profiles
 * Links admin to all profiles
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ADMIN_EMAIL } from '../backend/config/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Database path
const dbPath = join(__dirname, '..', 'backend', 'data', 'grantflow.db');
console.log('Database path:', dbPath);

let db;
try {
  db = new Database(dbPath);
  console.log('✅ Database connected');
} catch (error) {
  console.error('❌ Failed to connect to database:', error.message);
  process.exit(1);
}

console.log('🔗 Reattaching users to profiles...\n');

// User name to email mapping (you may need to adjust these based on actual emails)
const userMappings = [
  { name: 'Rachel', emailPattern: 'rachel' },
  { name: 'Josh', emailPattern: 'josh' },
  { name: 'Olivia', emailPattern: 'olivia' },
  { name: 'Avanell', emailPattern: 'avanell' },
  { name: 'Hollie', emailPattern: 'hollie' },
  { name: 'Brian', emailPattern: 'brian' },
];

// Get admin user
const adminUser = db
  .prepare(`
    SELECT id, display_name, primary_email
    FROM users
    WHERE LOWER(primary_email) = LOWER(?)
  `)
  .get(ADMIN_EMAIL);

if (!adminUser) {
  console.error(`❌ Admin user not found with email: ${ADMIN_EMAIL}`);
  process.exit(1);
}

console.log(`✅ Found admin user: ${adminUser.display_name} (${adminUser.primary_email})`);
console.log(`   Admin ID: ${adminUser.id}\n`);

// Get all profiles
const allProfiles = db
  .prepare(`
    SELECT id, display_name, user_id, organization_id
    FROM profiles
    ORDER BY display_name
  `)
  .all();

console.log(`📋 Found ${allProfiles.length} profiles:\n`);

// Process each user mapping
for (const mapping of userMappings) {
  console.log(`\n👤 Processing ${mapping.name}...`);
  
  // Find user by email pattern (case-insensitive)
  const users = db
    .prepare(`
      SELECT id, display_name, primary_email
      FROM users
      WHERE LOWER(primary_email) LIKE LOWER(?)
         OR LOWER(display_name) LIKE LOWER(?)
      ORDER BY primary_email
    `)
    .all(`%${mapping.emailPattern}%`, `%${mapping.name}%`);

  if (users.length === 0) {
    console.log(`   ⚠️  No user found matching "${mapping.name}"`);
    continue;
  }

  if (users.length > 1) {
    console.log(`   ⚠️  Multiple users found, using first match:`);
    users.forEach(u => console.log(`      - ${u.display_name} (${u.primary_email})`));
  }

  const user = users[0];
  console.log(`   ✅ Found user: ${user.display_name} (${user.primary_email})`);
  console.log(`      User ID: ${user.id}`);

  // Find profiles that match this user's name (case-insensitive)
  const matchingProfiles = allProfiles.filter(profile => {
    const profileName = (profile.display_name || '').toLowerCase();
    const userName = mapping.name.toLowerCase();
    return profileName.includes(userName) || userName.includes(profileName);
  });

  if (matchingProfiles.length === 0) {
    console.log(`   ⚠️  No profiles found matching "${mapping.name}"`);
    continue;
  }

  console.log(`   📝 Found ${matchingProfiles.length} matching profile(s):`);
  
  // Update each matching profile
  const updateStmt = db.prepare(`
    UPDATE profiles
    SET user_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  for (const profile of matchingProfiles) {
    const wasLinked = profile.user_id === user.id;
    updateStmt.run(user.id, profile.id);
    
    if (wasLinked) {
      console.log(`      ✓ ${profile.display_name} (already linked)`);
    } else {
      console.log(`      ✓ ${profile.display_name} (linked)`);
    }
  }
}

// Link admin to all profiles
console.log(`\n\n🔐 Linking admin to all profiles...`);

const linkAdminStmt = db.prepare(`
  UPDATE profiles
  SET user_id = ?, updated_at = CURRENT_TIMESTAMP
  WHERE user_id IS NULL OR user_id != ?
`);

// First, link all unlinked profiles to admin
const unlinkedCount = db
  .prepare('SELECT COUNT(*) as count FROM profiles WHERE user_id IS NULL')
  .get().count;

if (unlinkedCount > 0) {
  linkAdminStmt.run(adminUser.id, adminUser.id);
  console.log(`   ✅ Linked ${unlinkedCount} unlinked profiles to admin`);
}

// Also ensure admin has access to all profiles (we'll create a separate mechanism if needed)
// For now, admin can access all profiles through the admin role check

// Summary
console.log(`\n\n📊 Summary:`);
const profileStats = db
  .prepare(`
    SELECT 
      COUNT(*) as total,
      COUNT(user_id) as linked,
      COUNT(CASE WHEN user_id = ? THEN 1 END) as admin_linked
    FROM profiles
  `)
  .get(adminUser.id);

console.log(`   Total profiles: ${profileStats.total}`);
console.log(`   Profiles with user_id: ${profileStats.linked}`);
console.log(`   Profiles linked to admin: ${profileStats.admin_linked}`);

// Show user-to-profile mapping
console.log(`\n\n👥 User-to-Profile Mapping:`);
const userProfileMap = db
  .prepare(`
    SELECT 
      u.display_name as user_name,
      u.primary_email,
      COUNT(p.id) as profile_count,
      GROUP_CONCAT(p.display_name, ', ') as profiles
    FROM users u
    LEFT JOIN profiles p ON p.user_id = u.id
    WHERE u.id IN (
      SELECT DISTINCT user_id FROM profiles WHERE user_id IS NOT NULL
      UNION
      SELECT ? -- admin
    )
    GROUP BY u.id, u.display_name, u.primary_email
    ORDER BY u.display_name
  `)
  .all(adminUser.id);

for (const row of userProfileMap) {
  console.log(`\n   ${row.user_name} (${row.primary_email}):`);
  console.log(`      Profiles: ${row.profile_count}`);
  if (row.profiles) {
    const profileList = row.profiles.split(', ').slice(0, 5);
    profileList.forEach(p => console.log(`         - ${p}`));
    if (row.profile_count > 5) {
      console.log(`         ... and ${row.profile_count - 5} more`);
    }
  }
}

db.close();
console.log(`\n✅ Done!`);
