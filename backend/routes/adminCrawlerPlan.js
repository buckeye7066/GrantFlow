/**
 * adminCrawlerPlan.js — Admin-only, READ-ONLY "which crawlers fire for this
 * profile, and why" dashboard API. Mounted at /api/admin/crawler-plan.
 *
 * Surfaces the SAME deterministic decision discovery uses (buildThesis ->
 * plan), annotated with plain reasons + the high-precision keyword triggers
 * that pulled in extra sources (so a VFD's FEMA AFG is provably accounted
 * for). Never mutates anything.
 *
 * Contract:
 *   GET /api/admin/crawler-plan/:profileId
 *     -> explainCrawlerPlanForProfile(...) — selected/excluded sources with
 *        reasons, keyword_triggers, funder vs directory breakdown, coverage.
 *   GET /api/admin/crawler-plan?limit=200
 *     -> auditCrawlerCoverage(...) — scan active profiles; flag zero-coverage
 *        and org-directory-only profiles (mission-rule gaps).
 *
 * The single hard requirement is req.ctx.isAdmin === true.
 */

import express from 'express'
import { createLogger } from '../utils/logger.js'
import {
  explainCrawlerPlanForProfile,
  auditCrawlerCoverage,
} from '../services/crawlerPlanService.js'

const routeLogger = createLogger('route:adminCrawlerPlan')
const router = express.Router()

function requireAdmin(req, res) {
  if (req.ctx && req.ctx.isAdmin === true) return true
  res.status(403).json({ error: 'Admin access required' })
  return false
}

// Batch coverage audit across active profiles.
router.get('/', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200))
  try {
    const audit = await auditCrawlerCoverage(req.db, { limit })
    return res.json({ ok: true, ...audit })
  } catch (err) {
    routeLogger.error('coverage audit failed', { error: err?.message })
    return res.status(500).json({ ok: false, error: 'coverage_audit_failed', detail: err?.message })
  }
})

// Single-profile plan.
router.get('/:profileId', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const profileId = String(req.params.profileId || '').trim()
  if (!profileId) return res.status(400).json({ ok: false, error: 'profileId required' })
  try {
    const plan = await explainCrawlerPlanForProfile(req.db, profileId)
    if (plan?.error === 'profile_not_found') {
      return res.status(404).json({ ok: false, error: 'profile_not_found', profile_id: profileId })
    }
    return res.json({ ok: true, ...plan })
  } catch (err) {
    routeLogger.error('plan failed', { profileId, error: err?.message })
    return res.status(500).json({ ok: false, error: 'plan_failed', detail: err?.message })
  }
})

export default router
