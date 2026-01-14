import crypto from 'crypto'
import { ADMIN_EMAIL, isAdminEmail } from '../config/constants.js'

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
    ).run(adminId, displayName, ADMIN_EMAIL, nowISOString(), nowISOString())

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
  const admin = await ensureAdminUser(db)
  const existing = await db
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
    await db.prepare(
      `
        UPDATE profiles
        SET user_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
    ).run(admin.id, profileId)
  }
}

export async function linkAllProfilesToAdmin(db) {
  const admin = await ensureAdminUser(db)
  await db.prepare(
    `
      UPDATE profiles
      SET user_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id IS NULL
    `,
  ).run(admin.id)
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
