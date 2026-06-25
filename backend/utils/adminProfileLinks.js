import crypto from 'crypto'
import { ADMIN_EMAIL, isAdminEmail } from '../config/constants.js'
import { ensureProfileEmailSchema } from './accessControl.js'
import { createLogger } from './logger.js'
const qualityLog = createLogger('utils:adminProfileLinks')

function nowISOString() {
  return new Date().toISOString()
}

export async function ensureAdminUser(db) {
  const normalizedEmail = ADMIN_EMAIL.trim().toLowerCase()
  let adminUser = await db
    .prepare(
      `
        SELECT *
        FROM users
        WHERE LOWER(primary_email) = ?
      `,
    )
    .get(normalizedEmail)

  if (!adminUser) {
    const adminId = crypto.randomUUID()
    const displayName = ADMIN_EMAIL.split('@')[0] || 'GrantFlow Admin'
    await db.prepare(
      `
        INSERT INTO users (id, display_name, primary_email, is_admin, created_at, updated_at)
        VALUES (?, ?, ?, TRUE, ?, ?)
      `,
    ).run(adminId, displayName, normalizedEmail, nowISOString(), nowISOString())

    adminUser = await db
      .prepare(
        `
          SELECT *
          FROM users
          WHERE id = ?
        `,
      )
      .get(adminId)
  } else if (!adminUser.is_admin) {
    await db.prepare(
      `
        UPDATE users
        SET is_admin = TRUE,
            updated_at = ?
        WHERE id = ?
      `,
    ).run(nowISOString(), adminUser.id)
    adminUser.is_admin = true
  }

  return adminUser
}

export async function linkProfileToAdmin(db, profileId) {
  if (!profileId) return
  // Phase 2: never "take ownership" of profiles by setting user_id to the admin.
  // Admin access is granted via users.is_admin, and (optionally) via profile_emails mapping
  // so admin UIs can enumerate legacy profiles without violating unique profile ownership.
  try {
    await ensureProfileEmailSchema(db)
  } catch (err) {
    qualityLog.error('[adminProfileLinks] ensureProfileEmailSchema failed in linkProfileToAdmin:', err?.message || err)
    return
  }

  const dialect = db?.dialect || 'sqlite'
  const normalized = String(ADMIN_EMAIL || '').trim().toLowerCase()
  if (!normalized) return

  if (dialect === 'postgres') {
    await db
      .prepare(
        `
          INSERT INTO profile_emails (id, profile_id, email, added_by)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (profile_id, email) DO NOTHING
        `,
      )
      .run(crypto.randomUUID(), profileId, normalized, 'system-admin-link')
    return
  }

  // sqlite
  await db
    .prepare(
      `
        INSERT OR IGNORE INTO profile_emails (id, profile_id, email, added_by)
        VALUES (?, ?, ?, ?)
      `,
    )
    .run(crypto.randomUUID(), profileId, normalized, 'system-admin-link')
}

export async function linkAllProfilesToAdmin(db) {
  // Phase 2: do not mutate profiles.user_id en masse (breaks unique ownership).
  // Instead, attach ADMIN_EMAIL as an access email so admin UIs can enumerate all profiles.
  try {
    await ensureProfileEmailSchema(db)
  } catch (err) {
    qualityLog.error('[adminProfileLinks] ensureProfileEmailSchema failed in linkProfileToAdmin:', err?.message || err)
    return
  }

  const normalized = String(ADMIN_EMAIL || '').trim().toLowerCase()
  if (!normalized) return

  // Bounded batch to avoid surprising startup latency on huge datasets.
  const limit = 25_000
  const rows = await db.prepare('SELECT id FROM profiles ORDER BY created_at DESC LIMIT ?').all(limit)
  const profileIds = (rows || []).map((r) => r?.id).filter(Boolean)
  if (profileIds.length === 0) return

  for (const profileId of profileIds) {
    await linkProfileToAdmin(db, profileId)
  }
}

export async function isAdminUserId(db, userId) {
  if (!userId) return false
  const row = await db
    .prepare(
      `
        SELECT primary_email
        FROM users
        WHERE id = ?
      `,
    )
    .get(userId)
  if (!row?.primary_email) return false
  return isAdminEmail(row.primary_email)
}
