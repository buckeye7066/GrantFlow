/**
 * Read-only verification of profile reattachment in an explicit SQLite DB.
 *
 * Required env: VERIFY_REATTACH_DB_PATH, VERIFY_REATTACH_ADMIN_USER_ID, and
 * VERIFY_REATTACH_OUTPUT_PATH.
 */
import Database from 'better-sqlite3';
import { existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import process from 'node:process';

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required; verification has no database defaults`);
  return value;
}

const dbPath = resolve(process.cwd(), requiredEnv('VERIFY_REATTACH_DB_PATH'));
const adminUserId = requiredEnv('VERIFY_REATTACH_ADMIN_USER_ID');
const outputPath = resolve(process.cwd(), requiredEnv('VERIFY_REATTACH_OUTPUT_PATH'));
if (!existsSync(dbPath)) throw new Error(`VERIFY_REATTACH_DB_PATH does not exist: ${dbPath}`);

console.log('=== VERIFYING REATTACH RESULTS ===\n');
console.log(`Database: ${dbPath}\n`);

try {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  const adminUser = db.prepare(`
    SELECT id
    FROM users
    WHERE id = ? AND COALESCE(is_admin, 0) = 1
    LIMIT 1
  `).get(adminUserId);
  if (!adminUser) throw new Error('VERIFY_REATTACH_ADMIN_USER_ID is not a DB-authorized admin');
  
  // Get all profiles with their linked users
  const profiles = db.prepare(`
    SELECT 
      p.id,
      p.display_name as profile_name,
      p.user_id,
      u.display_name as user_name,
      u.primary_email
    FROM profiles p
    LEFT JOIN users u ON p.user_id = u.id
    ORDER BY p.display_name
  `).all();
  
  console.log(`Found ${profiles.length} profiles:\n`);
  
  const linkedProfiles = [];
  const unlinkedProfiles = [];
  
  for (const profile of profiles) {
    if (profile.user_id) {
      linkedProfiles.push(profile);
      console.log(`✓ ${profile.profile_name.padEnd(30)} → ${profile.user_name || 'Unknown'} (${profile.primary_email || 'N/A'})`);
    } else {
      unlinkedProfiles.push(profile);
      console.log(`✗ ${profile.profile_name.padEnd(30)} → NOT LINKED`);
    }
  }
  
  console.log(`\n=== SUMMARY ===`);
  console.log(`Total profiles: ${profiles.length}`);
  console.log(`Linked profiles: ${linkedProfiles.length}`);
  console.log(`Unlinked profiles: ${unlinkedProfiles.length}`);
  
  // Check admin
  console.log(`\n=== CHECKING ADMIN ===`);
  const adminProfiles = db.prepare(`
    SELECT p.display_name, u.display_name as user_name, u.primary_email
    FROM profiles p
    JOIN users u ON p.user_id = u.id
    WHERE u.id = ? AND COALESCE(u.is_admin, 0) = 1
  `).all(adminUserId);
  
  console.log(`Admin has ${adminProfiles.length} linked profiles`);
  if (adminProfiles.length > 0) {
    console.log('Sample profiles:');
    adminProfiles.slice(0, 5).forEach(p => {
      console.log(`  - ${p.display_name}`);
    });
    if (adminProfiles.length > 5) {
      console.log(`  ... and ${adminProfiles.length - 5} more`);
    }
  }
  
  db.close();
  console.log('\n=== VERIFICATION COMPLETE ===');
  
  const results = {
    total: profiles.length,
    linked: linkedProfiles.length,
    unlinked: unlinkedProfiles.length,
    profiles: profiles.map(p => ({
      profile: p.profile_name,
      userId: p.user_id,
      userName: p.user_name,
      email: p.primary_email
    })),
    verified: new Date().toISOString()
  };
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${outputPath}`);
} catch (error) {
  console.error('ERROR:', error.message);
  console.error(error.stack);
  process.exitCode = 1;
}
