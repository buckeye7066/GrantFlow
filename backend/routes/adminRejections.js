/**
 * Admin Rejection Log Routes (admin only)
 * ---------------------------------------
 * GET /api/admin/rejections?limit=&since=  -> recent ingest rejections
 *
 * Surfaces the "why was this excluded?" feed written best-effort by
 * backend/services/provenanceAudit.js (recordRejection) from the ingest
 * gates in opportunityInserter + ingestionService. Read-only.
 *
 * Mounted under /api/admin which is already guarded by ensureAuth + ensureAdmin;
 * we self-guard too so the feature is admin-only regardless of mount order.
 */

import express from 'express'
import { ensureAuth, ensureAdmin } from '../middleware/auth.js'
import { createLogger } from '../utils/logger.js'

const routeLogger = createLogger('route:adminRejections')
const router = express.Router()

router.use(ensureAuth)
router.use(ensureAdmin)

const MAX_LIMIT = 500
const DEFAULT_LIMIT = 100

function parseRawMeta(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return value // postgres JSONB already parsed
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

router.get('/', async (req, res) => {
  const limitRaw = Number.parseInt(req.query.limit, 10)
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(limitRaw, MAX_LIMIT))
    : DEFAULT_LIMIT
  const since = typeof req.query.since === 'string' && req.query.since.trim()
    ? req.query.since.trim()
    : null

  try {
    let rows
    if (since) {
      rows = await req.db
        .prepare(
          `SELECT id, source, source_url, title, reason, stage, raw_meta, checked_at
           FROM rejection_log
           WHERE checked_at >= ?
           ORDER BY checked_at DESC, id DESC
           LIMIT ?`,
        )
        .all(since, limit)
    } else {
      rows = await req.db
        .prepare(
          `SELECT id, source, source_url, title, reason, stage, raw_meta, checked_at
           FROM rejection_log
           ORDER BY checked_at DESC, id DESC
           LIMIT ?`,
        )
        .all(limit)
    }

    const rejections = (Array.isArray(rows) ? rows : []).map((r) => ({
      ...r,
      raw_meta: parseRawMeta(r.raw_meta),
    }))

    return res.json({ ok: true, count: rejections.length, limit, since, rejections })
  } catch (error) {
    const msg = String(error?.message || error)
    // Table not yet created on this deployment — return an empty feed rather
    // than 500 so the admin UI degrades gracefully.
    if (msg.includes('no such table') || msg.includes('does not exist')) {
      return res.json({ ok: true, count: 0, limit, since, rejections: [] })
    }
    routeLogger.error('[admin/rejections] failed', msg)
    return res.status(500).json({ error: 'Failed to load rejection log' })
  }
})

export default router
