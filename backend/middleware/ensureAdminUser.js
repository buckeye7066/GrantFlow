/**
 * Ensure Admin User Middleware
 *
 * Ensures that synthetic admin-token users (e.g. system_admin_token, system_anya_token)
 * exist as rows in the users table so that foreign-key constraints don't break on
 * fresh databases or after a database reset.
 *
 * This middleware is best-effort: if the INSERT fails (e.g. the users table is temporarily
 * unavailable), the request continues normally rather than returning an error.
 *
 * Usage:
 *   import { createEnsureAdminUserMiddleware } from './middleware/ensureAdminUser.js'
 *   app.use(createEnsureAdminUserMiddleware({ db, adminName, adminEmail }))
 *
 * @module middleware/ensureAdminUser
 */

/**
 * Factory that returns an Express middleware which ensures synthetic admin users exist in the DB.
 *
 * @param {object} config
 * @param {object} config.db         - better-sqlite3 (or compatible) database handle
 * @param {string} config.adminName  - Fallback display name for synthetic admin rows
 * @param {string} config.adminEmail - Fallback email for synthetic admin rows
 * @returns {import('express').RequestHandler}
 */
export function createEnsureAdminUserMiddleware({ db, adminName, adminEmail }) {
  return async function ensureAdminUserMiddleware(req, _res, next) {
    const user = req.user
    if (!user || user.role !== 'admin' || !user.userId) return next()

    try {
      const existing = await db
        .prepare(
          `
            SELECT id
            FROM users
            WHERE id = ?
            LIMIT 1
          `,
        )
        .get(user.userId)

      if (!existing?.id) {
        await db
          .prepare(
            `
              INSERT INTO users (id, display_name, primary_email, is_admin)
              VALUES (?, ?, ?, ?)
            `,
          )
          .run(
            user.userId,
            user.full_name || adminName || 'Admin User',
            user.email || adminEmail || null,
            true,
          )
      }
    } catch {
      // Best-effort only: do not block requests if the users table is unavailable.
    }

    return next()
  }
}
