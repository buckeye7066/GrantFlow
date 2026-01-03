#!/usr/bin/env node
/**
 * Test script to validate profile API changes
 * Tests both admin and non-admin user scenarios
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dbPath = join(__dirname, '../backend/data/grantflow.db');

console.log('Testing Profile API Logic\n');
console.log('Database:', dbPath, '\n');

const db = new Database(dbPath);

// Test 1: Count total profiles
console.log('=== Test 1: Total Profiles ===');
const totalProfiles = db.prepare('SELECT COUNT(*) as count FROM profiles').get();
console.log(`Total profiles in database: ${totalProfiles.count}`);

// Test 2: List all profiles
console.log('\n=== Test 2: All Profiles ===');
const allProfiles = db.prepare('SELECT id, display_name, user_id, organization_id FROM profiles ORDER BY display_name').all();
allProfiles.forEach((profile, i) => {
  console.log(`${i + 1}. ${profile.display_name} (ID: ${profile.id})`);
  console.log(`   user_id: ${profile.user_id || 'NULL'}, org_id: ${profile.organization_id || 'NULL'}`);
});

// Test 3: Check user table
console.log('\n=== Test 3: Users ===');
const users = db.prepare('SELECT id, display_name, primary_email, is_admin FROM users LIMIT 5').all();
if (users.length === 0) {
  console.log('No users found in database');
} else {
  users.forEach((user, i) => {
    console.log(`${i + 1}. ${user.display_name} (${user.primary_email})`);
    console.log(`   ID: ${user.id}, Admin: ${user.is_admin ? 'YES' : 'NO'}`);
  });
}

// Test 4: Profiles with user_id set
console.log('\n=== Test 4: Profiles Linked to Users ===');
const linkedProfiles = db.prepare(`
  SELECT p.id, p.display_name, p.user_id, u.display_name as user_name, u.primary_email
  FROM profiles p
  LEFT JOIN users u ON u.id = p.user_id
  WHERE p.user_id IS NOT NULL
  ORDER BY p.display_name
`).all();

if (linkedProfiles.length === 0) {
  console.log('No profiles are linked to any users yet');
} else {
  linkedProfiles.forEach((profile, i) => {
    console.log(`${i + 1}. ${profile.display_name} → ${profile.user_name} (${profile.primary_email})`);
  });
}

// Test 5: Simulate admin query (should return all profiles)
console.log('\n=== Test 5: Admin Query (All Profiles) ===');
const profileSelect = `
  SELECT 
    p.id,
    p.display_name,
    p.user_id,
    p.organization_id,
    o.name AS organization_name
  FROM profiles p
  LEFT JOIN organizations o ON o.id = p.organization_id
`;
const adminProfiles = db.prepare(`${profileSelect} ORDER BY p.created_at DESC`).all();
console.log(`Admin would see: ${adminProfiles.length} profiles`);

// Test 6: Simulate non-admin query for a user with profiles
console.log('\n=== Test 6: Non-Admin Query ===');
if (linkedProfiles.length > 0) {
  const testUserId = linkedProfiles[0].user_id;
  const userProfiles = db.prepare(`${profileSelect} WHERE p.user_id = ? ORDER BY p.created_at ASC`).all(testUserId);
  console.log(`User ${linkedProfiles[0].user_name} would see: ${userProfiles.length} profiles`);
  userProfiles.forEach(p => console.log(`  - ${p.display_name}`));
} else {
  console.log('Cannot simulate: No users have profiles linked yet');
  console.log('Users need to log in for profiles to be automatically assigned');
}

console.log('\n=== Summary ===');
console.log(`✓ Total profiles: ${totalProfiles.count}`);
console.log(`✓ Profiles linked to users: ${linkedProfiles.length}`);
console.log(`✓ Unlinked profiles: ${totalProfiles.count - linkedProfiles.length}`);

if (linkedProfiles.length === 0) {
  console.log('\n⚠️  Note: Profiles will be automatically linked to users when they log in');
  console.log('   Check backend/config/userProfileMappings.js for designated mappings');
}

db.close();
console.log('\n✓ Test complete\n');
