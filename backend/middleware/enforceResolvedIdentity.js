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

    // Only act when an UNRESOLVED caller id is actually present (guests already
    // have none). Null it everywhere so no user-scoped route can authorize on it.
    if (ctx.userId) {
      ctx.userId = null
      if (!(ctx.accessibleProfileIds instanceof Set)) ctx.accessibleProfileIds = new Set()
      if (!(ctx.accessibleOrgIds instanceof Set)) ctx.accessibleOrgIds = new Set()
      if (req.user && typeof req.user === 'object') {
        req.user = { ...req.user, userId: null, id: null, user_id: null }
      }
    }
    next()
  }
}
