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
import { ADMIN_EMAIL, isAdminEmail } from '../config/constants.js'
import { USER_PROFILE_MAPPINGS } from '../config/userProfileMappings.js'
import { ensureProfileEmailSchema } from '../utils/accessControl.js'
import { linkProfileToAdmin } from '../utils/adminProfileLinks.js'

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

  await ensureProfileEmailSchema(db)

  // Always ensure admin user row exists + is_admin is true.
  await getOrCreateUserByEmail(ADMIN_EMAIL)

  const profiles = await db
    .prepare(
      `
        SELECT id, display_name, user_id, status
        FROM profiles
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(limit)

  const report = {
    ok: true,
    mode: apply ? 'apply' : 'dry_run',
    scanned: profiles.length,
    ownership_assigned: 0,
    basic_info_email_filled: 0,
    profile_email_links_added: 0,
    admin_links_added: 0,
    unmapped_active_profiles: 0,
    sample_unmapped: [],
  }

  // First: apply designated mappings (fills blank emails + assigns ownership when possible).
  for (const [rawEmail, mappedProfileId] of Object.entries(USER_PROFILE_MAPPINGS || {})) {
    const email = normalizeEmail(rawEmail)
    if (!email) continue
    if (!mappedProfileId) continue
    if (isAdminEmail(email)) continue

    const profile = await db.prepare('SELECT id FROM profiles WHERE id = ?').get(mappedProfileId)
    if (!profile?.id) continue

    const fill = await setProfileSectionEmailIfEmpty(mappedProfileId, email, { apply })
    if (fill.updated) report.basic_info_email_filled += 1

    const link = await upsertProfileEmail(mappedProfileId, email, { apply, addedBy: 'repair-profile-ownership.mapped' })
    if (link.inserted) report.profile_email_links_added += 1

    const assigned = await maybeAssignOwner(mappedProfileId, email, { apply })
    if (assigned.assigned) report.ownership_assigned += 1
  }

  // Second: for all profiles, ensure basic_information.email links exist + ownership is set when possible.
  for (const p of profiles || []) {
    const profileId = String(p.id)

    // Ensure admin can enumerate every profile.
    if (apply) {
      await linkProfileToAdmin(db, profileId)
      report.admin_links_added += 1
    }

    const email = await extractProfileEmail(profileId)
    if (email) {
      const link = await upsertProfileEmail(profileId, email, { apply, addedBy: 'repair-profile-ownership.profile' })
      if (link.inserted) report.profile_email_links_added += 1
      const assigned = await maybeAssignOwner(profileId, email, { apply })
      if (assigned.assigned) report.ownership_assigned += 1
      continue
    }

    // Track active profiles that still have no usable email mapping (true orphans).
    if (String(p.status || '').toLowerCase() === 'active') {
      report.unmapped_active_profiles += 1
      if (report.sample_unmapped.length < 10) {
        report.sample_unmapped.push({ id: profileId, display_name: p.display_name ?? null })
      }
    }
  }

  console.log(JSON.stringify(report, null, 2))
}

main().catch((err) => {
  console.error('[repair-profile-ownership] FAILED:', err?.stack || err)
  process.exit(1)
})

