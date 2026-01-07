import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Allow DB_PATH override like check-profiles.mjs
const resolvedDbPath = process.env.DB_PATH
  ? join(process.cwd(), process.env.DB_PATH)
  : join(__dirname, '..', 'backend', 'data', 'grantflow.db');

try {
  console.log('Connecting to database...');
  console.log(`Database path: ${resolvedDbPath}`);
  const db = new Database(resolvedDbPath);
  console.log('Connected!\n');

  // Get admin user (buckeye7066@gmail.com)
  const adminUser = db.prepare(`
    SELECT id, display_name, primary_email
    FROM users
    WHERE LOWER(primary_email) LIKE '%buckeye7066%' OR is_admin = 1
    LIMIT 1
  `).get();

  if (!adminUser) {
    console.error('ERROR: Admin user not found');
    process.exit(1);
  }

  console.log(`Admin: ${adminUser.display_name} (${adminUser.id})\n`);

  // User mappings - find by name in profile display_name
  const userNames = ['Rachel', 'Josh', 'Olivia', 'Avanell', 'Hollie', 'Brian'];
  const linked = [];

  for (const userName of userNames) {
    console.log(`Processing ${userName}...`);
    
    // Find user
    const user = db.prepare(`
      SELECT id, display_name, primary_email
      FROM users
      WHERE LOWER(display_name) LIKE LOWER(?) OR LOWER(primary_email) LIKE LOWER(?)
      LIMIT 1
    `).get(`%${userName}%`, `%${userName}%`);
    
    if (!user) {
      console.log(`  No user found for ${userName}`);
      continue;
    }
    
    console.log(`  Found user: ${user.display_name} (${user.primary_email})`);
    
    // Find matching profiles
    const profiles = db.prepare(`
      SELECT id, display_name, user_id
      FROM profiles
      WHERE LOWER(display_name) LIKE LOWER(?)
    `).all(`%${userName}%`);
    
    if (profiles.length === 0) {
      console.log(`  No profiles found for ${userName}`);
      continue;
    }
    
    // Update profiles
    const updateStmt = db.prepare(`
      UPDATE profiles
      SET user_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    
    for (const profile of profiles) {
      updateStmt.run(user.id, profile.id);
      console.log(`  ✓ Linked profile: ${profile.display_name}`);
      linked.push({ user: user.display_name, profile: profile.display_name });
    }
  }

  // Link admin to all unlinked profiles
  console.log('\nLinking admin to all unlinked profiles...');
  const linkAdminStmt = db.prepare(`
    UPDATE profiles
    SET user_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE user_id IS NULL
  `);
  const adminResult = linkAdminStmt.run(adminUser.id);
  console.log(`  ✓ Linked ${adminResult.changes} unlinked profiles to admin`);

  // Summary
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      COUNT(user_id) as linked
    FROM profiles
  `).get();
  console.log(`\nSummary: ${stats.linked}/${stats.total} profiles have user_id`);

  // Write summary to file
  const summary = {
    admin: adminUser,
    linked,
    adminLinked: adminResult.changes,
    stats,
    completed: new Date().toISOString()
  };
  writeFileSync(join(__dirname, '..', 'reattach-summary.json'), JSON.stringify(summary, null, 2));
  console.log('Summary written to reattach-summary.json');

  db.close();
  console.log('\nDone!');
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  console.error(`Stack: ${error.stack}`);
  process.exit(1);
}
