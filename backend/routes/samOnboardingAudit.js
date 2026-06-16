/**
 * Sam onboarding audit — admin-only API.
 *
 * Routes:
 *   GET   /status                              quick health for Mission Control
 *   POST  /run                                 trigger a fresh audit
 *   GET   /latest                              most recent run + its findings
 *   GET   /findings                            list findings (open by default)
 *   POST  /findings/:id/resolve                mark resolved
 *   POST  /findings/:id/ignore                 mark ignored
 *
 * All routes require admin. We use `withProfileScope({ bypass: true })`
 * inside the service layer for cross-tenant reads; admins authenticate
 * via the existing `requireAdmin` middleware.
 */

import express from 'express'
import { isAdminUser, requireAuthenticatedUser } from '../utils/accessControl.js'
import {
  runAudit,
  getLatestAudit,
  listFindings,
  resolveFinding,
  getStatus,
} from '../services/sam/samOnboardingConversationAuditor.js'
import { createLogger } from '../utils/logger.js'

const routeLogger = createLogger('route:sam-onboarding-audit')
const router = express.Router()

router.use((req, res, next) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  if (!isAdminUser(user)) {
    return res.status(403).json({ ok: false, error: 'admin_only' })
  }
  return next()
})

router.get('/status', async (req, res) => {
  try {
    const status = await getStatus(req.db)
    return res.status(200).json({ ok: true, ...status })
  } catch (err) {
    routeLogger.error('status_failed', { err: err?.message })
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

router.post('/run', async (req, res) => {
  try {
    const opts = {
      transcriptWindowDays: Number(req.body?.transcriptWindowDays) || 30,
      recentProfileIds: Array.isArray(req.body?.recentProfileIds) ? req.body.recentProfileIds.slice(0, 50) : [],
      persist: req.body?.persist !== false,
    }
    const result = await runAudit(req.db, opts)
    return res.status(200).json({ ok: true, ...result })
  } catch (err) {
    routeLogger.error('run_failed', { err: err?.message })
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

router.get('/latest', async (req, res) => {
  try {
    const result = await getLatestAudit(req.db)
    return res.status(200).json({ ok: true, ...result })
  } catch (err) {
    routeLogger.error('latest_failed', { err: err?.message })
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

router.get('/findings', async (req, res) => {
  try {
    const status = req.query.status || 'open'
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500)
    const result = await listFindings(req.db, { status, limit })
    return res.status(200).json({ ok: true, ...result })
  } catch (err) {
    routeLogger.error('findings_failed', { err: err?.message })
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

router.post('/findings/:id/resolve', async (req, res) => {
  try {
    const r = await resolveFinding(req.db, req.params.id, 'resolved')
    return res.status(r.ok ? 200 : 400).json({ ok: r.ok, ...r })
  } catch (err) {
    routeLogger.error('resolve_failed', { err: err?.message })
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

router.post('/findings/:id/ignore', async (req, res) => {
  try {
    const r = await resolveFinding(req.db, req.params.id, 'ignored')
    return res.status(r.ok ? 200 : 400).json({ ok: r.ok, ...r })
  } catch (err) {
    routeLogger.error('ignore_failed', { err: err?.message })
    return res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

export default router
