/**
 * hamiltonAdminAccount.js
 *
 * GrantFlow has one explicitly configured admin/operator account that receives
 * Hamilton hard-stop notifications. HAMILTON_ADMIN_EMAIL may override the
 * required deployed ADMIN_EMAIL; no source-controlled production identity is
 * available. The legacy multi-admin
 * routing — "every user with role=admin" or "every is_admin=1 user" —
 * is no longer the primary path. We always send admin notifications
 * to this single account; if no row exists for it yet we create one.
 *
 * Functions
 *   HAMILTON_ADMIN_EMAIL      — canonical admin email (lowercased)
 *   resolveAdminUserId(db) — returns the admin user's id, creating the
 *                            row if it does not already exist.
 *   isAdminUser(user)      — accepts a session user object and returns
 *                            true if either:
 *                              - user.is_admin === true, or
 *                              - user.role === 'admin', or
 *                              - user.email matches the admin email.
 */

import crypto from 'node:crypto'
import { ADMIN_EMAIL, isAdminEmail } from '../../config/constants.js'

export const HAMILTON_ADMIN_EMAIL = String(
  process.env.HAMILTON_ADMIN_EMAIL || ADMIN_EMAIL || '',
).trim().toLowerCase()

const FALLBACK_ID = 'system_admin_hamilton'
let cachedAdminUserId = null
export function _resetAdminAccountCache() { cachedAdminUserId = null }

function valueOrNull(row, ...keys) {
  if (!row) return null
  for (const k of keys) if (row[k] !== undefined && row[k] !== null) return row[k]
  return null
}

/**
 * Resolve the admin user id, creating the row on first use. Best-effort
 * across the three known schemas:
 *
 *   1. Production:  users(id, primary_email, is_admin, display_name, ...)
 *   2. Test stub:   users(id, primary_email TEXT, is_admin INTEGER)
 *   3. Legacy stub: users(id, role TEXT)        // some older tests
 *
 * Returns FALLBACK_ID if the table is missing entirely so callers can
 * still associate notifications with a stable id.
 */
export async function resolveAdminUserId(db) {
  if (cachedAdminUserId) return cachedAdminUserId
  if (!db || typeof db.prepare !== 'function') return FALLBACK_ID
  if (!HAMILTON_ADMIN_EMAIL) return FALLBACK_ID

  const tryFind = async () => {
    // 1. Look up by primary_email.
    try {
      const row = await db.prepare(
        'SELECT id FROM users WHERE LOWER(primary_email) = ? LIMIT 1',
      ).get(HAMILTON_ADMIN_EMAIL)
      if (row?.id) return row.id
    } catch { /* table or column missing — fall through */ }

    // 2. Look up by `email` column (some test fixtures).
    try {
      const row = await db.prepare(
        'SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1',
      ).get(HAMILTON_ADMIN_EMAIL)
      if (row?.id) return row.id
    } catch { /* fall through */ }

    // 3. Look up by `role = admin` (legacy test fixtures only).
    try {
      const row = await db.prepare(
        "SELECT id FROM users WHERE role = 'admin' LIMIT 1",
      ).get()
      if (row?.id) return row.id
    } catch { /* fall through */ }

    // 4. is_admin flag fallback.
    try {
      const row = await db.prepare(
        'SELECT id FROM users WHERE is_admin = 1 LIMIT 1',
      ).get()
      if (row?.id) return row.id
    } catch { /* fall through */ }

    return null
  }

  const found = await tryFind()
  if (found) {
    cachedAdminUserId = found
    return found
  }

  // Auto-create the canonical admin row. We try the production schema
  // first, then degrade to two test variants.
  const newId = crypto.randomUUID()
  const candidates = [
    {
      sql: `INSERT INTO users (id, display_name, primary_email, is_admin) VALUES (?, ?, ?, 1)`,
      args: [newId, 'GrantFlow Admin', HAMILTON_ADMIN_EMAIL],
    },
    {
      sql: `INSERT INTO users (id, primary_email, is_admin) VALUES (?, ?, 1)`,
      args: [newId, HAMILTON_ADMIN_EMAIL],
    },
    {
      sql: `INSERT INTO users (id, email, role) VALUES (?, ?, 'admin')`,
      args: [newId, HAMILTON_ADMIN_EMAIL],
    },
    {
      sql: `INSERT INTO users (id, role) VALUES (?, 'admin')`,
      args: [newId],
    },
  ]
  for (const c of candidates) {
    try {
      await db.prepare(c.sql).run(...c.args)
      cachedAdminUserId = newId
      return newId
    } catch { /* try next variant */ }
  }

  // No schema accepted us — return the fallback id so notifications
  // still have a stable user_id pointer. Notifications insert won't
  // foreign-key fail because the notifications table doesn't FK to
  // users.id.
  cachedAdminUserId = FALLBACK_ID
  return FALLBACK_ID
}

/**
 * Decide whether a session user is the canonical Hamilton admin/operator.
 * Accepts the various shapes Express middleware hangs on req.user.
 */
export function isAdminUser(user) {
  if (!user) return false
  if (user.is_admin === true || user.is_admin === 1) return true
  if (user.role === 'admin' || user.role === 'operator') return true
  const email = user.email || user.primary_email
  if (email && isAdminEmail(email)) return true
  return false
}

export const _internal = { FALLBACK_ID }
