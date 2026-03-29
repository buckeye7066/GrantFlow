import Database from 'better-sqlite3';

if (/^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || '')) {
  console.error('ERROR: This script only supports SQLite databases. DATABASE_URL points to PostgreSQL.')
  console.error('Use the application API or a Postgres client instead.')
  process.exit(1)
}

const db = new Database('./data/grantflow.db');

console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║              GRANTFLOW DATABASE SUMMARY                        ║');
console.log('╠════════════════════════════════════════════════════════════════╣');

// Get all tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();

// Count records in key tables
const tableCounts = {};
const keyTables = ['profiles', 'users', 'documents', 'profile_sections', 'profile_documents', 'crawler_jobs', 'anya_sessions', 'audit_logs', 'service_applications'];

for (const t of keyTables) {
  try {
    tableCounts[t] = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get().c;
  } catch (e) {
    tableCounts[t] = 'N/A';
  }
}

console.log('║ Tables in database:', tables.length.toString().padStart(43), '║');
console.log('╠════════════════════════════════════════════════════════════════╣');

for (const [table, count] of Object.entries(tableCounts)) {
  const label = table.padEnd(25);
  const value = String(count).padStart(35);
  console.log(`║ ${label}${value} ║`);
}

console.log('╠════════════════════════════════════════════════════════════════╣');
console.log('║                         PROFILES                               ║');
console.log('╠════════════════════════════════════════════════════════════════╣');

const profiles = db.prepare('SELECT id, display_name, primary_type FROM profiles ORDER BY display_name').all();
let sectionJsonParseErrors = 0

for (const p of profiles) {
  const secs = db.prepare('SELECT COUNT(*) as c FROM profile_sections WHERE profile_id = ?').get(p.id).c;
  const docs = db.prepare('SELECT COUNT(*) as c FROM profile_documents WHERE profile_id = ?').get(p.id).c;
  
  // Count filled data fields
  let fields = 0;
  const sections = db.prepare('SELECT data FROM profile_sections WHERE profile_id = ?').all(p.id);
  for (const s of sections) {
    try {
      const data = JSON.parse(s.data || '{}');
      fields += Object.values(data).filter(v => v && v !== '' && (!Array.isArray(v) || v.length > 0)).length;
    } catch (e) {
      sectionJsonParseErrors += 1
    }
  }
  
  const name = p.display_name.substring(0, 28).padEnd(28);
  const type = (p.primary_type || 'indiv').substring(0, 6);
  console.log(`║ ${name} ${type} S:${secs} D:${docs} F:${String(fields).padStart(2)} ║`);
}

console.log('╠════════════════════════════════════════════════════════════════╣');
console.log('║                          USERS                                 ║');
console.log('╠════════════════════════════════════════════════════════════════╣');

const users = db.prepare('SELECT id, primary_email, is_admin FROM users ORDER BY primary_email').all();
for (const u of users) {
  const email = (u.primary_email || 'no-email').substring(0, 40).padEnd(40);
  const admin = u.is_admin ? '✓ ADMIN' : '       ';
  console.log(`║ ${email} ${admin}       ║`);
}

console.log('╚════════════════════════════════════════════════════════════════╝');

// Check for any issues
console.log('\n=== HEALTH CHECK ===');
const issues = [];

// Check for profiles without sections
const noSections = db.prepare(`
  SELECT p.display_name FROM profiles p 
  LEFT JOIN profile_sections ps ON p.id = ps.profile_id 
  GROUP BY p.id HAVING COUNT(ps.id) < 5
`).all();
if (noSections.length > 0) {
  issues.push(`${noSections.length} profiles have < 5 sections`);
}

// Check for orphaned documents
const orphanDocs = db.prepare(`
  SELECT COUNT(*) as c FROM documents d 
  LEFT JOIN profiles p ON d.profile_id = p.id 
  WHERE p.id IS NULL
`).get().c;
if (orphanDocs > 0) {
  issues.push(`${orphanDocs} orphaned documents`);
}

if (issues.length === 0) {
  console.log('✓ All checks passed!');
} else {
  issues.forEach(i => console.log('⚠ ' + i));
}

if (sectionJsonParseErrors > 0) {
  console.warn(`⚠ ${sectionJsonParseErrors} profile section(s) contained invalid JSON and were skipped in field counting.`)
}

db.close();
