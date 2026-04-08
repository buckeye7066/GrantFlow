import crypto from 'crypto'
import { ADMIN_EMAIL, isAdminEmail } from '../config/constants.js'
import { ensureProfileEmailSchema, addProfileEmails } from './accessControl.js'
import { ensureAdminUser, linkProfileToAdmin } from './adminProfileLinks.js'
import { USER_PROFILE_MAPPINGS } from '../config/userProfileMappings.js'

function normalizeEmail(email) {
  const v = String(email || '').trim().toLowerCase()
  return v || null
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim())
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(String(value)) : fallback
  } catch {
    return fallback
  }
}

async function getOrCreateUserByEmail(db, email) {
  const normalized = normalizeEmail(email)
  if (!normalized) return null

  const existing = await db
    .prepare('SELECT * FROM users WHERE LOWER(primary_email) = ? LIMIT 1')
    .get(normalized)
  if (existing?.id) return existing

  const userId = crypto.randomUUID()
  const displayName = normalized.split('@')[0] || 'User'
  const admin = isAdminEmail(normalized) ? 1 : 0

  await db
    .prepare(
      `
        INSERT INTO users (id, display_name, primary_email, is_admin, created_at, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
    )
    .run(userId, displayName, normalized, admin)

  return await db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
}

async function extractBasicInformationEmail(db, profileId) {
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
    .get(String(profileId))
  const parsed = parseJson(row?.data, {})
  const email = normalizeEmail(parsed?.email)
  return email && isValidEmail(email) ? email : null
}

async function setProfileSectionEmailIfEmpty(db, profileId, email, { apply, updatedBy }) {
  const normalized = normalizeEmail(email)
  if (!normalized || !isValidEmail(normalized)) return { updated: false }

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
    .get(String(profileId))

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
      .run(JSON.stringify(parsed), updatedBy || 'profile-ownership-repair', String(profileId))
    return { updated: true }
  }
  return { updated: false }
}

async function maybeAssignOwner(db, profileId, email, { apply }) {
  const normalized = normalizeEmail(email)
  if (!normalized || !isValidEmail(normalized)) return { assigned: false, reason: 'invalid_email' }

  const profile = await db
    .prepare('SELECT id, user_id FROM profiles WHERE id = ? LIMIT 1')
    .get(String(profileId))
  if (!profile?.id) return { assigned: false, reason: 'profile_missing' }

  const user = await getOrCreateUserByEmail(db, normalized)
  if (!user?.id) return { assigned: false, reason: 'user_missing' }

  // Respect unique ownership constraints (one owned profile per user).
  const alreadyOwned = await db
    .prepare('SELECT id FROM profiles WHERE user_id = ? LIMIT 1')
    .get(String(user.id))
  if (alreadyOwned?.id && String(alreadyOwned.id) !== String(profileId)) {
    return {
      assigned: false,
      reason: 'user_already_has_profile',
      existing_profile_id: alreadyOwned.id,
      user_id: user.id,
    }
  }

  // If profile is unowned or owned by an admin, assign to the real user.
  let ownerIsAdmin = false
  if (profile.user_id) {
    const owner = await db.prepare('SELECT is_admin FROM users WHERE id = ?').get(String(profile.user_id))
    ownerIsAdmin = Boolean(owner?.is_admin === 1 || owner?.is_admin === true)
  }

  if (!profile.user_id || ownerIsAdmin) {
    if (!apply) return { assigned: true, dry_run: true, user_id: user.id }
    await db
      .prepare('UPDATE profiles SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(String(user.id), String(profileId))
    return { assigned: true, user_id: user.id }
  }

  return { assigned: false, reason: 'already_owned', user_id: profile.user_id }
}

/**
 * After designated profile seeding: link profile_emails + user_id when config provides owner_email.
 */
export async function attachDesignatedProfileOwner(db, profileId, rawEmail) {
  const email = normalizeEmail(rawEmail)
  if (!email || !isValidEmail(email)) {
    return { ok: false, reason: 'bad_email' }
  }
  if (isAdminEmail(email)) {
    return { ok: false, reason: 'admin_email' }
  }

  await ensureProfileEmailSchema(db)
  try {
    await addProfileEmails(db, {
      profileId: String(profileId),
      emails: [email],
      addedBy: 'designated-profile-owner',
    })
  } catch (e) {
    console.warn('[attachDesignatedProfileOwner] addProfileEmails failed:', e?.message || e)
  }

  const assigned = await maybeAssignOwner(db, profileId, email, { apply: true })
  return { ok: true, assigned }
}

/**
 * Repairs profile ownership + email access mappings to match product rules:
 * - Admin email (ADMIN_EMAIL) can enumerate ALL profiles via profile_emails.
 * - A profile’s basic_information.email is linked (profile_emails), and ownership is assigned when safe.
 *
 * This is intended for admin-only endpoints/scripts. It is traceable (returns a report)
 * and reversible (re-run with apply=false for dry-run, and all writes are additive except user_id reassignments).
 */
export async function repairProfileOwnership(db, opts = {}) {
  const apply = opts.apply === true
  const includeDeleted = opts.includeDeleted === true
  const limit = Math.max(1, Math.min(Number(opts.limit || 5000) || 5000, 50_000))
  const updatedBy = String(opts.updatedBy || 'profile-ownership-repair')

  const report = {
    ok: true,
    mode: apply ? 'apply' : 'dry_run',
    admin_email: String(ADMIN_EMAIL || '').trim().toLowerCase() || null,
    include_deleted_profiles: includeDeleted,
    limit,
    scanned: 0,
    admin_links_planned: 0,
    admin_links_added: 0,
    profile_email_links_planned: 0,
    profile_email_links_added: 0,
    basic_info_email_filled_planned: 0,
    basic_info_email_filled: 0,
    ownership_assigned_planned: 0,
    ownership_assigned: 0,
    ownership_skipped: {
      invalid_email: 0,
      user_already_has_profile: 0,
      already_owned: 0,
      profile_missing: 0,
      user_missing: 0,
    },
    sample_skipped: [],
  }

  await ensureProfileEmailSchema(db)
  await ensureAdminUser(db)

  // Fetch profiles (bounded).
  const whereDeleted = includeDeleted ? '' : "WHERE (status IS NULL OR lower(status) <> 'deleted')"
  const profiles = await db
    .prepare(
      `
        SELECT id, display_name, user_id, status
        FROM profiles
        ${whereDeleted}
        ORDER BY COALESCE(updated_at, created_at) DESC
        LIMIT ?
      `,
    )
    .all(limit)

  report.scanned = Array.isArray(profiles) ? profiles.length : 0

  // Phase 1: apply designated mappings (fills blank emails).
  for (const [rawEmail, mappedProfileId] of Object.entries(USER_PROFILE_MAPPINGS || {})) {
    const email = normalizeEmail(rawEmail)
    if (!email || !isValidEmail(email)) continue
    if (!mappedProfileId) continue
    if (isAdminEmail(email)) continue

    const profile = await db.prepare('SELECT id FROM profiles WHERE id = ? LIMIT 1').get(String(mappedProfileId))
    if (!profile?.id) continue

    const fill = await setProfileSectionEmailIfEmpty(db, mappedProfileId, email, { apply, updatedBy })
    if (fill.updated) {
      report.basic_info_email_filled_planned += 1
      if (apply) report.basic_info_email_filled += 1
    }

    report.profile_email_links_planned += 1
    if (apply) {
      const added = await addProfileEmails(db, {
        profileId: String(mappedProfileId),
        emails: [email],
        addedBy: `${updatedBy}.mapped`,
      })
      if (Number(added?.added || 0) > 0) report.profile_email_links_added += 1
    }

    const assigned = await maybeAssignOwner(db, mappedProfileId, email, { apply })
    if (assigned.assigned) {
      report.ownership_assigned_planned += 1
      if (apply) report.ownership_assigned += 1
    } else if (assigned.reason) {
      report.ownership_skipped[assigned.reason] = (report.ownership_skipped[assigned.reason] || 0) + 1
    }
  }

  // Phase 2: scan all profiles and ensure admin + profile email links exist.
  for (const p of profiles || []) {
    const profileId = String(p?.id || '')
    if (!profileId) continue

    report.admin_links_planned += 1
    if (apply) {
      await linkProfileToAdmin(db, profileId)
      report.admin_links_added += 1
    }

    const email = await extractBasicInformationEmail(db, profileId)
    if (!email) continue

    report.profile_email_links_planned += 1
    if (apply) {
      const added = await addProfileEmails(db, {
        profileId,
        emails: [email],
        addedBy: `${updatedBy}.profile`,
      })
      if (Number(added?.added || 0) > 0) report.profile_email_links_added += 1
    }

    const assigned = await maybeAssignOwner(db, profileId, email, { apply })
    if (assigned.assigned) {
      report.ownership_assigned_planned += 1
      if (apply) report.ownership_assigned += 1
    } else if (assigned.reason) {
      report.ownership_skipped[assigned.reason] = (report.ownership_skipped[assigned.reason] || 0) + 1
      if (report.sample_skipped.length < 10 && assigned.reason !== 'already_owned') {
        report.sample_skipped.push({
          profile_id: profileId,
          display_name: p?.display_name ?? null,
          email,
          reason: assigned.reason,
          existing_profile_id: assigned.existing_profile_id ?? null,
        })
      }
    }
  }

  return report
}

