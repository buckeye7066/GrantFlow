/**
 * serviceApplicationConversion.js — turn an accepted service application into a
 * REAL client profile.
 *
 * WHY THIS EXISTS (the "invisible Anita" bug, 2026-07-06):
 * The admin "Convert to Profile" button only PATCHed
 * `service_applications.status = 'converted'` — no profile was ever created or
 * linked. The admin saw "converted", the profile list showed nothing, and the
 * applicant could not log in (production auth only admits emails that match an
 * existing profile — see routes/auth.js /email/start gating). A new applicant
 * therefore vanished: application "converted", no profile, no login.
 *
 * This module is the single choke point for that conversion:
 *   - PATCH /api/service-application/:id (status -> converted) calls it.
 *   - enforceInvariants.js re-asserts it on boot for every already-'converted'
 *     row that lacks a live linked profile (the net that healed Anita's row).
 *
 * Matching is conservative, in line with the profile-dedupe playbook
 * ("don't create an empty duplicate and split the client's data"):
 *   1. app.profile_id that resolves to a live profile → keep it.
 *   2. exactly ONE live profile whose basic_information.email matches → link.
 *   3. exactly ONE live profile whose display_name matches full_name → link.
 *   4. multiple candidates → AMBIGUOUS: report, change nothing (human decides).
 *   5. zero candidates → CREATE the profile (canonical sections, name parts,
 *      email/phone in basic_information, profile_emails row so the applicant
 *      can actually log in, admin link, signup trial grant).
 */
import crypto from 'crypto'
import { supportedSectionKeys, getDefaultSectionData } from '../config/profileSchema.js'
import { deriveNamePartsIntoBasicInfo } from '../../shared/nameParsing.js'
import { resolveProfileType } from './profileTypeRegistry.js'
import { linkProfileToAdmin } from '../utils/adminProfileLinks.js'
import { addProfileEmails } from '../utils/accessControl.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('services:serviceApplicationConversion')

function normalizeEmail(value) {
  const v = String(value || '').trim().toLowerCase()
  return v && v.includes('@') ? v : null
}

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

async function profileIsLive(db, profileId) {
  if (!profileId) return false
  const row = await db
    .prepare('SELECT id, status FROM profiles WHERE id = ?')
    .get(String(profileId))
  return Boolean(row?.id) && String(row.status || '').toLowerCase() !== 'deleted'
}

async function findLiveProfilesByEmail(db, email) {
  if (!email) return []
  const dialect = db?.dialect || 'sqlite'
  const emailSql =
    dialect === 'postgres'
      ? `LOWER((ps.data::jsonb ->> 'email')) = ?`
      : `LOWER(json_extract(ps.data, '$.email')) = ?`
  const rows = await db
    .prepare(
      `
        SELECT DISTINCT p.id, p.display_name
        FROM profiles p
        JOIN profile_sections ps ON ps.profile_id = p.id
        WHERE ps.section_key = 'basic_information'
          AND ${emailSql}
          AND (p.status IS NULL OR LOWER(p.status) <> 'deleted')
        LIMIT 10
      `,
    )
    .all(email)
  return rows || []
}

async function findLiveProfilesByName(db, fullName) {
  const name = normalizeName(fullName)
  if (!name) return []
  const rows = await db
    .prepare(
      `
        SELECT id, display_name
        FROM profiles
        WHERE LOWER(display_name) = LOWER(?)
          AND (status IS NULL OR LOWER(status) <> 'deleted')
        LIMIT 10
      `,
    )
    .all(name)
  return rows || []
}

/**
 * Map a service-application client_category to a canonical profile type.
 * Falls back to the raw category (the type registry preserves unknowns).
 */
function profileTypeForCategory(clientCategory) {
  const raw = normalizeName(clientCategory)
  if (!raw) return 'individual'
  return resolveProfileType(raw) || raw.toLowerCase()
}

async function createProfileFromApplication(db, app, { actor } = {}) {
  const profileId = crypto.randomUUID()
  const displayName = normalizeName(app.full_name) || normalizeEmail(app.email) || 'New Client'
  const primaryType = profileTypeForCategory(app.client_category)
  const createdBy = actor || 'service_application_convert'

  await db
    .prepare(
      `
        INSERT INTO profiles (id, display_name, primary_type, organization_id, user_id, created_by, status, tags)
        VALUES (?, ?, ?, NULL, NULL, ?, 'active', ?)
      `,
    )
    .run(profileId, displayName, primaryType, createdBy, JSON.stringify([]))

  // Canonical sections with defaults (same shape as POST /profiles) so
  // downstream crawlers/scoring never hit a missing section.
  for (const sectionKey of supportedSectionKeys) {
    const defaults = getDefaultSectionData(sectionKey) ?? {}
    let data = defaults
    if (sectionKey === 'basic_information') {
      data = { ...defaults, full_name: displayName }
      const email = normalizeEmail(app.email)
      const phone = normalizeName(app.phone)
      if (email) data.email = email
      if (phone) data.phone = phone
      const derived = deriveNamePartsIntoBasicInfo(data, displayName)
      data = derived.data
    }
    await db
      .prepare(
        `
          INSERT INTO profile_sections (id, profile_id, section_key, data, updated_by)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(profile_id, section_key) DO NOTHING
        `,
      )
      .run(crypto.randomUUID(), profileId, sectionKey, JSON.stringify(data), createdBy)
  }

  // Login access: production /email/start only admits emails matching an
  // existing profile. The profile_emails row is what lets the applicant in.
  const email = normalizeEmail(app.email)
  if (email) {
    try {
      await addProfileEmails(db, { profileId, emails: [email], addedBy: createdBy })
    } catch (err) {
      log.warn('profile_emails link failed (non-fatal)', { profileId, error: err?.message })
    }
  }

  try {
    await linkProfileToAdmin(db, profileId)
  } catch (err) {
    log.warn('admin link failed (non-fatal)', { profileId, error: err?.message })
  }

  // Same new-client free trial every self-serve signup gets (best-effort).
  try {
    const { signupTrialGrant, freeWeekSignupGrant } = await import('../../shared/freeWeek.js')
    const trial = signupTrialGrant(process.env)
    const promo = freeWeekSignupGrant(process.env)
    const candidates = [
      trial && { period: trial.period, days: trial.days, reason: 'signup_trial', grantedBy: 'signup_trial' },
      promo && { period: promo.period, days: promo.days, reason: 'free_week_signup', grantedBy: 'free_week_promo' },
    ].filter(Boolean)
    if (candidates.length) {
      const best = candidates.sort((a, b) => b.days - a.days)[0]
      const { grantFreePeriod } = await import('./billing/invoiceService.js')
      await grantFreePeriod(db, {
        profileId,
        kind: best.period,
        reason: best.reason,
        grantedBy: best.grantedBy,
        announce: false,
      })
    }
  } catch (err) {
    log.warn('signup trial grant failed (non-fatal)', { profileId, error: err?.message })
  }

  return profileId
}

/**
 * Convert one service application to a linked, visible profile.
 *
 * @returns {Promise<
 *   | { ok: true, profileId: string, created: boolean, matchedBy: 'existing_link'|'email'|'name'|'created' }
 *   | { ok: false, ambiguous: true, candidates: Array<{id: string, display_name: string}> }
 * >}
 */
export async function convertApplicationToProfile(db, app, { actor, allowCreate = true } = {}) {
  if (!app?.id) throw new Error('application row required')

  // 1. Already linked to a live profile → nothing to create.
  if (app.profile_id && (await profileIsLive(db, app.profile_id))) {
    return { ok: true, profileId: String(app.profile_id), created: false, matchedBy: 'existing_link' }
  }

  // 2/3. Conservative matching before creating anything.
  const email = normalizeEmail(app.email)
  const byEmail = await findLiveProfilesByEmail(db, email)
  let matched = null
  let matchedBy = null
  if (byEmail.length === 1) {
    matched = byEmail[0]
    matchedBy = 'email'
  } else if (byEmail.length > 1) {
    return { ok: false, ambiguous: true, candidates: byEmail }
  } else {
    const byName = await findLiveProfilesByName(db, app.full_name)
    if (byName.length === 1) {
      matched = byName[0]
      matchedBy = 'name'
    } else if (byName.length > 1) {
      return { ok: false, ambiguous: true, candidates: byName }
    }
  }

  let profileId
  let created = false
  if (matched) {
    profileId = String(matched.id)
    // Make sure the applicant's email opens THIS profile at login.
    if (email) {
      try {
        await addProfileEmails(db, { profileId, emails: [email], addedBy: actor || 'service_application_convert' })
      } catch (err) {
        log.warn('profile_emails link failed (non-fatal)', { profileId, error: err?.message })
      }
    }
  } else {
    if (!allowCreate) {
      // Caller (the boot sweep, for non-intake rows) wants link-only semantics.
      return { ok: false, noMatch: true, candidates: [] }
    }
    profileId = await createProfileFromApplication(db, app, { actor })
    created = true
    matchedBy = 'created'
  }

  await db
    .prepare(
      `
        UPDATE service_applications
        SET profile_id = ?, status = 'converted', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
    )
    .run(profileId, String(app.id))

  log.info('application converted to profile', {
    application_id: app.id,
    profile_id: profileId,
    created,
    matched_by: matchedBy,
  })

  return { ok: true, profileId, created, matchedBy }
}

/**
 * Boot-sweep helper: every 'converted' application must point at a live
 * profile. Returns counts for the enforceInvariants summary.
 */
export async function reconcileConvertedApplications(db, { actor = 'invariant:converted_applications' } = {}) {
  let rows = []
  try {
    rows = await db
      .prepare(`SELECT * FROM service_applications WHERE status = 'converted'`)
      .all()
  } catch (err) {
    // Table may not exist yet on a fresh environment — nothing to reconcile.
    const msg = String(err?.message || err)
    if (msg.includes('no such table') || msg.includes('does not exist')) {
      return { scanned: 0, repaired: 0, createdProfiles: 0, flagged: 0 }
    }
    throw err
  }

  let repaired = 0
  let createdProfiles = 0
  let flagged = 0
  for (const app of rows || []) {
    try {
      if (app.profile_id && (await profileIsLive(db, app.profile_id))) continue
      // Rows with neither an email nor a name can't be converted safely.
      if (!normalizeEmail(app.email) && !normalizeName(app.full_name)) {
        flagged += 1
        continue
      }
      // Auto-CREATE only for real intake-form rows. 'signup' (and other) rows
      // had their profile created at signup time — conjuring a fresh one later
      // would duplicate the client and split their data (dedupe playbook), so
      // for those the sweep links to an existing profile or flags the row.
      const allowCreate = String(app.type || '') === 'service_application'
      const result = await convertApplicationToProfile(db, app, { actor, allowCreate })
      if (result.ok) {
        repaired += 1
        if (result.created) createdProfiles += 1
      } else {
        flagged += 1
        log.warn('converted application left for human review', {
          application_id: app.id,
          reason: result.noMatch ? 'no_match_link_only' : 'ambiguous',
          candidates: result.candidates?.map((c) => c.id),
        })
      }
    } catch (err) {
      flagged += 1
      log.warn('converted-application reconcile failed for row (non-fatal)', {
        application_id: app?.id,
        error: err?.message,
      })
    }
  }

  return { scanned: rows.length, repaired, createdProfiles, flagged }
}
