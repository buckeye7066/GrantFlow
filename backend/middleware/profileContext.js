// backend/middleware/profileContext.js
//
// Wraps every HTTP request in an AsyncLocalStorage-backed profile context so
// the SQL layer (backend/db/scopedQuery.js) can enforce tenant isolation
// automatically. No route-level code changes are required: if req.user or
// req.query/profileId is present, the context is populated.
//
// Admin/service role requests (req.user?.role === 'admin_global' | 'service')
// are also stamped so the guard bypasses tenant checks only for those actors.

import { runProfileContext, getProfileContext } from '../db/scopedQuery.js'

function extractProfileId(req) {
  const fromCtx = req?.ctx?.activeProfileId
  if (fromCtx) return String(fromCtx).trim() || null
  const fromParams = req?.params?.profileId || req?.params?.profile_id || req?.params?.id
  if (fromParams) return String(fromParams).trim() || null
  const fromQuery = req?.query?.profileId || req?.query?.profile_id
  if (fromQuery) return String(fromQuery).trim() || null
  const fromHeader = req?.headers?.['x-profile-id']
  if (fromHeader) return String(fromHeader).trim() || null
  const fromUser = req?.user?.profileId || req?.user?.profile_id || req?.user?.activeProfileId
  if (fromUser) return String(fromUser).trim() || null
  const path = String(req?.originalUrl || req?.url || '')
  const fromPath =
    path.match(/\/api\/matching\/profile\/([^/?#]+)/i)?.[1] ||
    path.match(/\/api\/profiles\/([^/?#]+)/i)?.[1] ||
    path.match(/\/api\/profile\/([^/?#]+)/i)?.[1] ||
    null
  if (fromPath) return decodeURIComponent(fromPath).trim() || null
  return null
}

function extractRole(req) {
  if (req?.ctx?.isAdmin) return 'admin'
  if (req?.ctx?.role) return String(req.ctx.role).toLowerCase()
  const role = req?.user?.role || req?.user?.actorRole || req?.auth?.role || null
  return role ? String(role).toLowerCase() : null
}

export function profileContextMiddleware() {
  return (req, _res, next) => {
    const ctx = {
      profileId: extractProfileId(req),
      userId: req?.ctx?.userId || req?.user?.id || req?.user?.userId || null,
      actorRole: extractRole(req),
      route: `${req.method} ${req.originalUrl || req.url}`,
    }
    runProfileContext(ctx, () => next())
  }
}

/**
 * Programmatic helper for jobs/crons/boot-time code that needs to run a block
 * outside a request but still inside a defined scope (e.g. a daily cleanup).
 */
export function withProfileScope(ctx, fn) {
  return runProfileContext(ctx || { bypass: true }, fn)
}

export { getProfileContext }
