/**
 * Centralized access control helpers.
 *
 * Goal:
 * - Non-admin users can only access data tied to their own profiles/organizations.
 * - Admin users can access everything.
 *
 * Notes:
 * - This codebase has a few different "admin" representations (role, is_admin, email allowlist).
 *   We keep backward compatibility by treating any of them as admin.
 */
import crypto from 'crypto'

const ADMIN_EMAIL_ALLOWLIST_SUBSTRING = 'buckeye7066'

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

export function isAdminUser(user) {
  const email = String(user?.primary_email || user?.email || '').toLowerCase()
  return Boolean(
    user?.role === 'admin' ||
      user?.is_admin === true ||
      user?.is_admin === 1 ||
      (Array.isArray(user?.roles) && user.roles.includes('admin')) ||
      (email && email.includes(ADMIN_EMAIL_ALLOWLIST_SUBSTRING)),
  )
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
  if (isAdminUser(user)) return null

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
  }

  // Only trust token-scoped profileId if it is ALSO authorized via user_id or profile_emails.
  const tokenProfileId = getAuthProfileId(user)
  if (tokenProfileId && ids.has(tokenProfileId)) {
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
  if (isAdminUser(user)) return null

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

  if (isAdminUser(user)) return true

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

  if (isAdminUser(user)) return true

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

  if (isAdminUser(user)) return grant

  const orgIds = await getAccessibleOrganizationIds(req.db, user)
  if (orgIds && grant.organization_id && orgIds.has(grant.organization_id)) {
    return grant
  }

  res.status(403).json({ error: 'Not authorized to access this grant' })
  return null
}

