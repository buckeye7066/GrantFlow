import express from 'express'
import { AUDIT_CATEGORIES, SEVERITY, logAuditEvent } from '../services/auditService.js'
import { requireAuthenticatedUserMiddleware } from '../utils/accessControl.js'
import { standardRateLimiter } from '../middleware/rateLimiting.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:activity')

const router = express.Router()

router.use(standardRateLimiter, requireAuthenticatedUserMiddleware)

function isAuthenticatedFromCtx(ctx) {
  return Boolean(ctx && (ctx.userId || ctx.activeProfileId || ctx.email))
}

// Track in-flight background writes so tests can deterministically await them.
// In production these are pure fire-and-forget — the client never waits.
const pendingWrites = new Set()
function trackWrite(promise) {
  pendingWrites.add(promise)
  promise.finally(() => pendingWrites.delete(promise))
  return promise
}
export async function __flushActivityWrites() {
  await Promise.allSettled([...pendingWrites])
}

function safeString(value, maxLen) {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  if (!s) return null
  return s.length > maxLen ? s.slice(0, maxLen) : s
}

/**
 * POST /api/activity/page-view
 * Record a client page view for admin analytics.
 *
 * Body: { path: string, title?: string, referrer?: string }
 */
router.post('/page-view', (req, res) => {
  // Page-view tracking is best-effort analytics. It must NEVER block the client
  // or surface a 5xx: a slow/awaited audit write (the DDL-on-every-call + INSERT)
  // behind the Vercel->Railway proxy was timing out as a 503 on every navigation.
  // We validate cheaply, ACK 204 immediately, then persist in the BACKGROUND.
  if (!isAuthenticatedFromCtx(req.ctx)) {
    return res.status(401).json({ ok: false, error: 'Authentication required' })
  }

  const path = safeString(req.body?.path, 2048)
  if (!path) {
    return res.status(400).json({ ok: false, error: 'path is required' })
  }

  const event = {
    category: AUDIT_CATEGORIES.USER_ACTIVITY,
    action: 'client_page_view',
    severity: SEVERITY.INFO,
    userId: req.ctx?.userId ?? null,
    profileId: req.ctx?.activeProfileId ?? null,
    resourceType: 'page_view',
    resourceId: null,
    details: {
      path,
      title: safeString(req.body?.title, 256),
      referrer: safeString(req.body?.referrer, 2048),
    },
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  }
  const db = req.db

  // Acknowledge first — the client never waits on (or fails because of) the write.
  res.status(204).send()

  // Fire-and-forget. logAuditEvent already swallows its own errors and returns
  // null, but we still guard the promise so an unexpected rejection can never
  // become an unhandledRejection.
  trackWrite(
    Promise.resolve()
      .then(() => logAuditEvent(db, event))
      .catch((error) => routeLogger.warn('page-view tracking error (ignored):', error?.message || error)),
  )
})

export default router

