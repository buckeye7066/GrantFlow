/**
 * sam.js — /api/sam/*
 *
 * HTTP surface for Sam, GrantFlow's production-readiness agent.
 *
 * Auth:
 *   - GET /api/sam/health is PUBLIC and returns only { ok, agent, status }.
 *   - Every other route is admin-only (req.ctx.isAdmin === true).
 *   - Write-capable / fix-applying routes additionally require
 *     SAM_ALLOW_SAFE_REPAIR=true on the server.
 *
 * Design:
 *   - GET /status is fast (no work; just reads cached run state).
 *   - POST /run is the canonical orchestrator — accepts mode, checks, etc.
 *   - POST /diagnose is a thin wrapper for `mode: observe`.
 *   - POST /plan-repair is a thin wrapper for `mode: advise`.
 *   - POST /apply-safe-fixes is the only mutating endpoint; mode forced to
 *     repair-safe; rejects unless admin + SAM_ALLOW_SAFE_REPAIR=true.
 *   - POST /run-gates runs the production-gate set (mode: gatekeeper).
 *   - GET /runs / GET /runs/:runId expose persisted run history.
 */

import { Router } from 'express'
import {
  getRun,
  getSamStatus,
  latestRun,
  listRuns,
  runSam,
} from '../services/sam/samAgent.js'
import {
  DEFAULT_MODE,
  SAM_MODES,
  isValidMode,
} from '../services/sam/samTypes.js'

const router = Router()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isAdmin(req) {
  return req.ctx?.isAdmin === true
}

function adminOnly(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(403).json({ ok: false, error: 'Sam: admin required' })
  }
  return next()
}

function readEnvBool(name, fallback = false) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || raw === '') return fallback
  return /^(1|true|yes|on)$/i.test(String(raw).trim())
}

// ---------------------------------------------------------------------------
// Public health (safe minimum)
// ---------------------------------------------------------------------------
router.get('/health', async (req, res) => {
  const enabled = readEnvBool('SAM_ENABLED', false)
  let lastStatus = null
  try {
    const last = req.db ? await latestRun(req.db) : null
    lastStatus = last?.status || null
  } catch { /* ignore */ }
  return res.json({
    ok: true,
    agent: 'Sam',
    purpose: 'production_readiness',
    enabled,
    status: lastStatus,
  })
})

// ---------------------------------------------------------------------------
// Admin status (cached, fast)
// ---------------------------------------------------------------------------
router.get('/status', adminOnly, async (req, res) => {
  try {
    const status = await getSamStatus({ db: req.db })
    return res.json({ ok: true, status })
  } catch (err) {
    console.error('[sam] /status failed:', err)
    return res.status(500).json({ ok: false, error: 'sam status failed' })
  }
})

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------
router.get('/runs', adminOnly, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25))
    const runs = await listRuns(req.db, { limit })
    return res.json({ ok: true, runs })
  } catch (err) {
    console.error('[sam] /runs failed:', err)
    return res.status(500).json({ ok: false, error: 'sam runs failed' })
  }
})

router.get('/runs/:runId', adminOnly, async (req, res) => {
  try {
    const run = await getRun(req.db, String(req.params.runId))
    if (!run) return res.status(404).json({ ok: false, error: 'run not found' })
    return res.json({ ok: true, run })
  } catch (err) {
    console.error('[sam] /runs/:runId failed:', err)
    return res.status(500).json({ ok: false, error: 'sam run lookup failed' })
  }
})

// ---------------------------------------------------------------------------
// Orchestration endpoints
// ---------------------------------------------------------------------------
function buildHttpProbe(req) {
  // In-process probe so /readyz checks still work when only the API is up.
  // We use the existing express app's request context via a fresh fetch
  // when available; otherwise return null and the diagnostic skips the
  // HTTP class of checks (those are nice-to-have).
  if (typeof fetch !== 'function') return null
  const host = req.headers['x-sam-internal-host'] ||
    `http://127.0.0.1:${process.env.PORT || 3911}`
  return async ({ method, path }) => {
    try {
      const resp = await fetch(`${host}${path}`, {
        method,
        headers: { 'x-sam-internal': 'true' },
      })
      let body
      try { body = await resp.json() } catch { body = await resp.text() }
      return { status: resp.status, body }
    } catch (err) {
      return { status: 0, body: String(err?.message || err) }
    }
  }
}

router.post('/run', adminOnly, async (req, res) => {
  try {
    const body = req.body ?? {}
    const mode = isValidMode(body.mode) ? String(body.mode).toLowerCase() : DEFAULT_MODE
    const dryRun = body.dryRun !== false
    const checkIds = Array.isArray(body.checks) ? body.checks : null

    // Refuse repair-safe unless explicitly enabled by env AND admin.
    if (mode === SAM_MODES.REPAIR_SAFE && !readEnvBool('SAM_ALLOW_SAFE_REPAIR', false)) {
      return res.status(400).json({
        ok: false,
        error: 'Sam refuses repair-safe: set SAM_ALLOW_SAFE_REPAIR=true on the server.',
      })
    }

    const result = await runSam({
      db: req.db,
      ctx: req.ctx,
      mode,
      trigger: 'admin-ui',
      checkIds,
      fixIds: Array.isArray(body.fixIds) ? body.fixIds : [],
      dryRun,
      maxFixes: Number.isFinite(body.maxFixes) ? body.maxFixes : 10,
      httpProbe: buildHttpProbe(req),
    })
    return res.json(result)
  } catch (err) {
    console.error('[sam] /run failed:', err)
    return res.status(500).json({ ok: false, error: 'sam run failed' })
  }
})

router.post('/diagnose', adminOnly, async (req, res) => {
  try {
    const result = await runSam({
      db: req.db,
      ctx: req.ctx,
      mode: SAM_MODES.OBSERVE,
      trigger: 'admin-ui',
      checkIds: Array.isArray(req.body?.checks) ? req.body.checks : null,
      dryRun: true,
      httpProbe: buildHttpProbe(req),
    })
    return res.json(result)
  } catch (err) {
    console.error('[sam] /diagnose failed:', err)
    return res.status(500).json({ ok: false, error: 'sam diagnose failed' })
  }
})

router.post('/plan-repair', adminOnly, async (req, res) => {
  try {
    const result = await runSam({
      db: req.db,
      ctx: req.ctx,
      mode: SAM_MODES.ADVISE,
      trigger: 'admin-ui',
      checkIds: Array.isArray(req.body?.checks) ? req.body.checks : null,
      dryRun: true,
      httpProbe: buildHttpProbe(req),
    })
    return res.json(result)
  } catch (err) {
    console.error('[sam] /plan-repair failed:', err)
    return res.status(500).json({ ok: false, error: 'sam plan-repair failed' })
  }
})

router.post('/apply-safe-fixes', adminOnly, async (req, res) => {
  if (!readEnvBool('SAM_ALLOW_SAFE_REPAIR', false)) {
    return res.status(400).json({
      ok: false,
      error: 'Sam refuses to apply fixes: set SAM_ALLOW_SAFE_REPAIR=true on the server.',
    })
  }
  try {
    const fixIds = Array.isArray(req.body?.fixIds) ? req.body.fixIds : []
    const result = await runSam({
      db: req.db,
      ctx: { ...req.ctx, samAuthorised: true },
      mode: SAM_MODES.REPAIR_SAFE,
      trigger: 'admin-ui',
      checkIds: Array.isArray(req.body?.checks) ? req.body.checks : null,
      fixIds,
      dryRun: false,
      maxFixes: Number.isFinite(req.body?.maxFixes) ? req.body.maxFixes : 10,
      httpProbe: buildHttpProbe(req),
    })
    return res.json(result)
  } catch (err) {
    console.error('[sam] /apply-safe-fixes failed:', err)
    return res.status(500).json({ ok: false, error: 'sam apply-safe-fixes failed' })
  }
})

router.post('/run-gates', adminOnly, async (req, res) => {
  try {
    const result = await runSam({
      db: req.db,
      ctx: req.ctx,
      mode: SAM_MODES.GATEKEEPER,
      trigger: 'admin-ui',
      dryRun: true,
      httpProbe: buildHttpProbe(req),
    })
    return res.json(result)
  } catch (err) {
    console.error('[sam] /run-gates failed:', err)
    return res.status(500).json({ ok: false, error: 'sam run-gates failed' })
  }
})

export default router
