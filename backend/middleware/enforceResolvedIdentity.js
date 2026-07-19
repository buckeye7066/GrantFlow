/**
 * STRUCTURAL fail-closed identity gate (mounted after attachRequestContext,
 * before the user-scoped routers).
 *
 * The recurring vulnerability class: a JWT for a DELETED user (no users row) or a
 * synthetic-id COLLISION (a signed token whose sub is a reserved service id but
 * without service-token provenance) still carries a caller id (ctx.userId /
 * req.user.userId). Unaudited user-scoped routes then use that stale/reserved id
 * for ownership/scope (`WHERE user_id = ?`, `row.user_id === userId`, etc.).
 *
 * This middleware ENDS the class centrally: for any request whose identity did
 * NOT resolve to a trusted principal (real users row, or validated
 * service/legacy-token provenance) and is not an admin, it NULLS the caller id on
 * BOTH surfaces — ctx.userId AND req.user.userId/id/user_id — and keeps the
 * accessible sets empty. Every downstream ownership read then sees null (matches
 * nothing / triggers the route's own `if (!userId) 401`), so audited AND
 * unaudited routes fail closed without each needing its own gate.
 *
 * Trusted identities (real users, admins, validated service/health/legacy tokens)
 * and guests (no userId to begin with) are untouched.
 */

import { isSyntheticServiceAdmin } from './syntheticServiceTokens.js'

export function enforceResolvedIdentity() {
  return function enforceResolvedIdentityMiddleware(req, _res, next) {
    const ctx = req.ctx
    if (!ctx) return next()

    // The auth surface (/api/auth/*, incl. /auth/me) manages its own identity
    // resolution (it returns 401 for a stale token and sources is_admin from
    // ctx.isAdmin). Nulling req.user here would make /auth/me skip its dbUser
    // lookup and mis-answer, so leave the auth routes to their own gating.
    const path = String(req.path || req.originalUrl || '')
    if (path.startsWith('/api/auth')) return next()

    // Admins (incl. validated ADMIN_TOKEN / Anya / health tokens, which resolve
    // ctx.isAdmin=true) and any trusted identity (real users row / legacy-token
    // provenance) pass through unchanged.
    if (ctx.isAdmin === true || ctx.identityResolved === true) return next()

    // A validated synthetic service token that somehow isn't flagged admin is
    // still a trusted principal (provenance-bound).
    if (isSyntheticServiceAdmin(req.user)) return next()

    // Any identity surface present on an UNRESOLVED non-admin request is
    // untrusted. Nulling ONLY the userId is not enough: downstream helpers
    // (isAdminUserWithDb, getAccessibleProfileIds) can RE-RESOLVE identity/admin
    // from a surviving token profileId (profile_id -> owning user), token email
    // (email -> user), or role/is_admin claim. So we clear the ENTIRE surface and
    // reduce req.user to a GUEST, so NO downstream helper can rehydrate identity
    // or admin from ANY token field (id, profileId, email, role, is_admin, roles).
    const u = req.user
    const hasIdentitySurface =
      ctx.userId ||
      ctx.activeProfileId ||
      ctx.email ||
      (u &&
        typeof u === 'object' &&
        (u.userId || u.id || u.user_id || u.profileId || u.profile_id || u.email || u.primary_email))

    if (hasIdentitySurface) {
      // ctx: drop every identity field; empty (never null/all-access) sets.
      ctx.userId = null
      ctx.email = null
      ctx.activeProfileId = null
      ctx.accessibleProfileIds = new Set()
      ctx.accessibleOrgIds = new Set()
      // req.user: canonical guest shape — no id/profileId/email/role/is_admin/roles
      // survive for any helper (getAuthUserId/getAuthProfileId/collectUserEmails/
      // isAdminUserWithDb) to re-resolve from.
      req.user = { role: 'guest', profileId: null }
    }
    next()
  }
}
