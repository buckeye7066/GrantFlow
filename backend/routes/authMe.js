/**
 * Auth "me" and diagnostics routes
 *
 * Provides:
 *   GET /api/auth/me         — Returns the current authenticated user with their accessible profiles.
 *   GET /api/auth/diagnostics — Admin-only operational status of the auth subsystem.
 *
 * These handlers were previously defined inline in server.js. They are extracted here to keep
 * server.js responsible only for mounting routes, and to make this logic independently testable.
 *
 * @module routes/authMe
 */

import express from 'express'
import rateLimit from 'express-rate-limit'
import { ensureProfileEmailSchema } from '../utils/accessControl.js'
import { ensureAuth, ensureAdmin } from '../middleware/auth.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:authMe')

// Attach avatar_download_url so the post-login UI (profile selector / cards /
// header) can render the avatar. Without this, /api/auth/me returned profiles
// with no avatar at all, so the picture "disappeared" after every login even
// though it was stored. Mirrors mapProfile in routes/profiles.js: a file-backed
// avatar is served via the stable DB-backed download endpoint.
function withAvatarDownloadUrl(p) {
  if (!p || typeof p !== 'object') return p
  const rawAvatar = p.avatar_url ?? null
  const avatar_download_url = rawAvatar && String(rawAvatar).includes('/uploads/')
    ? `/api/profiles/${String(p.id)}/avatar/download`
    : null
  return { ...p, avatar_url: rawAvatar, avatar_download_url }
}

// ---------------------------------------------------------------------------
// Rate limiter: 100 requests per 5 minutes per IP
// ---------------------------------------------------------------------------
const authMeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
})

/**
 * Create and return the auth-me/diagnostics Express router.
 *
 * @param {object} deps
 * @param {object} deps.db          - better-sqlite3 (or compatible) database handle
 * @param {string} deps.adminName   - Configured admin display name (ADMIN_NAME)
 * @param {string} deps.adminEmail  - Configured admin email (ADMIN_EMAIL)
 * @returns {express.Router}
 */
export function createAuthMeRouter({ db, adminName, adminEmail }) {
  const router = express.Router()

  // -------------------------------------------------------------------------
  // GET /api/auth/me
  // -------------------------------------------------------------------------
  router.get('/me', authMeLimiter, async (req, res) => {
    try {
      const user = req.user ?? { role: 'guest' }
      if (user.role === 'guest') {
        return res.status(401).json({ error: 'unauthorized' })
      }

      if (user.userId) {
        let dbUser, profiles

        try {
          dbUser = await db
            .prepare(
              `
                SELECT *
                FROM users
                WHERE id = ?
              `,
            )
            .get(user.userId)
        } catch (dbError) {
          routeLogger.error('[/api/auth/me] Database error fetching user:', dbError)
          return res.status(503).json({
            error: 'service_unavailable',
            error_type: 'database_error',
            message: 'Auth service temporarily unavailable. Please retry shortly.',
          })
        }

        if (!dbUser) {
          // Dev/admin token convenience: ADMIN_TOKEN can authenticate an admin user without a stored user record.
          // Create the user record on-demand so the frontend auth bootstrap (`/api/auth/me`) is not brittle.
          if (user.role === 'admin' || user.is_admin === true) {
            try {
              await db.prepare(
                `
                  INSERT INTO users (id, display_name, primary_email, is_admin)
                  VALUES (?, ?, ?, ?)
                `,
              ).run(
                user.userId,
                user.full_name || adminName || 'Admin User',
                user.email || adminEmail || null,
                true,
              )

              dbUser = await db
                .prepare(
                  `
                    SELECT *
                    FROM users
                    WHERE id = ?
                  `,
                )
                .get(user.userId)
            } catch (repairError) {
              routeLogger.error(
                '[/api/auth/me] Unable to self-heal missing admin user:',
                {
                  message: repairError?.message || String(repairError),
                  userId: user.userId,
                  role: user.role,
                },
              )
            }
          }

          if (!dbUser) {
            return res.status(401).json({ error: 'unauthorized' })
          }
        }

        // Canonical admin resolution: prefer req.ctx.isAdmin (DB-backed, self-heals
        // configured-admin-email users). Fall back to dbUser/token flags only if
        // requestContext middleware didn't run or couldn't resolve.
        // Hoisted out of the try block so the response can mirror the same answer.
        const isAdminUser =
          req.ctx?.isAdmin === true ||
          Boolean(dbUser?.is_admin) ||
          user.role === 'admin' ||
          user.is_admin === true

        try {
          if (isAdminUser) {
            // Admin UX expects cross-org profile selection.
            // Return a large (but bounded) list to avoid "missing profiles" in the UI.
            profiles = await db
              .prepare(
                `
                  SELECT id, display_name, organization_id, status, avatar_url
                  FROM profiles
                  WHERE status IS NULL OR status <> 'deleted'
                  ORDER BY created_at DESC
                  LIMIT 1000
                `,
              )
              .all()

            // Lightweight, actionable logging for the "missing profiles" failure mode.
            if (Array.isArray(profiles) && profiles.length === 0) {
              console.warn('[/api/auth/me] Admin profile list is empty (expected baseline profiles)', {
                user_id: dbUser?.id ?? null,
              })
            }
          } else {
            const emails = Array.from(
              new Set(
                [dbUser?.primary_email, user?.email]
                  .map((v) => String(v || '').trim().toLowerCase())
                  .filter(Boolean),
              ),
            )

            // Ensure schema exists (idempotent). If it fails, fall back to user_id only.
            try {
              await ensureProfileEmailSchema(db)
            } catch (schemaErr) {
              console.warn('[/api/auth/me] ensureProfileEmailSchema failed â falling back to user_id-only profile query', {
                error: schemaErr?.message || String(schemaErr),
                user_id: dbUser?.id ?? null,
              })
            }

            if (emails.length > 0) {
              const placeholders = emails.map(() => '?').join(', ')
              profiles = await db
                .prepare(
                  `
                    SELECT DISTINCT p.id, p.display_name, p.organization_id, p.status, p.avatar_url
                    FROM profiles p
                    LEFT JOIN profile_emails pe ON pe.profile_id = p.id
                    WHERE (p.user_id = ?
                       OR lower(pe.email) IN (${placeholders}))
                      AND (p.status IS NULL OR p.status <> 'deleted')
                    ORDER BY p.id ASC
                  `,
                )
                .all(dbUser.id, ...emails)
            } else {
              profiles = await db
                .prepare(
                  `
                    SELECT id, display_name, organization_id, status, avatar_url
                    FROM profiles
                    WHERE user_id = ?
                      AND (status IS NULL OR status <> 'deleted')
                    ORDER BY id ASC
                  `,
                )
                .all(dbUser.id)
            }
          }
        } catch (dbError) {
          routeLogger.error('[/api/auth/me] Database error fetching profiles:', dbError)
          // Return user data without profiles if profiles query fails (avoid 5xx for auth bootstrap).
          profiles = []
        }

        // Do not "bleed" into an arbitrary profile_id from the token; only use it if it's in the accessible list.
        const profileIds = new Set((profiles || []).map((p) => p?.id).filter(Boolean))
        const safeActiveProfileId =
          user.profileId && profileIds.has(user.profileId) ? user.profileId : profiles?.[0]?.id ?? null

        return res.json({
          user: {
            id: dbUser.id,
            display_name: dbUser.display_name,
            primary_email: dbUser.primary_email,
            primary_phone: dbUser.primary_phone,
            avatar_url: dbUser.avatar_url,
            // Mirror the canonical resolution used above so the client never sees
            // a stale is_admin that contradicts req.ctx (e.g. after a role promotion).
            is_admin: isAdminUser,
          },
          profiles: (Array.isArray(profiles) ? profiles : []).map(withAvatarDownloadUrl),
          active_profile_id: safeActiveProfileId,
        })
      }

      if (user.role === 'admin') {
        console.warn('[/api/auth/me] Admin token has no userId â returning profile-less response', {
          email: user.email ?? null,
        })
        return res.json({
          role: 'admin',
          full_name: user.full_name ?? adminName,
          email: user.email ?? adminEmail,
          profiles: [],
          active_profile_id: null,
        })
      }

      console.warn('[/api/auth/me] Non-admin token has no userId â returning profile-less response', {
        role: user.role ?? null,
        profileId: user.profileId ?? null,
      })
      return res.json({
        role: 'user',
        profile_id: user.profileId ?? null,
        full_name: user.profileName ?? 'Profile User',
        profiles: [],
        active_profile_id: user.profileId ?? null,
      })
    } catch (error) {
      routeLogger.error('[/api/auth/me] Unexpected error:', error)
      return res.status(503).json({
        error: 'service_unavailable',
        error_type: 'internal_error',
        message: 'Auth service temporarily unavailable. Please retry shortly.',
      })
    }
  })

  // -------------------------------------------------------------------------
  // GET /api/auth/diagnostics
  // -------------------------------------------------------------------------
  router.get('/diagnostics', ensureAuth, ensureAdmin, async (_req, res) => {
    const diagnostics = {
      status: 'operational',
      timestamp: new Date().toISOString(),
      auth: {
        jwtSecret:
          process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET ? 'configured' : 'not configured',
        routes: 'registered',
        database: 'unknown',
        adminTokenConfigured: Boolean(process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN),
        bulkKeyConfigured: Boolean(process.env.BULK_POPULATE_KEY),
      },
      providers: {},
    }

    // Check database connection
    try {
      if (db.healthcheck) {
        const hc = await db.healthcheck()
        if (!hc?.ok) throw new Error(hc?.error || 'Database healthcheck failed')
      } else {
        await db.prepare('SELECT COUNT(*) as count FROM users').get()
      }
      diagnostics.auth.database = 'connected'
    } catch (error) {
      diagnostics.auth.database = 'error: ' + error.message
      diagnostics.status = 'degraded'
    }

    // Check OAuth provider configurations
    const providers = ['google', 'facebook', 'yahoo']
    providers.forEach((provider) => {
      const upper = provider.toUpperCase()
      const hasClientId = Boolean(
        process.env[`AUTH_${upper}_CLIENT_ID`] ||
          process.env[`${upper}_CLIENT_ID`] ||
          process.env[`OAUTH_${upper}_CLIENT_ID`],
      )
      const hasClientSecret = Boolean(
        process.env[`AUTH_${upper}_CLIENT_SECRET`] ||
          process.env[`${upper}_CLIENT_SECRET`] ||
          process.env[`OAUTH_${upper}_CLIENT_SECRET`],
      )
      diagnostics.providers[provider] = {
        configured: hasClientId && hasClientSecret,
        clientId: hasClientId ? 'present' : 'missing',
        clientSecret: hasClientSecret ? 'present' : 'missing',
      }
    })

    const statusCode = diagnostics.status === 'operational' ? 200 : 503
    res.status(statusCode).json(diagnostics)
  })

  return router
}
