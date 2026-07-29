import express from 'express'
import {
  buildProductionAuditSnapshot,
  normalizeAuditProfileIds,
  normalizeAuditMatchLimit,
} from '../services/productionAuditSnapshot.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('route:admin-production-audit')
const router = express.Router()

function adminOnly(req, res, next) {
  if (req.ctx?.isAdmin === true) return next()
  return res.status(403).json({ ok: false, error: 'admin_required' })
}

router.use(adminOnly)

/**
 * GET /api/admin/production-audit/snapshot?profiles=id1,id2&match_limit=500
 *
 * A bounded, sanitized, SELECT-only bridge for production verification when the
 * protected GitHub audit runner is unavailable. It deliberately exposes no
 * profile sections, contact fields, credentials, sessions, ciphertext, tokens,
 * raw portal state, or application narratives. Production Postgres executes the
 * snapshot inside one READ ONLY transaction.
 */
router.get('/snapshot', async (req, res) => {
  try {
    const rawProfiles = Array.isArray(req.query?.profile)
      ? req.query.profile
      : (req.query?.profiles ?? req.query?.profile ?? '')
    const profileIds = normalizeAuditProfileIds(rawProfiles)
    const matchLimitPerProfile = normalizeAuditMatchLimit(
      req.query?.match_limit ?? req.query?.matchLimit,
    )
    const snapshot = await buildProductionAuditSnapshot(req.db, {
      profileIds,
      matchLimitPerProfile,
    })
    res.set('Cache-Control', 'no-store')
    return res.json(snapshot)
  } catch (error) {
    const status = Number(error?.status) || 500
    const code = error?.code || 'PRODUCTION_AUDIT_SNAPSHOT_FAILED'
    log.warn('snapshot_failed', {
      code,
      status,
      message: error?.message || String(error),
      request_id: req.requestId || null,
    })
    return res.status(status).json({
      ok: false,
      error: code,
      details_redacted: true,
      request_id: req.requestId || null,
    })
  }
})

export default router
