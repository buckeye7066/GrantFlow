import express from 'express'
import { AUDIT_CATEGORIES, SEVERITY, logAuditEvent } from '../services/auditService.js'

const router = express.Router()

function isAuthenticatedFromCtx(ctx) {
  return Boolean(ctx && (ctx.userId || ctx.activeProfileId || ctx.email))
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
router.post('/page-view', async (req, res) => {
  try {
    if (!isAuthenticatedFromCtx(req.ctx)) {
      return res.status(401).json({ ok: false, error: 'Authentication required' })
    }

    const path = safeString(req.body?.path, 2048)
    if (!path) {
      return res.status(400).json({ ok: false, error: 'path is required' })
    }

    const title = safeString(req.body?.title, 256)
    const referrer = safeString(req.body?.referrer, 2048)

    logAuditEvent(req.db, {
      category: AUDIT_CATEGORIES.AUTH,
      action: 'client_page_view',
      severity: SEVERITY.INFO,
      userId: req.ctx?.userId ?? null,
      profileId: req.ctx?.activeProfileId ?? null,
      resourceType: 'page_view',
      resourceId: null,
      details: {
        path,
        title,
        referrer,
      },
      ipAddress: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    })

    return res.status(204).send()
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) })
  }
})

export default router

