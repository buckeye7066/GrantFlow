/**
 * Admin-only Agent Mission Control telemetry API.
 *
 * Mounted at /api/admin/agent-telemetry. Every route requires both a valid
 * session (ensureAuth) and an admin role (ensureAdmin) — no exceptions, no
 * public surface. Errors degrade to JSON `{ ok: false, error }` so the
 * dashboard can render an empty state instead of crashing the page.
 */

import express from 'express'
import { ensureAuth, ensureAdmin } from '../middleware/auth.js'
import { withProfileScope } from '../middleware/profileContext.js'
import {
  getSummary,
  getTimeline,
  getYana,
  getRobert,
  getRobertMap,
  getSam,
  getAnya,
  getJohn,
  getHealth,
} from '../services/agentTelemetry/agentTelemetryService.js'
import { createLogger } from '../utils/logger.js'

const router = express.Router()
const log = createLogger('route:agent-telemetry')

router.use(ensureAuth)
router.use(ensureAdmin)

function pickRangeOpts(req) {
  return {
    range: req.query.range || '24h',
    start: req.query.start || undefined,
    end: req.query.end || undefined,
    agent: req.query.agent || undefined,
    status: req.query.status || undefined,
    severity: req.query.severity || undefined,
    profile_id: req.query.profile_id || undefined,
    state: req.query.state || undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  }
}

/**
 * Admin queries span tenants by definition. Wrap every handler in an
 * admin-bypass profile scope so reads of profile-scoped tables (e.g.
 * anya_sessions) don't trip the guard in backend/db/scopedQuery.js.
 */
function adminScoped(handler) {
  return (req, res) =>
    withProfileScope(
      { actorRole: 'admin_global', userId: req.user?.userId || null, route: req.originalUrl },
      () => handler(req, res),
    ).catch((err) => {
      log.error('agent-telemetry handler failed', { route: req.originalUrl, err: err?.message })
      res.status(200).json({ ok: false, error: 'telemetry_unavailable', detail: err?.message || 'unknown' })
    })
}

router.get(
  '/summary',
  adminScoped(async (req, res) => {
    const data = await getSummary(req.db, pickRangeOpts(req))
    res.json({ ok: true, ...data })
  }),
)

router.get(
  '/timeline',
  adminScoped(async (req, res) => {
    const data = await getTimeline(req.db, pickRangeOpts(req))
    res.json({ ok: true, ...data })
  }),
)

router.get(
  '/yana',
  adminScoped(async (req, res) => {
    const data = await getYana(req.db, pickRangeOpts(req))
    res.json({ ok: true, ...data })
  }),
)

router.get(
  '/robert',
  adminScoped(async (req, res) => {
    const data = await getRobert(req.db, pickRangeOpts(req))
    res.json({ ok: true, ...data })
  }),
)

router.get(
  '/robert/map',
  adminScoped(async (req, res) => {
    const data = await getRobertMap(req.db, pickRangeOpts(req))
    res.json({ ok: true, ...data })
  }),
)

router.get(
  '/sam',
  adminScoped(async (req, res) => {
    const data = await getSam(req.db, pickRangeOpts(req))
    res.json({ ok: true, ...data })
  }),
)

router.get(
  '/anya',
  adminScoped(async (req, res) => {
    const data = await getAnya(req.db, pickRangeOpts(req))
    res.json({ ok: true, ...data })
  }),
)

router.get(
  '/john',
  adminScoped(async (req, res) => {
    const data = await getJohn(req.db, pickRangeOpts(req))
    res.json({ ok: true, ...data })
  }),
)

router.get(
  '/health',
  adminScoped(async (req, res) => {
    const data = await getHealth(req.db)
    res.json({ ok: true, ...data })
  }),
)

export default router
