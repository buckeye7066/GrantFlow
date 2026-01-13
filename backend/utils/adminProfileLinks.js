import crypto from 'crypto'
import { ADMIN_EMAIL, isAdminEmail } from '../config/constants.js'

function nowISOString() {
  return new Date().toISOString()
}

export function ensureAdminUser(db) {
  const normalizedEmail = ADMIN_EMAIL.trim().toLowerCase()
  let adminUser = db
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
    db.prepare(
      `
        INSERT INTO users (id, display_name, primary_email, is_admin, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `,
    ).run(adminId, displayName, ADMIN_EMAIL, nowISOString(), nowISOString())

    adminUser = db
      .prepare(
        `
          SELECT *
          FROM users
          WHERE id = ?
        `,
      )
      .get(adminId)
  } else if (!adminUser.is_admin) {
    db.prepare(
      `
        UPDATE users
        SET is_admin = 1,
            updated_at = ?
        WHERE id = ?
      `,
    ).run(nowISOString(), adminUser.id)
    adminUser.is_admin = 1
  }

  return adminUser
}

export function linkProfileToAdmin(db, profileId) {
  if (!profileId) return
  const admin = ensureAdminUser(db)
  const existing = db
    .prepare(
      `
        SELECT user_id
        FROM profiles
        WHERE id = ?
      `,
    )
    .get(profileId)
  if (!existing) return
  if (!existing.user_id) {
    db.prepare(
      `
        UPDATE profiles
        SET user_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
    ).run(admin.id, profileId)
  }
}

export function linkAllProfilesToAdmin(db) {
  const admin = ensureAdminUser(db)
  db.prepare(
    `
      UPDATE profiles
      SET user_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id IS NULL
    `,
  ).run(admin.id)
}

export function isAdminUserId(db, userId) {
  if (!userId) return false
  const row = db
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
