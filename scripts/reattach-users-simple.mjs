/**
 * Reattach profiles in an explicitly confirmed SQLite database.
 *
 * Required env: REATTACH_DB_PATH, REATTACH_CONFIRM_DB_PATH,
 * REATTACH_ADMIN_USER_ID, REATTACH_SUMMARY_PATH, and
 * REATTACH_CONFIRM=REATTACH_PROFILES. Also requires --mappings <private-json>.
 */
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import process from 'node:process';

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required; this mutating script has no database defaults`);
  return value;
}

function requiredArg(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseMappings(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('the reattachment mappings file must be valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 50) {
    throw new Error('the reattachment mappings file must contain 1-50 mappings');
  }
  return parsed.map((candidate, index) => {
    const name = String(candidate?.name || '').trim();
    const emailPattern = String(candidate?.emailPattern || '').trim();
    const safeSelector = (value) => (
      value.length >= 2
      && value.length <= 100
      && !value.includes('%')
      && !value.includes('_')
      && /^[-a-z0-9@.+ ']+$/i.test(value)
    );
    if (!safeSelector(name) || !safeSelector(emailPattern)) {
      throw new Error(`reattachment mapping ${index + 1} has an unsafe selector`);
    }
    return { name, emailPattern };
  });
}

const resolvedDbPath = resolve(process.cwd(), requiredEnv('REATTACH_DB_PATH'));
const confirmedDbPath = resolve(process.cwd(), requiredEnv('REATTACH_CONFIRM_DB_PATH'));
const adminUserId = requiredEnv('REATTACH_ADMIN_USER_ID');
const summaryPath = resolve(process.cwd(), requiredEnv('REATTACH_SUMMARY_PATH'));
const mappingsPath = resolve(process.cwd(), requiredArg('--mappings'));
if (!existsSync(mappingsPath)) throw new Error(`--mappings file does not exist: ${mappingsPath}`);
const userMappings = parseMappings(readFileSync(mappingsPath, 'utf8'));
if (confirmedDbPath !== resolvedDbPath) {
  throw new Error('REATTACH_CONFIRM_DB_PATH must resolve to exactly REATTACH_DB_PATH');
}
if (requiredEnv('REATTACH_CONFIRM') !== 'REATTACH_PROFILES') {
  throw new Error('REATTACH_CONFIRM must equal REATTACH_PROFILES');
}
if (!existsSync(resolvedDbPath)) {
  throw new Error(`REATTACH_DB_PATH does not exist: ${resolvedDbPath}`);
}

try {
  console.log('Connecting to database...');
  console.log(`Database path: ${resolvedDbPath}`);
  const db = new Database(resolvedDbPath, { fileMustExist: true });
  console.log('Connected!\n');

  // Resolve only the explicitly selected, DB-authorized admin.
  const adminUser = db.prepare(`
    SELECT id, display_name, primary_email
    FROM users
    WHERE id = ? AND COALESCE(is_admin, 0) = 1
    LIMIT 1
  `).get(adminUserId);

  if (!adminUser) {
    throw new Error('REATTACH_ADMIN_USER_ID is not a DB-authorized admin');
  }

  console.log(`Admin: ${adminUser.display_name} (${adminUser.id})\n`);

  const linked = [];

  for (const mapping of userMappings) {
    console.log(`Processing mapping ${linked.length + 1}...`);
    
    // Find user
    const user = db.prepare(`
      SELECT id, display_name, primary_email
      FROM users
      WHERE LOWER(display_name) LIKE LOWER(?) OR LOWER(primary_email) LIKE LOWER(?)
      LIMIT 1
    `).get(`%${mapping.name}%`, `%${mapping.emailPattern}%`);
    
    if (!user) {
      console.log('  No user found for supplied mapping');
      continue;
    }
    
    console.log(`  Found user: ${user.display_name} (${user.primary_email})`);
    
    // Find matching profiles
    const profiles = db.prepare(`
      SELECT id, display_name, user_id
      FROM profiles
      WHERE LOWER(display_name) LIKE LOWER(?)
    `).all(`%${mapping.name}%`);
    
    if (profiles.length === 0) {
      console.log('  No profiles found for supplied mapping');
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
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`Summary written to ${summaryPath}`);

  db.close();
  console.log('\nDone!');
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  console.error(`Stack: ${error.stack}`);
  process.exit(1);
}
