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
const ADMIN_EMAIL_ALLOWLIST_SUBSTRING = 'buckeye7066'

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
  const profileId = getAuthProfileId(user)
  if (profileId) ids.add(profileId)

  const userId = getAuthUserId(user)
  if (userId) {
    const rows = await db.prepare('SELECT id FROM profiles WHERE user_id = ?').all(userId)
    rows.forEach((row) => {
      if (row?.id) ids.add(row.id)
    })
  }

  return ids
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

