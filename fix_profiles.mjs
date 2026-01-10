import Database from 'better-sqlite3';
import { join } from 'path';

const db = new Database(join(process.cwd(), 'seed', 'grantflow.db'));

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  const next = process.argv[idx + 1]
  if (!next || next.startsWith('--')) return fallback
  return next
}

try {
  const adminEmail = getArg('admin-email', 'buckeye7066@gmail.com')
  const applyAll = process.argv.includes('--apply-all')

  const admin = db
    .prepare('SELECT id FROM users WHERE LOWER(primary_email) = ?')
    .get(String(adminEmail).toLowerCase())
    
  if (!admin?.id) {
    console.error(`Admin user not found for email: ${adminEmail}`)
    process.exit(1)
    }
    
  const total = db.prepare('SELECT COUNT(*) AS count FROM profiles').get()?.count ?? 0
  const linked = db.prepare('SELECT COUNT(*) AS count FROM profiles WHERE user_id IS NOT NULL').get()?.count ?? 0
  const unlinked = total - linked

  console.log(`[fix_profiles] DB: ${join(process.cwd(), 'seed', 'grantflow.db')}`)
  console.log(`[fix_profiles] Admin: ${admin.id} (${adminEmail})`)
  console.log(`[fix_profiles] Profiles: total=${total}, linked=${linked}, unlinked=${unlinked}`)

  // SAFETY: default behavior only links profiles with user_id IS NULL.
  // Use --apply-all to force relinking every profile (dangerous; not recommended).
  const stmt = applyAll
    ? db.prepare(`UPDATE profiles SET user_id = ?, updated_at = CURRENT_TIMESTAMP`)
    : db.prepare(`UPDATE profiles SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id IS NULL`)

  const result = stmt.run(admin.id)
  console.log(`[fix_profiles] Updated ${result.changes} profile(s) (${applyAll ? 'apply-all' : 'only-unlinked'})`)
} catch (error) {
  console.error('[fix_profiles] Error:', error?.message || error)
  process.exitCode = 1
} finally {
  db.close()
}
