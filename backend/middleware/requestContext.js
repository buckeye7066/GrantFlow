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

  // CRITICAL: Admin status MUST be resolved via DB, not token claims alone
  // This is the canonical source of truth for admin privileges
  let isAdminResolved = false

  // Step 1: Check if token already claims admin
  if (user.role === 'admin' || user.is_admin === true || user.is_admin === 1) {
    // Fast path: token claims admin, but we still verify against DB when possible
    isAdminResolved = true
  }

  // Step 2: If we have a userId, verify admin status in DB
  if (ctx.userId) {
    try {
      const row = await db
        .prepare('SELECT is_admin, primary_email FROM users WHERE id = ?')
        .get(ctx.userId)
      
      if (row) {
        // DB is the source of truth
        ctx.isAdmin = Boolean(row.is_admin === true || row.is_admin === 1)
        if (row.primary_email && !ctx.email) {
          ctx.email = row.primary_email
        }
        isAdminResolved = true
      }
    } catch (error) {
      console.warn('[requestContext] Failed to resolve admin status from DB:', error?.message)
    }
  }

  // Step 3: If no userId but we have profileId, resolve via profile -> user
  if (!isAdminResolved && ctx.activeProfileId) {
    try {
      const profileRow = await db
        .prepare('SELECT user_id FROM profiles WHERE id = ?')
        .get(ctx.activeProfileId)
      
      if (profileRow?.user_id) {
        const userRow = await db
          .prepare('SELECT is_admin, primary_email FROM users WHERE id = ?')
          .get(profileRow.user_id)
        
        if (userRow) {
          ctx.userId = profileRow.user_id
          ctx.isAdmin = Boolean(userRow.is_admin === true || userRow.is_admin === 1)
          if (userRow.primary_email && !ctx.email) {
            ctx.email = userRow.primary_email
          }
          isAdminResolved = true
        }
      }
    } catch (error) {
      console.warn('[requestContext] Failed to resolve user from profile:', error?.message)
    }
  }

  // Step 4: If still not resolved, fall back to token claim (for backward compatibility)
  // This handles cases like admin tokens without userId
  if (!isAdminResolved) {
    ctx.isAdmin = Boolean(user.role === 'admin' || user.is_admin === true || user.is_admin === 1)
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
