/**
 * Request Context Middleware
 * 
 * Canonical source of truth for identity and authority.
 * This middleware MUST run early in the pipeline, after auth token parsing.
 * 
 * Produces req.ctx with:
 * - userId: stable user ID
 * - email: primary email
 * - isAdmin: DB-backed admin status (NOT token-only)
 * - activeProfileId: current profile context
 * - accessibleProfileIds: Set of profile IDs user can access
 * - accessibleOrgIds: Set of org IDs user can access
 */

import { 
  getAuthUserId, 
  getAuthProfileId,
  getAccessibleProfileIds,
  getAccessibleOrganizationIds,
} from '../utils/accessControl.js'
import { isAdminEmail } from '../config/constants.js'

/**
 * Build canonical request context from authenticated user.
 * This is the ONLY place where admin status should be resolved.
 * All other code must use req.ctx.isAdmin.
 * 
 * @param {object} db - Database connection
 * @param {object} user - User object from req.user (after auth middleware)
 * @returns {Promise<object>} Request context
 */
export async function buildRequestContext(db, user) {
  const ctx = {
    userId: null,
    email: null,
    isAdmin: false,
    activeProfileId: null,
    accessibleProfileIds: null, // null = all (for admin), Set = specific IDs
    accessibleOrgIds: null, // null = all (for admin), Set = specific IDs
  }

  // Guest user - return empty context
  if (!user || user.role === 'guest') {
    return ctx
  }

  // Extract user ID
  ctx.userId = getAuthUserId(user)
  ctx.email = user.email || user.primary_email || null
  ctx.activeProfileId = getAuthProfileId(user)

  // CRITICAL: Admin status is DB-backed ONLY (users.is_admin).
  // Never trust token claims for admin authority.
  try {
    // IMPORTANT:
    // `ctx.email` may not be present on the JWT (older tokens / some oauth flows).
    // We recompute "configured admin email" AFTER we potentially hydrate ctx.email from the DB.
    let emailIsConfiguredAdmin = Boolean(ctx.email && isAdminEmail(ctx.email))

    // If we only have a profileId, resolve its owning user first.
    if (!ctx.userId && ctx.activeProfileId) {
      const profileRow = await db
        .prepare('SELECT user_id FROM profiles WHERE id = ?')
        .get(ctx.activeProfileId)
      if (profileRow?.user_id) ctx.userId = profileRow.user_id
    }

    if (ctx.userId) {
      const row = await db
        .prepare('SELECT is_admin, primary_email FROM users WHERE id = ?')
        .get(ctx.userId)
      if (row) {
        ctx.isAdmin = Boolean(row.is_admin === true || row.is_admin === 1)
        if (row.primary_email && !ctx.email) ctx.email = row.primary_email
        emailIsConfiguredAdmin = Boolean(ctx.email && isAdminEmail(ctx.email))

        // If this request belongs to a configured admin email but the DB flag wasn't set yet,
        // upgrade it (best-effort) so future requests are consistent.
        if (!ctx.isAdmin && emailIsConfiguredAdmin) {
          ctx.isAdmin = true
          try {
            await db
              .prepare('UPDATE users SET is_admin = TRUE WHERE id = ? AND COALESCE(is_admin, FALSE) = FALSE')
              .run(ctx.userId)
          } catch (error) {
            console.warn('[requestContext] Failed to persist is_admin upgrade:', error?.message)
          }
        }
      } else {
        ctx.isAdmin = Boolean(emailIsConfiguredAdmin)
      }
    } else {
      ctx.isAdmin = Boolean(emailIsConfiguredAdmin)
    }
  } catch (error) {
    console.warn('[requestContext] Failed to resolve admin status from DB:', error?.message)
    ctx.isAdmin = false
  }

  // Step 5: Compute accessible profiles and orgs
  if (ctx.isAdmin) {
    // Admin can access everything
    ctx.accessibleProfileIds = null
    ctx.accessibleOrgIds = null
  } else {
    // Regular user - compute accessible resources
    try {
      ctx.accessibleProfileIds = await getAccessibleProfileIds(db, user)
      ctx.accessibleOrgIds = await getAccessibleOrganizationIds(db, user)
    } catch (error) {
      console.warn('[requestContext] Failed to compute accessible resources:', error?.message)
      ctx.accessibleProfileIds = new Set()
      ctx.accessibleOrgIds = new Set()
    }
  }

  return ctx
}

/**
 * Express middleware to attach request context to req.ctx
 */
export function attachRequestContext() {
  return async (req, res, next) => {
    try {
      req.ctx = await buildRequestContext(req.db, req.user)
      // Attach db reference to ctx for convenience (single accessor pattern)
      req.ctx.db = req.db
      next()
    } catch (error) {
      console.error('[requestContext] Failed to build request context:', error)
      // Fail safe: provide guest context to avoid breaking the request
      req.ctx = {
        userId: null,
        email: null,
        isAdmin: false,
        activeProfileId: null,
        accessibleProfileIds: new Set(),
        accessibleOrgIds: new Set(),
        db: req.db, // Ensure db is always available
      }
      next()
    }
  }
}
