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
  const fromQuery = req?.query?.profileId || req?.query?.profile_id
  if (fromQuery) return String(fromQuery).trim() || null
  const fromBody = req?.body?.profileId || req?.body?.profile_id
  if (fromBody) return String(fromBody).trim() || null
  const fromHeader = req?.headers?.['x-profile-id']
  if (fromHeader) return String(fromHeader).trim() || null
  const fromUser = req?.user?.profileId || req?.user?.profile_id || req?.user?.activeProfileId
  if (fromUser) return String(fromUser).trim() || null
  return null
}

function extractRole(req) {
  const role = req?.user?.role || req?.user?.actorRole || req?.auth?.role || null
  return role ? String(role).toLowerCase() : null
}

export function profileContextMiddleware() {
  return (req, _res, next) => {
    const ctx = {
      profileId: extractProfileId(req),
      userId: req?.user?.id || req?.user?.userId || null,
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
