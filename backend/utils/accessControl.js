/**
 * Centralized access control helpers.
 *
 * Goal:
 * - Non-admin users can only access data tied to their own profiles/organizations.
 * - Admin users can access everything.
 *
 * IMPORTANT:
 * - Canonical admin truth is DB-backed: users.is_admin.
 * - Email-substring allowlists must not participate in authorization decisions.
 */
import crypto from 'crypto'
import { isSyntheticIdWithoutProvenance, isReservedSyntheticUserId } from '../middleware/syntheticServiceTokens.js'
import { withProfileScope } from '../middleware/profileContext.js'

function normalizeEmail(email = '') {
  const v = String(email || '').trim().toLowerCase()
  return v || null
}

function collectUserEmails(user) {
  const emails = new Set()
  const primary = normalizeEmail(user?.primary_email)
  const secondary = normalizeEmail(user?.email)
  if (primary) emails.add(primary)
  if (secondary) emails.add(secondary)
  return Array.from(emails)
}

/**
 * Check if user is admin based on token claims only (fast path).
 * 
 * DEPRECATED: Use req.ctx.isAdmin instead, which is DB-backed.
 * This function is kept for backward compatibility in non-critical paths.
 * 
 * For authorization decisions, ALWAYS use isAdminUserWithDb or req.ctx.isAdmin.
 */
export function isAdminUser(user) {
  return Boolean(
    user?.role === 'admin' ||
      user?.isAdmin === true ||
      user?.is_admin === true ||
      user?.is_admin === 1 ||
      (Array.isArray(user?.roles) && user.roles.includes('admin')),
  )
}

export async function isAdminUserWithDb(db, user) {
  // A JWT whose sub collides with a reserved synthetic service id but lacks
  // service-token provenance must NEVER resolve admin — even if a self-healed
  // users.id='system_admin_token' row exists. Provenance-validated service tokens
  // resolve admin earlier (via req.ctx.isAdmin); this guards the direct callers.
  if (isSyntheticIdWithoutProvenance(user)) return false
  // Some tokens are profile-scoped and don't carry userId.
  // Resolve user_id via profile when needed, then check users.is_admin.
  //
  // IMPORTANT:
  // Some auth sessions carry only email (and no userId/profileId), or carry a profileId whose
  // profiles.user_id is NULL (legacy data). In those cases, we must still be able to
  // resolve the user record by email; otherwise admins can “lose” admin capabilities depending
  // on which profile they’re currently scoped to.
  try {
    const userId = getAuthUserId(user)
    const profileId = getAuthProfileId(user)

    let resolvedUserId = userId
    if (!resolvedUserId && profileId) {
      const profileRow = await db.prepare('SELECT user_id FROM profiles WHERE id = ?').get(profileId)
      resolvedUserId = profileRow?.user_id
    }

    // A resolved userId that is a reserved synthetic service id (e.g. reached via a
    // token profile_id -> profiles.user_id='system_admin_token') must NOT resolve
    // admin without service-token provenance — never honor the self-healed synthetic row.
    if (resolvedUserId && isReservedSyntheticUserId(resolvedUserId) && user?.serviceToken !== true) {
      return false
    }

    // Fallback: resolve via email if present.
    // This is still DB-backed (users table), not an allowlist.
    if (!resolvedUserId) {
      const emails = collectUserEmails(user)
      if (emails.length > 0) {
        const placeholders = emails.map(() => '?').join(', ')
        let row = null
        // Some deployments only have users.primary_email (SQLite schema), while others
        // may also have a users.email column. Try the broader query first, then fall back.
        try {
          row = await db
            .prepare(
              `
                SELECT id, is_admin
                FROM users
                WHERE lower(primary_email) IN (${placeholders})
                   OR lower(email) IN (${placeholders})
                LIMIT 1
              `,
            )
            .get(...emails, ...emails)
        } catch {
          row = await db
            .prepare(
              `
                SELECT id, is_admin
                FROM users
                WHERE lower(primary_email) IN (${placeholders})
                LIMIT 1
              `,
            )
            .get(...emails)
        }
        if (!row) return false
        // A token email that matches a self-healed synthetic-admin row must not
        // grant admin without service-token provenance.
        if (isReservedSyntheticUserId(row.id) && user?.serviceToken !== true) return false
        return Boolean(row.is_admin === true || row.is_admin === 1)
      }
      return false
    }

    const row = await db.prepare('SELECT is_admin FROM users WHERE id = ?').get(resolvedUserId)
    if (!row) return false

    return Boolean(row.is_admin === true || row.is_admin === 1)
  } catch (error) {
    // Fail closed: never grant admin on DB errors.
    console.warn('[accessControl] isAdminUserWithDb DB check failed:', error?.message)
    return false
  }
}

export async function ensureProfileEmailSchema(db) {
  const dialect = db?.dialect || 'sqlite'
  if (dialect === 'postgres') {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS profile_emails (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        added_by TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_profile_emails_profile_id ON profile_emails(profile_id);
      -- Store normalized (lowercased) emails, so the unique index can be simple and
      -- INSERT ... ON CONFLICT can safely target the constraint.
      CREATE UNIQUE INDEX IF NOT EXISTS ux_profile_emails_profile_email ON profile_emails(profile_id, email);
    `)
  } else {
    // SQLite: use NOCASE collation for uniqueness (case-insensitive).
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_emails (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        added_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_profile_emails_profile_id ON profile_emails(profile_id);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_profile_emails_profile_email ON profile_emails(profile_id, email COLLATE NOCASE);
    `)
  }
}

export function requireAuthenticatedUser(req, res) {
  const user = req.user ?? { role: 'guest' }
  if (!user || user.role === 'guest') {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }
  return user
}

export function requireAuthenticatedUserMiddleware(req, res, next) {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  req.user = req.user ?? user
  return next()
}

export function getAuthUserId(user) {
  return user?.userId ?? user?.id ?? user?.user_id ?? null
}

export function getAuthProfileId(user) {
  return user?.profileId ?? user?.profile_id ?? null
}

/**
 * DB-TRUSTED email addresses for a user: users.primary_email plus any VERIFIED
 * email credential (user_credentials type='email_otp' with verified_at set),
 * looked up by the RESOLVED userId. It NEVER returns the token-supplied
 * user.email — a signed/stale JWT could otherwise claim victim@example.com and
 * pick up every profile mapped to that email (profile_emails / basic_information).
 * Email-based access/grant decisions must use ONLY these DB-verified addresses.
 */
export async function getTrustedUserEmails(db, user) {
  const emails = new Set()
  const userId = getAuthUserId(user)
  if (!userId) return []
  try {
    const row = await db.prepare('SELECT primary_email FROM users WHERE id = ?').get(String(userId))
    const primary = normalizeEmail(row?.primary_email)
    if (primary) emails.add(primary)
  } catch {
    // ignore (missing users row / schema)
  }
  // DB-verified secondary emails (email-OTP credentials that were actually verified).
  try {
    const rows = await db
      .prepare("SELECT identifier FROM user_credentials WHERE user_id = ? AND type = 'email_otp' AND verified_at IS NOT NULL")
      .all(String(userId))
    for (const r of rows || []) {
      const e = normalizeEmail(r?.identifier)
      if (e) emails.add(e)
    }
  } catch {
    // ignore (older schema without user_credentials)
  }
  return Array.from(emails)
}

/**
 * DB-trusted personal profile set: profiles owned/created by the user, profiles
 * granted to the user's DB-VERIFIED email(s) (never a token email), and — only
 * via the legacy profile-token provenance flag — the token profileId. Does NOT
 * short-circuit for admins; callers wanting the admin all-access sentinel use
 * getAccessibleProfileIds.
 */
export async function getOwnedAndGrantedProfileIds(db, user) {
  const ids = new Set()
  const userId = getAuthUserId(user)

  // A userId that collides with a reserved synthetic service id but lacks
  // service-token provenance (e.g. a signed JWT with sub:'system_admin_token') is
  // an impersonation attempt — grant NOTHING, and never honor a self-healed
  // users.id='system_admin_token' row via the users-row gate below.
  if (isSyntheticIdWithoutProvenance(user)) return ids

  // FAIL CLOSED on a missing principal: a stale/forged JWT for a DELETED user
  // (userId present but no users row) must gain NOTHING — even if a lingering
  // profiles.user_id / created_by still references that id. Require a real users
  // row for the resolved userId, OR a validated provenance token that legitimately
  // has no users row (synthetic service token / DB-verified legacy profile token).
  // Centralized here so EVERY caller — scope=mine, /api/auth/me, and
  // ensureProfileAccess (via getAccessibleProfileIds) — inherits the guard rather
  // than relying on ctx.accessibleProfileIds.
  const hasProvenance = user?.serviceToken === true || user?.profileTokenAuth === true
  if (!hasProvenance) {
    if (!userId) return ids
    let userRow = null
    try {
      userRow = await db.prepare('SELECT id FROM users WHERE id = ?').get(String(userId))
    } catch {
      return ids // DB error → fail closed
    }
    if (!userRow) return ids // deleted / nonexistent user → no profiles
  }

  if (userId) {
    const rows = await db.prepare('SELECT id FROM profiles WHERE user_id = ?').all(userId)
    rows.forEach((row) => {
      if (row?.id) ids.add(row.id)
    })
    // Profiles created by this user (e.g. admin-created shells later reassigned) stay visible to the creator.
    try {
      const createdRows = await db.prepare('SELECT id FROM profiles WHERE created_by = ?').all(userId)
      createdRows.forEach((row) => {
        if (row?.id) ids.add(row.id)
      })
    } catch {
      // ignore (older schemas)
    }
  }

  // Additional profile access via email mapping (e.g. board members) derives from
  // DB-TRUSTED emails ONLY — never the token-supplied user.email.
  const emails = await getTrustedUserEmails(db, user)
  if (emails.length > 0) {
    // 1) Explicit allowlist table (profile_emails).
    try {
      await ensureProfileEmailSchema(db)
      const placeholders = emails.map(() => '?').join(', ')
      const rows = await db
        .prepare(
          `
            SELECT DISTINCT profile_id
            FROM profile_emails
            WHERE lower(email) IN (${placeholders})
          `,
        )
        .all(...emails)
      rows.forEach((row) => {
        if (row?.profile_id) ids.add(row.profile_id)
      })
    } catch {
      // Keep running even if schema isn't present yet.
    }

    // 2) Self-healing fallback: if the profile's saved "basic_information.email" matches the user,
    // grant access even if profiles.user_id/profile_emails are not populated yet.
    //
    // This is critical for real production data where profiles may pre-exist users, or where
    // ownership was never assigned. Product requirement: "email on the profile" implies access.
    try {
      const placeholders = emails.map(() => '?').join(', ')
      if (db?.dialect === 'postgres') {
        const rows = await db
          .prepare(
            `
              SELECT DISTINCT ps.profile_id
              FROM profile_sections ps
              WHERE ps.section_key = 'basic_information'
                AND LOWER((ps.data::jsonb ->> 'email')) IN (${placeholders})
            `,
          )
          .all(...emails)
        rows.forEach((row) => {
          if (row?.profile_id) ids.add(row.profile_id)
        })
      } else {
        // SQLite: prefer json_extract when json1 is available.
        try {
          const rows = await db
            .prepare(
              `
                SELECT DISTINCT ps.profile_id
                FROM profile_sections ps
                WHERE ps.section_key = 'basic_information'
                  AND LOWER(json_extract(ps.data, '$.email')) IN (${placeholders})
              `,
            )
            .all(...emails)
          rows.forEach((row) => {
            if (row?.profile_id) ids.add(row.profile_id)
          })
        } catch {
          // Fallback: match in JSON string (works even if json1 isn't enabled).
          // We intentionally keep this best-effort and low risk; if it fails, access simply relies on other mechanisms.
          const likeClauses = []
          const likeArgs = []
          for (const email of emails) {
            const escapedEmail = String(email)
              .toLowerCase()
              .replace(/\\/g, '\\\\')
              .replace(/"/g, '\\"')
            likeClauses.push('LOWER(ps.data) LIKE ?')
            likeArgs.push(`%"email"%${escapedEmail}%`)
          }
          if (likeClauses.length > 0) {
            const rows = await db
              .prepare(
                `
                  SELECT DISTINCT ps.profile_id
                  FROM profile_sections ps
                  WHERE ps.section_key = 'basic_information'
                    AND (${likeClauses.join(' OR ')})
                `,
              )
              .all(...likeArgs)
            rows.forEach((row) => {
              if (row?.profile_id) ids.add(row.profile_id)
            })
          }
        }
      }
    } catch {
      // ignore (best-effort)
    }
  }

  // A token-scoped profileId is access proof ONLY for the DB-verified legacy
  // profile bearer token (provenance flag `profileTokenAuth`, set solely in the
  // legacy-token auth branch — non-prod, opt-in). A JWT's payload.profile_id is
  // just a claim and MUST NOT self-authorize an arbitrary tenant: accessible
  // profiles are derived from DB ownership / email grants above. A stale/forged
  // JWT profile_id is rejected here and re-validated against this set by
  // requestContext (activeProfileId is dropped when not in the accessible set).
  if (user?.profileTokenAuth === true) {
    const tokenProfileId = getAuthProfileId(user)
    if (tokenProfileId) ids.add(tokenProfileId)
  }

  // Strip soft-deleted profiles so they never appear in the accessible set.
  if (ids.size > 0) {
    try {
      const placeholders = [...ids].map(() => '?').join(', ')
      const deletedRows = await db
        .prepare(`SELECT id FROM profiles WHERE id IN (${placeholders}) AND status = 'deleted'`)
        .all(...ids)
      for (const r of deletedRows) {
        if (r?.id) ids.delete(r.id)
      }
    } catch {
      // Schema may lack status column in older deployments; keep set unchanged.
    }
  }
  return ids
}

export async function getAccessibleProfileIds(db, user) {
  if (await isAdminUserWithDb(db, user)) return null
  return getOwnedAndGrantedProfileIds(db, user)
}

/**
 * Reverse of getAccessibleProfileIds: every USER id that can access a given
 * profile — its owner + creator, anyone on the profile_emails allowlist, and
 * anyone whose account email matches the profile's basic_information.email.
 *
 * Used to fan profile-scoped notifications out to everyone who manages a profile
 * (e.g. a parent AND the student on their own login), not just the single
 * profiles.user_id row. Defensive: every lookup is wrapped so a schema quirk
 * never throws on a notification path.
 */
export async function getUserIdsWithProfileAccess(db, profileId) {
  const ids = new Set()
  if (!db || !profileId) return ids

  // 1. Owner + creator on the profile row. Queried as two separate
  // statements — a schema missing the secondary `created_by` column (some
  // minimal fixtures never added it) must not also swallow the primary
  // `user_id` ownership signal, which a single combined SELECT would do.
  try {
    const row = await db.prepare('SELECT user_id FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
    if (row?.user_id) ids.add(String(row.user_id))
  } catch { /* older schema / missing column */ }
  try {
    const row = await db.prepare('SELECT created_by FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
    if (row?.created_by) ids.add(String(row.created_by))
  } catch { /* older schema / missing column */ }

  // 2. Emails associated with the profile (allowlist + basic_information.email).
  const emails = new Set()
  try {
    await ensureProfileEmailSchema(db)
    const rows = await db.prepare('SELECT email FROM profile_emails WHERE profile_id = ?').all(String(profileId))
    for (const r of rows || []) if (r?.email) emails.add(String(r.email).toLowerCase())
  } catch { /* ignore */ }
  try {
    const r = await db
      .prepare(`SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'basic_information' LIMIT 1`)
      .get(String(profileId))
    if (r?.data) {
      const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data
      if (d?.email) emails.add(String(d.email).toLowerCase())
    }
  } catch { /* ignore */ }

  // 3. Map those emails → user ids.
  if (emails.size > 0) {
    const list = [...emails]
    const placeholders = list.map(() => '?').join(', ')
    try {
      const rows = await db.prepare(`SELECT id FROM users WHERE LOWER(primary_email) IN (${placeholders})`).all(...list)
      for (const r of rows || []) if (r?.id) ids.add(String(r.id))
    } catch { /* users schema variance */ }
  }
  return ids
}

export async function isProfileOwner(db, user, profileId) {
  if (!profileId) return false
  if (await isAdminUserWithDb(db, user)) return true
  const userId = getAuthUserId(user)
  if (!userId) return false
  const row = await db.prepare('SELECT id FROM profiles WHERE id = ? AND user_id = ?').get(profileId, userId)
  return Boolean(row?.id)
}

export async function listProfileEmails(db, profileId) {
  await ensureProfileEmailSchema(db)
  const rows = await db
    .prepare(
      `
        SELECT id, profile_id, email, added_by, created_at
        FROM profile_emails
        WHERE profile_id = ?
        ORDER BY created_at ASC
      `,
    )
    .all(profileId)
  return rows.map((row) => ({
    id: row.id,
    profile_id: row.profile_id,
    email: row.email,
    added_by: row.added_by ?? null,
    created_at: row.created_at ?? null,
  }))
}

export async function addProfileEmails(db, { profileId, emails, addedBy }) {
  await ensureProfileEmailSchema(db)
  const normalized = (Array.isArray(emails) ? emails : [emails])
    .map((e) => normalizeEmail(e))
    .filter(Boolean)
  const unique = Array.from(new Set(normalized))
  if (unique.length === 0) return { added: 0 }

  const dialect = db?.dialect || 'sqlite'
  const insertSql =
    dialect === 'postgres'
      ? `
          INSERT INTO profile_emails (id, profile_id, email, added_by)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (profile_id, email) DO NOTHING
        `
      : `
          INSERT OR IGNORE INTO profile_emails (id, profile_id, email, added_by)
          VALUES (?, ?, ?, ?)
        `

  let added = 0
  for (const email of unique) {
    const id = crypto.randomUUID()
    const res = await db.prepare(insertSql).run(id, profileId, email, addedBy ?? null)
    if ((res?.changes ?? 0) > 0) added += 1
  }
  return { added }
}

export async function removeProfileEmail(db, { profileId, emailId }) {
  await ensureProfileEmailSchema(db)
  const res = await db.prepare('DELETE FROM profile_emails WHERE id = ? AND profile_id = ?').run(emailId, profileId)
  return { removed: (res?.changes ?? 0) > 0 }
}

export async function getAccessibleOrganizationIds(db, user) {
  if (await isAdminUserWithDb(db, user)) return null

  const profileIds = await getAccessibleProfileIds(db, user)
  if (!profileIds || profileIds.size === 0) return new Set()

  const placeholders = Array.from(profileIds).map(() => '?').join(', ')
  const rows = await db
    .prepare(`SELECT DISTINCT organization_id FROM profiles WHERE id IN (${placeholders})`)
    .all(...Array.from(profileIds))

  const orgIds = new Set()
  rows.forEach((row) => {
    if (row?.organization_id) orgIds.add(row.organization_id)
  })
  return orgIds
}

/**
 * Route-level defense-in-depth for the structural identity gate: deny a request
 * whose identity did not resolve to a trusted principal (real users row /
 * validated service or legacy-token provenance) and which is not an admin. The
 * global enforceResolvedIdentity middleware already nulls such a caller's id, but
 * user-scoped routes call this at entry so the denial is explicit (403).
 */
export function requireResolvedIdentity(req, res) {
  if (req.ctx?.isAdmin === true || req.ctx?.identityResolved === true) return true
  res.status(403).json({ error: 'Not authorized' })
  return false
}

export async function ensureProfileAccess(req, res, profileId) {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return false

  if (!profileId) {
    res.status(400).json({ error: 'Profile ID required' })
    return false
  }

  if (req.ctx?.isAdmin === true) return true
  if (await isAdminUserWithDb(req.db, user)) return true

  const accessible = await getAccessibleProfileIds(req.db, user)
  if (accessible && accessible.has(profileId)) return true

  res.status(403).json({ error: 'Not authorized to access this profile' })
  return false
}

export async function ensureOrganizationAccess(req, res, organizationId) {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return false

  if (!organizationId) {
    res.status(400).json({ error: 'Organization ID required' })
    return false
  }

  if (req.ctx?.isAdmin === true) return true
  if (await isAdminUserWithDb(req.db, user)) return true

  const orgIds = await getAccessibleOrganizationIds(req.db, user)
  if (orgIds && orgIds.has(organizationId)) return true

  res.status(403).json({ error: 'Not authorized to access this organization' })
  return false
}

export async function ensureGrantAccess(req, res, grantId) {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return null

  // Pre-authorization lookup: this read MUST span profiles because its result
  // is what the authorization decision below is made FROM (profile match, org
  // match, admin). Under a non-admin tenant claim the profile-scope guard
  // rightly rejects unscoped `grants` reads, which made every non-admin
  // grant-by-id route (GET/PUT/PATCH status/DELETE) 500 with
  // PROFILE_SCOPE_VIOLATION in production (observed live 2026-08-16). The
  // sanctioned pattern for access-check reads is an explicit scope bypass
  // (see routes/grants.js runLegacyProfilelessGrantQuery); the row is never
  // returned to the caller unless one of the checks below passes.
  const grant = await withProfileScope({ bypass: true }, () =>
    req.db.prepare('SELECT * FROM grants WHERE id = ?').get(grantId),
  )
  if (!grant) {
    res.status(404).json({ error: 'Grant not found' })
    return null
  }

  // Use req.ctx if available (preferred)
  if (req.ctx) {
    if (req.ctx.isAdmin) return grant
    
    if (req.ctx.accessibleOrgIds === null) {
      // null means all accessible (admin)
      return grant
    }
    
    if (grant.profile_id && req.ctx.accessibleProfileIds instanceof Set && req.ctx.accessibleProfileIds.has(grant.profile_id)) {
      return grant
    }

    if (grant.organization_id && req.ctx.accessibleOrgIds && req.ctx.accessibleOrgIds.has(grant.organization_id)) {
      return grant
    }
  } else {
    // Fallback to legacy check if req.ctx not available
    if (isAdminUser(user)) return grant

    const orgIds = await getAccessibleOrganizationIds(req.db, user)
    if (orgIds && grant.organization_id && orgIds.has(grant.organization_id)) {
      return grant
    }
  }

  res.status(403).json({ error: 'Not authorized to access this grant' })
  return null
}

/**
 * Middleware-style admin check using DB-backed admin detection.
 * Prefers req.ctx.isAdmin (set by requestContext middleware) for consistency.
 * Falls back to isAdminUserWithDb if req.ctx is not available.
 * 
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @returns {Promise<boolean>} true if user is admin
 */
export async function ensureAdminUser(req, res) {
  const user = req.user ?? { role: 'guest' }
  
  if (!user || user.role === 'guest') {
    res.status(401).json({ error: 'Authentication required' })
    return false
  }

  // Prefer req.ctx.isAdmin (canonical, set by requestContext middleware)
  let isAdmin = false
  if (req.ctx && typeof req.ctx.isAdmin === 'boolean') {
    isAdmin = req.ctx.isAdmin
  } else {
    // Fallback to DB check if req.ctx not available
    isAdmin = await isAdminUserWithDb(req.db, user)
  }

  if (!isAdmin) {
    res.status(403).json({
      error: 'Access denied',
      message: 'This endpoint is restricted to administrators only'
    })
    return false
  }

  return true
}

/**
 * Build a grant access-scope SQL clause from the request context populated by
 * attachRequestContext (req.ctx: { isAdmin, accessibleProfileIds,
 * accessibleOrgIds }). Admins (or a null id set, which the access layer uses to
 * mean "all") get `1 = 1`; everyone else is restricted to grants tied to one of
 * their accessible organizations or profiles. An empty access set yields
 * `1 = 0` so a no-access caller honestly gets zeros, never the whole table.
 *
 * This is the single source of truth for grant scoping on aggregate endpoints
 * (e.g. /api/pipeline/stats), so every dashboard count is access-consistent
 * with /api/stats/dashboard instead of leaking DB-wide totals.
 *
 * @returns {{ sql: string, params: Array<string|number> }}
 */
export function buildGrantScopeFromContext(ctx) {
  const isAdmin = Boolean(ctx?.isAdmin)
  const profileIds = ctx?.accessibleProfileIds
  const orgIds = ctx?.accessibleOrgIds
  // null id set = "all rows" (admin classification inside the access layer).
  if (isAdmin || profileIds === null || orgIds === null) {
    return { sql: '1 = 1', params: [] }
  }
  const orgList = [...(orgIds || [])]
  const profileList = [...(profileIds || [])]
  const orgSql = orgList.length ? `organization_id IN (${orgList.map(() => '?').join(', ')})` : '1 = 0'
  const profileSql = profileList.length ? `profile_id IN (${profileList.map(() => '?').join(', ')})` : '1 = 0'
  return { sql: `(${orgSql} OR ${profileSql})`, params: [...orgList, ...profileList] }
}
