function normalizeId(value) {
  if (value == null) return null
  const trimmed = String(value).trim()
  return trimmed ? trimmed : null
}

function normalizeEmail(value) {
  if (value == null) return null
  const trimmed = String(value).trim().toLowerCase()
  return trimmed ? trimmed : null
}

async function tryGetUserRow(db, userId) {
  if (!userId) return null
  try {
    return (
      (await db
        .prepare(
          `
            SELECT id, primary_email, is_admin
            FROM users
            WHERE id = ?
            LIMIT 1
          `,
        )
        .get(userId)) ?? null
    )
  } catch {
    return null
  }
}

async function tryGetProfileUserId(db, profileId) {
  if (!profileId) return null
  try {
    const row = await db
      .prepare(
        `
          SELECT user_id
          FROM profiles
          WHERE id = ?
          LIMIT 1
        `,
      )
      .get(profileId)
    return normalizeId(row?.user_id)
  } catch {
    return null
  }
}

async function supportsProfileEmails(db) {
  try {
    await db.prepare('SELECT 1 FROM profile_emails LIMIT 1').get()
    return true
  } catch {
    return false
  }
}

async function computeAccessibleProfileIds({ db, userId, emails }) {
  const ids = new Set()

  if (userId) {
    const rows = await db
      .prepare(
        `
          SELECT id
          FROM profiles
          WHERE user_id = ?
        `,
      )
      .all(userId)
    for (const row of rows || []) {
      if (row?.id) ids.add(String(row.id))
    }
  }

  if (emails.length > 0 && (await supportsProfileEmails(db))) {
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
    for (const row of rows || []) {
      if (row?.profile_id) ids.add(String(row.profile_id))
    }
  }

  return ids
}

async function computeAccessibleOrgIds({ db, accessibleProfileIds }) {
  if (!accessibleProfileIds || accessibleProfileIds.size === 0) return new Set()
  const ids = Array.from(accessibleProfileIds)
  const placeholders = ids.map(() => '?').join(', ')
  const rows = await db
    .prepare(
      `
        SELECT DISTINCT organization_id
        FROM profiles
        WHERE id IN (${placeholders})
          AND organization_id IS NOT NULL
      `,
    )
    .all(...ids)
  const orgIds = new Set()
  for (const row of rows || []) {
    if (row?.organization_id) orgIds.add(String(row.organization_id))
  }
  return orgIds
}

function resolveRequestedProfileId(req) {
  // Allow clients to explicitly set active profile (admin/user).
  const header =
    req.headers['x-profile-id'] ||
    req.headers['x-active-profile-id'] ||
    req.headers['x-profile'] ||
    null
  if (typeof header === 'string' && header.trim()) return header.trim()
  if (Array.isArray(header) && typeof header[0] === 'string' && header[0].trim()) return header[0].trim()

  // Legacy: bearer JWT may contain a profile_id claim exposed via req.user.profileId
  const fromUser = req.user?.profileId ?? req.user?.profile_id ?? null
  return normalizeId(fromUser)
}

export default function requestContext() {
  return async (req, res, next) => {
    try {
      const db = req.db
      if (!db) {
        req.ctx = {
          db: null,
          userId: null,
          email: null,
          isAdmin: false,
          activeProfileId: null,
          accessibleProfileIds: new Set(),
          accessibleOrgIds: new Set(),
        }
        return next()
      }

      const authUser = req.user ?? { role: 'guest' }

      // Derive userId from req.user first, but fall back to profile->user_id when needed.
      const initialUserId = normalizeId(authUser.userId ?? authUser.id ?? authUser.user_id ?? null)
      const requestedProfileId = resolveRequestedProfileId(req)
      const fallbackUserId = initialUserId ? null : await tryGetProfileUserId(db, requestedProfileId)
      const userId = initialUserId ?? fallbackUserId

      const userRow = await tryGetUserRow(db, userId)
      const email = normalizeEmail(userRow?.primary_email) ?? normalizeEmail(authUser.email ?? authUser.primary_email ?? null)

      // Canonical admin: ONLY from DB users.is_admin.
      const isAdmin = Boolean(userRow?.is_admin)

      const emails = Array.from(new Set([email].filter(Boolean)))

      const accessibleProfileIds = isAdmin
        ? null
        : await computeAccessibleProfileIds({
            db,
            userId,
            emails,
          })

      const accessibleOrgIds = isAdmin
        ? null
        : await computeAccessibleOrgIds({
            db,
            accessibleProfileIds,
          })

      // Active profile:
      // - Admin: allow any selected profile without 403 (admin bypass).
      // - Non-admin: only allow if in accessibleProfileIds.
      let activeProfileId = null
      if (isAdmin) {
        activeProfileId = requestedProfileId
      } else if (requestedProfileId && accessibleProfileIds?.has(String(requestedProfileId))) {
        activeProfileId = String(requestedProfileId)
      } else {
        activeProfileId = accessibleProfileIds && accessibleProfileIds.size > 0 ? Array.from(accessibleProfileIds)[0] : null
      }

      req.ctx = {
        db,
        userId,
        email,
        isAdmin,
        activeProfileId,
        accessibleProfileIds: accessibleProfileIds ?? null,
        accessibleOrgIds: accessibleOrgIds ?? null,
      }

      // Back-compat: keep req.db canonicalized to ctx.db.
      req.db = db

      return next()
    } catch (error) {
      console.error('[requestContext] failed:', error?.message || String(error))
      return res.status(503).json({
        error: 'Request context unavailable',
        error_type: 'request_context_unavailable',
        request_id: req.requestId || null,
      })
    }
  }
}

