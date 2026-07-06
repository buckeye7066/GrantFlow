/**
 * adminCrawlerDoctor.js — Admin-only, READ-ONLY per-profile crawler doctor.
 * Mounted at /api/admin/crawler-doctor.
 *
 * Answers the row-level questions the crawler-plan dashboard cannot:
 * which QUERY produced each match, why each result was included or excluded,
 * geography + eligibility reasoning, what amount extraction found, which
 * source fields are missing, and the query expansions the closed learning
 * loop will add next (see services/crawlerDoctorService.js).
 *
 * Contract:
 *   GET /api/admin/crawler-doctor/:profileId?limit=100
 */

import express from 'express'
import { createLogger } from '../utils/logger.js'
import { buildCrawlerDoctorReport } from '../services/crawlerDoctorService.js'

const routeLogger = createLogger('route:adminCrawlerDoctor')
const router = express.Router()

function requireAdmin(req, res) {
  if (req.ctx && req.ctx.isAdmin === true) return true
  res.status(403).json({ error: 'Admin access required' })
  return false
}

router.get('/:profileId', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const profileId = String(req.params.profileId || '').trim()
  if (!profileId) return res.status(400).json({ ok: false, error: 'profileId required' })
  const limit = Number(req.query.limit) || undefined
  try {
    const report = await buildCrawlerDoctorReport(req.db, profileId, { limit })
    if (report?.error === 'profile_not_found') {
      return res.status(404).json({ ok: false, error: 'profile_not_found', profile_id: profileId })
    }
    return res.json({ ok: true, ...report })
  } catch (err) {
    routeLogger.error('crawler doctor failed', { profileId, error: err?.message })
    return res.status(500).json({ ok: false, error: 'crawler_doctor_failed', detail: err?.message })
  }
})

export default router
