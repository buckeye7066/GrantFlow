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
  // Some tokens are profile-scoped and don't carry userId.
  // Resolve user_id via profile when needed, then check users.is_admin.
  try {
    const userId = getAuthUserId(user)
    const profileId = getAuthProfileId(user)

    let resolvedUserId = userId
    if (!resolvedUserId && profileId) {
      const profileRow = await db.prepare('SELECT user_id FROM profiles WHERE id = ?').get(profileId)
      resolvedUserId = profileRow?.user_id
    }

    if (!resolvedUserId) return false

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

export function getAuthUserId(user) {
  return user?.userId ?? user?.id ?? user?.user_id ?? null
}

export function getAuthProfileId(user) {
  return user?.profileId ?? user?.profile_id ?? null
}

export async function getAccessibleProfileIds(db, user) {
  if (await isAdminUserWithDb(db, user)) return null

  const ids = new Set()
  const userId = getAuthUserId(user)
  if (userId) {
    const rows = await db.prepare('SELECT id FROM profiles WHERE user_id = ?').all(userId)
    rows.forEach((row) => {
      if (row?.id) ids.add(row.id)
    })
  }

  // Allow additional profile access via email mapping (e.g. board members).
  const emails = collectUserEmails(user)
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
            likeArgs.push(`%\"email\"%${escapedEmail}%`)
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

  // Token-scoped profileId is always treated as accessible for the session.
  // This prevents lockouts for legacy/Base44 profiles that lack user_id/profile_emails mappings.
  // Security note: This is intentional per product requirements to maintain backward compatibility.
  // Tokens are already validated by auth middleware, so compromised tokens are a separate concern
  // that should be addressed via token rotation, expiry, and monitoring rather than here.
  const tokenProfileId = getAuthProfileId(user)
  if (tokenProfileId) {
    ids.add(tokenProfileId)
  }

  return ids
}

export async function isProfileOwner(db, user, profileId) {
  if (!profileId) return false
  if (isAdminUser(user)) return true
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

  const grant = await req.db.prepare('SELECT * FROM grants WHERE id = ?').get(grantId)
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
