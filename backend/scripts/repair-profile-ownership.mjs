#!/usr/bin/env node
/**
 * Repair profile ownership + email access mappings.
 *
 * Goals:
 * - Admin can access all profiles (via users.is_admin + profile_emails admin link).
 * - Each profile is owned by the user matching its email (basic_information.email or designated mapping).
 * - No cross-profile leakage: only owners (user_id) and explicit profile_emails mappings grant access to non-admins.
 *
 * Usage:
 *   node backend/scripts/repair-profile-ownership.mjs
 *
 * Optional env:
 *   APPLY=1            (default: dry-run report only)
 *   LIMIT=5000         (cap profiles scanned)
 */

import crypto from 'crypto'
import { db } from '../db/index.js'
import { repairProfileOwnership } from '../utils/profileOwnershipRepair.js'

function normalizeEmail(email) {
  const v = String(email || '').trim().toLowerCase()
  return v || null
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(String(value)) : fallback
  } catch {
    return fallback
  }
}

async function getOrCreateUserByEmail(email) {
  const normalized = normalizeEmail(email)
  if (!normalized) return null

  const existing = await db.prepare('SELECT * FROM users WHERE LOWER(primary_email) = ? LIMIT 1').get(normalized)
  if (existing?.id) return existing

  const userId = crypto.randomUUID()
  const displayName = normalized.split('@')[0] || 'User'
  const isAdmin = isAdminEmail(normalized) ? 1 : 0
  await db
    .prepare(
      `
        INSERT INTO users (id, display_name, primary_email, is_admin, created_at, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
    )
    .run(userId, displayName, normalized, isAdmin)
  return await db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
}

async function extractProfileEmail(profileId) {
  const row = await db
    .prepare(
      `
        SELECT data
        FROM profile_sections
        WHERE profile_id = ?
          AND section_key = 'basic_information'
        LIMIT 1
      `,
    )
    .get(profileId)
  const parsed = parseJson(row?.data, {})
  const email = normalizeEmail(parsed?.email)
  return email
}

async function setProfileSectionEmailIfEmpty(profileId, email, { apply }) {
  const normalized = normalizeEmail(email)
  if (!normalized) return { updated: false }
  const row = await db
    .prepare(
      `
        SELECT data
        FROM profile_sections
        WHERE profile_id = ?
          AND section_key = 'basic_information'
        LIMIT 1
      `,
    )
    .get(profileId)
  const parsed = parseJson(row?.data, {})
  if (parsed && typeof parsed === 'object' && !String(parsed.email || '').trim()) {
    if (!apply) return { updated: true, dry_run: true }
    parsed.email = normalized
    await db
      .prepare(
        `
          UPDATE profile_sections
          SET data = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ?
          WHERE profile_id = ?
            AND section_key = 'basic_information'
        `,
      )
      .run(JSON.stringify(parsed), 'repair-profile-ownership', profileId)
    return { updated: true }
  }
  return { updated: false }
}

async function upsertProfileEmail(profileId, email, { apply, addedBy }) {
  const normalized = normalizeEmail(email)
  if (!normalized) return { inserted: false }
  if (!apply) return { inserted: true, dry_run: true }
  if (db?.dialect === 'postgres') {
    await db
      .prepare(
        `
          INSERT INTO profile_emails (id, profile_id, email, added_by)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (profile_id, email) DO NOTHING
        `,
      )
      .run(crypto.randomUUID(), String(profileId), normalized, addedBy || 'repair-profile-ownership')
    return { inserted: true }
  }

  await db
    .prepare(
      `
        INSERT OR IGNORE INTO profile_emails (id, profile_id, email, added_by)
        VALUES (?, ?, ?, ?)
      `,
    )
    .run(crypto.randomUUID(), String(profileId), normalized, addedBy || 'repair-profile-ownership')
  return { inserted: true }
}

async function maybeAssignOwner(profileId, email, { apply }) {
  const normalized = normalizeEmail(email)
  if (!normalized) return { assigned: false }

  const profile = await db.prepare('SELECT id, user_id FROM profiles WHERE id = ?').get(profileId)
  if (!profile?.id) return { assigned: false, reason: 'profile_missing' }

  const user = await getOrCreateUserByEmail(normalized)
  if (!user?.id) return { assigned: false, reason: 'user_missing' }

  // Respect unique "one owned profile per user" constraint.
  const alreadyOwned = await db.prepare('SELECT id FROM profiles WHERE user_id = ? LIMIT 1').get(user.id)
  if (alreadyOwned?.id && String(alreadyOwned.id) !== String(profileId)) {
    return { assigned: false, reason: 'user_already_has_profile', existing_profile_id: alreadyOwned.id }
  }

  // If profile is unowned or owned by an admin, assign to the real user.
  let ownerIsAdmin = false
  if (profile.user_id) {
    const owner = await db.prepare('SELECT is_admin FROM users WHERE id = ?').get(profile.user_id)
    ownerIsAdmin = Boolean(owner?.is_admin === 1 || owner?.is_admin === true)
  }

  if (!profile.user_id || ownerIsAdmin) {
    if (!apply) return { assigned: true, dry_run: true, user_id: user.id }
    await db.prepare('UPDATE profiles SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id, profileId)
    return { assigned: true, user_id: user.id }
  }

  return { assigned: false, user_id: profile.user_id }
}

async function main() {
  const apply = String(process.env.APPLY || '').trim() === '1'
  const limit = Math.max(1, Math.min(50_000, Number(process.env.LIMIT || 5000) || 5000))

  const report = await repairProfileOwnership(db, {
    apply,
    limit,
    includeDeleted: true,
    updatedBy: 'repair-profile-ownership',
  })

  console.log(JSON.stringify(report, null, 2))
}

main().catch((err) => {
  console.error('[repair-profile-ownership] FAILED:', err?.stack || err)
  process.exit(1)
})

