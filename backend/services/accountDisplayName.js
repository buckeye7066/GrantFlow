/**
 * accountDisplayName.js
 *
 * Signup derives `users.display_name` from the email local part ("mcnabbwg",
 * routes/auth.js) or a phone stub ("User 0123"). The profile the person then
 * fills in carries their real name ("GeneMac"). Left alone, the header shows
 * the stub while an admin sees the profile name, and both believe there are
 * two profiles (prod, 2026-09-07). Once a profile has a real name, replace a
 * PLACEHOLDER account name with it. A name the person chose is never touched.
 */

function emailLocalPart(email) {
  const s = String(email || '').trim().toLowerCase()
  const at = s.indexOf('@')
  return at > 0 ? s.slice(0, at) : ''
}

/** True when the account name is one the system minted, not one the person chose. */
export function isPlaceholderAccountName(displayName, { email = null, phone = null } = {}) {
  const name = String(displayName || '').trim()
  if (!name) return true
  const lower = name.toLowerCase()
  if (lower === 'new user' || lower === 'user') return true
  const local = emailLocalPart(email)
  if (local && lower === local) return true
  if (/^user\s+[\w-]{1,8}$/i.test(name)) return true
  const digits = String(phone || '').replace(/\D/g, '')
  if (digits && lower === `user ${digits.slice(-4)}`) return true
  return false
}

/**
 * Replace a placeholder account name with the profile's real name.
 * Returns { updated: boolean, from, to }. Never throws on a missing user.
 */
export async function syncAccountDisplayName(db, userId, profileDisplayName) {
  const to = String(profileDisplayName || '').trim().slice(0, 200)
  if (!db || !userId || !to) return { updated: false, from: null, to: to || null }
  const row = await db
    .prepare('SELECT display_name, primary_email, primary_phone FROM users WHERE id = ? LIMIT 1')
    .get(String(userId))
  if (!row) return { updated: false, from: null, to }
  const from = row.display_name ?? null
  if (from === to) return { updated: false, from, to }
  if (!isPlaceholderAccountName(from, { email: row.primary_email, phone: row.primary_phone })) {
    return { updated: false, from, to }
  }
  await db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(to, String(userId))
  return { updated: true, from, to }
}

export default syncAccountDisplayName
