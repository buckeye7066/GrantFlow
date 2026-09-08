/**
 * /api/admin/visitor-identity — who, in GrantFlow's own records, has used an
 * IP address. Consumed by the axiombiolabs.org visitor dashboard on the
 * owner's laptop (buckeye7066/axiombiolabs-site scripts/visitor-dashboard.mjs).
 *
 *   GET /api/admin/visitor-identity?ips=1.2.3.4,5.6.7.8   (admin token)
 *   → { ok, asked, identities: { "<ip>": { email, name, user_id, is_admin,
 *        sessions, first_seen, last_seen, others: [...], audit: [...] } } }
 *
 * Read-only. An IP with no sign-in and no audited action is simply absent —
 * the dashboard then says so honestly instead of implying a name exists.
 */

import express from 'express'
import { ensureAdmin } from '../middleware/auth.js'
import { standardRateLimiter } from '../middleware/rateLimiting.js'
import { lookupVisitorIdentity, listVisitorSignins, normalizeIps } from '../services/visitorIdentity.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('admin-visitor-identity')
const router = express.Router()

router.get('/', ensureAdmin, standardRateLimiter, async (req, res) => {
  const ips = normalizeIps(req.query?.ips ?? req.query?.ip ?? '')
  if (ips.length === 0) return res.status(400).json({ ok: false, error: 'ips query parameter required (comma-separated)' })
  try {
    const identities = await lookupVisitorIdentity(req.db, ips)
    res.set('Cache-Control', 'no-store')
    return res.json({ ok: true, asked: ips.length, matched: Object.keys(identities).length, identities })
  } catch (error) {
    log.warn('visitor identity lookup failed', { error: error?.message || String(error) })
    return res.status(500).json({ ok: false, error: 'lookup failed' })
  }
})

/**
 * GET /api/admin/visitor-identity/signins?hours=24   (admin token)
 * → { ok, since, hours, count, signins: [{ at, ip, email, name, is_admin,
 *      profile_id, profile_name, user_agent }] }   newest first
 */
router.get('/signins', ensureAdmin, standardRateLimiter, async (req, res) => {
  const hours = Math.max(1, Math.min(24 * 30, Number(req.query?.hours) || 24))
  const since = new Date(Date.now() - hours * 3600 * 1000)
  try {
    const signins = await listVisitorSignins(req.db, { since, limit: Number(req.query?.limit) || 500 })
    res.set('Cache-Control', 'no-store')
    return res.json({ ok: true, since: since.toISOString(), hours, count: signins.length, signins })
  } catch (error) {
    log.warn('visitor signins lookup failed', { error: error?.message || String(error) })
    return res.status(500).json({ ok: false, error: 'lookup failed' })
  }
})

export default router
