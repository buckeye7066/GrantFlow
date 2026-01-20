import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dbPath = join(__dirname, '..', 'backend', 'data', 'grantflow.db');

console.log('=== VERIFYING REATTACH RESULTS ===\n');
console.log(`Database: ${dbPath}\n`);

try {
  const db = new Database(dbPath);
  
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
  
  // Check specific users
  console.log(`\n=== CHECKING TARGET USERS ===`);
  const targetUsers = ['Rachel', 'Josh', 'Olivia', 'Avanell', 'Hollie', 'Brian'];
  
  for (const userName of targetUsers) {
    const userProfiles = db.prepare(`
      SELECT p.display_name, u.display_name as user_name, u.primary_email
      FROM profiles p
      JOIN users u ON p.user_id = u.id
      WHERE LOWER(p.display_name) LIKE LOWER(?)
      AND (LOWER(u.display_name) LIKE LOWER(?) OR LOWER(u.primary_email) LIKE LOWER(?))
    `).all(`%${userName}%`, `%${userName}%`, `%${userName}%`);
    
    if (userProfiles.length > 0) {
      console.log(`\n${userName}:`);
      userProfiles.forEach(p => {
        console.log(`  ✓ ${p.display_name} → ${p.user_name} (${p.primary_email})`);
      });
    } else {
      console.log(`\n${userName}: No linked profiles found`);
    }
  }
  
  // Check admin
  console.log(`\n=== CHECKING ADMIN ===`);
  const adminProfiles = db.prepare(`
    SELECT p.display_name, u.display_name as user_name, u.primary_email
    FROM profiles p
    JOIN users u ON p.user_id = u.id
    WHERE LOWER(u.primary_email) LIKE '%buckeye7066%' OR u.is_admin = 1
  `).all();
  
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
  
  // Write results to file
  import('fs').then(({ writeFileSync }) => {
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
    writeFileSync(join(__dirname, '..', 'verify-reattach-results.json'), JSON.stringify(results, null, 2));
    console.log('\nResults written to verify-reattach-results.json');
  });
} catch (error) {
  console.error('ERROR:', error.message);
  console.error(error.stack);
  
  // Write error to file
  import('fs').then(({ writeFileSync }) => {
    writeFileSync(join(__dirname, '..', 'verify-reattach-error.txt'), error.message + '\n' + error.stack);
  });
  
  process.exit(1);
}
