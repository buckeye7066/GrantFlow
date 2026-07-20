/**
 * adminAgentControl.js
 *
 * Admin-only Agent Control Center API. Mounted at
 * /api/admin/agent-control. Every route requires:
 *
 *   - a valid session (ensureAuth)
 *   - admin email exactly buckeye7066@gmail.com
 *     (or AGENT_CONTROL_ADMIN_EMAIL / ADMIN_EMAIL env override)
 *
 * Non-admin callers receive HTTP 403. Every successful control action
 * is persisted to agent_control_events so the admin always has an
 * audit trail of who started/stopped what.
 */

import express from 'express'
import { ensureAuth } from '../middleware/auth.js'
import { createLogger } from '../utils/logger.js'
import {
  ALL_AGENTS,
  RUN_TYPES,
  CANONICAL_ADMIN_EMAIL_DEFAULT,
} from '../services/agentControl/agentControlTypes.js'
import {
  cancelRun,
  emergencyStopRun,
  getAgentDirective,
  getAgentStatus,
  getCanonicalAdminEmail,
  getControlCenterStatus,
  isControlCenterAdmin,
  pauseRun,
  resumeRun,
  setAgentDirective,
  startAgent,
  startRun,
  stopAgent,
  stopRun,
} from '../services/agentControl/agentControlOrchestrator.js'
import {
  getAgentSetting,
  getRun,
  getRunHighlights,
  listEvents,
  listRuns,
  listSteps,
  recordEvent,
  setAgentSetting,
} from '../services/agentControl/agentControlStore.js'
import {
  getAutonomousConfig,
  setAutonomousEnabled,
} from '../services/anyaAutonomousScheduler.js'
import {
  getConfig as getAdversarialRepairConfig,
  setConfig as setAdversarialRepairConfig,
  validateConfigPatch as validateAdversarialRepairPatch,
  computeReadiness as computeAdversarialRepairReadiness,
} from '../services/adversarialRepairSettings.js'
import { logAuditEvent, AUDIT_CATEGORIES, SEVERITY } from '../services/auditService.js'

// Persisted key for the Anya autonomous-scheduler master toggle.
const ANYA_AUTONOMOUS_SETTING_KEY = 'anya.autonomous_enabled'

/** Resolve current Anya autonomous-enabled state: persisted toggle wins, else live config. */
async function readAnyaAutonomousState(db) {
  const persisted = await getAgentSetting(db, ANYA_AUTONOMOUS_SETTING_KEY)
  const cfg = getAutonomousConfig()
  return {
    enabled: cfg.enabled === true,
    persisted: persisted === null ? null : persisted === 'true',
    source: persisted === null ? 'default' : 'toggle',
    operations: cfg.operations,
    run_on_schedule: cfg.runOnSchedule === true,
  }
}

const router = express.Router()
const log = createLogger('route:agent-control')

router.use(ensureAuth)

/**
 * Admin gate. Strict: only the canonical admin/operator
 * (buckeye7066@gmail.com or env override) may use any route under this
 * router. We do not honour role-based fallbacks here on purpose —
 * Control Center actions are too dangerous for a vague allowlist.
 */
function ensureCanonicalAdmin(req, res, next) {
  if (!isControlCenterAdmin(req.user)) {
    log.warn('rejected non-admin attempt', {
      email: req.user?.email || null,
      role: req.user?.role || null,
      route: req.originalUrl,
    })
    return res.status(403).json({
      ok: false,
      error: 'agent_control_admin_only',
      message: `Only ${getCanonicalAdminEmail()} may access the Agent Control Center.`,
    })
  }
  return next()
}

router.use(ensureCanonicalAdmin)

function asyncHandler(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    const status = err?.status || 500
    log.error('handler failed', { route: req.originalUrl, status, err: err?.message })
    res.status(status).json({ ok: false, error: err?.message || 'internal_error' })
  })
}

async function logAdminAction(req, action, data = {}) {
  try {
    await recordEvent(req.db, {
      eventType: `control.api.${action}`,
      severity: 'info',
      message: `${action} by ${req.user?.email || 'admin'}`,
      data: { ...data, requested_by: req.user?.email || null },
    })
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// READ endpoints
// ---------------------------------------------------------------------------
router.get('/status', asyncHandler(async (req, res) => {
  const status = await getControlCenterStatus(req.db)
  const highlights = await getRunHighlights(req.db)
  res.json({
    ok: true,
    admin_email: getCanonicalAdminEmail(),
    canonical_admin: getCanonicalAdminEmail(),
    canonical_admin_default: CANONICAL_ADMIN_EMAIL_DEFAULT,
    available_agents: ALL_AGENTS,
    available_run_types: RUN_TYPES,
    ...status,
    highlights,
  })
}))

// Anya autonomous-scheduler master toggle (owner-flipped, persisted).
router.get('/anya/autonomous', asyncHandler(async (req, res) => {
  const state = await readAnyaAutonomousState(req.db)
  res.json({ ok: true, ...state })
}))

router.put('/anya/autonomous', asyncHandler(async (req, res) => {
  const raw = req.body?.enabled
  if (typeof raw !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'enabled_boolean_required' })
  }
  await setAgentSetting(req.db, ANYA_AUTONOMOUS_SETTING_KEY, raw ? 'true' : 'false', {
    updatedByEmail: req.user?.email || null,
  })
  setAutonomousEnabled(raw) // apply to the live in-memory scheduler immediately
  await logAdminAction(req, 'anya_autonomous_toggle', { enabled: raw })
  const state = await readAnyaAutonomousState(req.db)
  res.json({ ok: true, ...state })
}))

// ---------------------------------------------------------------------------
// Autonomous Code Repair (Sam/Anya) — owner-flipped master switch + land mode +
// critical-path override, persisted DB-authoritative over env. Governs
// auto-merge-to-prod, so it stays under the strict owner gate above.
// ---------------------------------------------------------------------------
function serializeRepairConfig(config, readiness) {
  return {
    ok: true,
    config: {
      enabled: config.enabled === true,
      landMode: config.landMode === 'direct' ? 'direct' : 'pr',
      allowCritical: config.allowCritical === true,
    },
    source: config.source,
    readiness,
  }
}

router.get('/adversarial-repair', asyncHandler(async (req, res) => {
  const config = await getAdversarialRepairConfig(req.db)
  res.json(serializeRepairConfig(config, computeAdversarialRepairReadiness()))
}))

router.put('/adversarial-repair', asyncHandler(async (req, res) => {
  const body = req.body || {}
  const patch = {}
  if (body.enabled !== undefined) patch.enabled = body.enabled
  if (body.landMode !== undefined) patch.landMode = body.landMode
  if (body.allowCritical !== undefined) patch.allowCritical = body.allowCritical

  const validation = validateAdversarialRepairPatch(patch)
  if (!validation.ok) {
    return res.status(400).json({ ok: false, error: 'invalid_config', details: validation.errors })
  }

  const config = await setAdversarialRepairConfig(req.db, patch)

  // Dual trail: the control-event log + the general audit log (this governs
  // prod auto-merge, so record who/when/what at WARNING severity).
  await logAdminAction(req, 'adversarial_repair_config', patch)
  try {
    await logAuditEvent(req.db, {
      category: AUDIT_CATEGORIES.ADMIN,
      action: 'adversarial_repair_config_change',
      severity: SEVERITY.WARNING,
      userId: req.user?.userId ?? req.user?.id ?? null,
      resourceType: 'adversarial_repair_config',
      details: {
        patch,
        result: { enabled: config.enabled, landMode: config.landMode, allowCritical: config.allowCritical },
        by: req.user?.email || null,
      },
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
    })
  } catch { /* best-effort — never block the response on audit */ }

  res.json(serializeRepairConfig(config, computeAdversarialRepairReadiness()))
}))

router.get('/runs', asyncHandler(async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50))
  const runType = req.query.run_type ? String(req.query.run_type) : null
  const status = req.query.status ? String(req.query.status) : null
  const runs = await listRuns(req.db, { limit, runType, status })
  res.json({ ok: true, runs })
}))

router.get('/runs/:runId', asyncHandler(async (req, res) => {
  const run = await getRun(req.db, String(req.params.runId))
  if (!run) return res.status(404).json({ ok: false, error: 'run_not_found' })
  const steps = await listSteps(req.db, run.id)
  res.json({ ok: true, run, steps })
}))

router.get('/runs/:runId/events', asyncHandler(async (req, res) => {
  const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 200))
  const severity = req.query.severity ? String(req.query.severity) : null
  const eventType = req.query.event_type ? String(req.query.event_type) : null
  const events = await listEvents(req.db, String(req.params.runId), { limit, severity, eventType })
  res.json({ ok: true, events })
}))

// ---------------------------------------------------------------------------
// WRITE endpoints
// ---------------------------------------------------------------------------
router.post('/start', asyncHandler(async (req, res) => {
  const body = req.body || {}
  const runType = String(body.run_type || '').toLowerCase()
  const agents = Array.isArray(body.agents) ? body.agents : []
  const options = body.options && typeof body.options === 'object' ? body.options : {}

  if (!RUN_TYPES.includes(runType)) {
    return res.status(400).json({ ok: false, error: 'invalid_run_type', allowed: RUN_TYPES })
  }

  await logAdminAction(req, 'start.requested', { run_type: runType, agents, options })

  const result = await startRun(req.db, { runType, agents, options, user: req.user })
  res.status(202).json({
    ok: true,
    run: result.run,
    steps: result.steps,
  })
}))

router.post('/runs/:runId/pause', asyncHandler(async (req, res) => {
  const reason = req.body?.reason || null
  const run = await pauseRun(req.db, String(req.params.runId), { user: req.user, reason })
  await logAdminAction(req, 'pause', { run_id: req.params.runId, reason })
  res.json({ ok: true, run })
}))

router.post('/runs/:runId/resume', asyncHandler(async (req, res) => {
  const run = await resumeRun(req.db, String(req.params.runId), { user: req.user })
  await logAdminAction(req, 'resume', { run_id: req.params.runId })
  res.json({ ok: true, run })
}))

router.post('/runs/:runId/stop', asyncHandler(async (req, res) => {
  const reason = req.body?.reason || null
  const run = await stopRun(req.db, String(req.params.runId), { user: req.user, reason })
  await logAdminAction(req, 'stop', { run_id: req.params.runId, reason })
  res.json({ ok: true, run })
}))

router.post('/runs/:runId/emergency-stop', asyncHandler(async (req, res) => {
  const reason = req.body?.reason || null
  const run = await emergencyStopRun(req.db, String(req.params.runId), { user: req.user, reason })
  await logAdminAction(req, 'emergency_stop', { run_id: req.params.runId, reason })
  res.json({ ok: true, run })
}))

router.post('/runs/:runId/cancel', asyncHandler(async (req, res) => {
  const reason = req.body?.reason || null
  const run = await cancelRun(req.db, String(req.params.runId), { user: req.user, reason })
  await logAdminAction(req, 'cancel', { run_id: req.params.runId, reason })
  res.json({ ok: true, run })
}))

// ---------------------------------------------------------------------------
// Per-agent endpoints
// ---------------------------------------------------------------------------
router.post('/agents/:agentName/start', asyncHandler(async (req, res) => {
  const name = String(req.params.agentName || '').toLowerCase()
  if (!ALL_AGENTS.includes(name)) {
    return res.status(400).json({ ok: false, error: 'invalid_agent', allowed: ALL_AGENTS })
  }
  const options = req.body?.options && typeof req.body.options === 'object' ? req.body.options : {}
  const result = await startAgent(req.db, name, { user: req.user, options })
  await logAdminAction(req, `agent.start`, { agent: name, options })
  res.status(202).json({ ok: true, ...result })
}))

router.post('/agents/:agentName/stop', asyncHandler(async (req, res) => {
  const name = String(req.params.agentName || '').toLowerCase()
  if (!ALL_AGENTS.includes(name)) {
    return res.status(400).json({ ok: false, error: 'invalid_agent', allowed: ALL_AGENTS })
  }
  const result = await stopAgent(req.db, name, { user: req.user, reason: req.body?.reason || null })
  await logAdminAction(req, `agent.stop`, { agent: name, reason: req.body?.reason || null })
  res.json({ ok: true, ...result })
}))

router.get('/agents/:agentName/status', asyncHandler(async (req, res) => {
  const name = String(req.params.agentName || '').toLowerCase()
  if (!ALL_AGENTS.includes(name)) {
    return res.status(400).json({ ok: false, error: 'invalid_agent', allowed: ALL_AGENTS })
  }
  const status = await getAgentStatus(req.db, name)
  res.json({ ok: true, agent: status })
}))

// A free-text, one-shot instruction the owner attaches to an agent from the
// admin UI ("give the agent a specific instruction"). Persisted until either
// consumed by the agent's next run (startRun clears it) or explicitly
// replaced/cleared here.
router.get('/agents/:agentName/directive', asyncHandler(async (req, res) => {
  const name = String(req.params.agentName || '').toLowerCase()
  if (!ALL_AGENTS.includes(name)) {
    return res.status(400).json({ ok: false, error: 'invalid_agent', allowed: ALL_AGENTS })
  }
  const directive = await getAgentDirective(req.db, name)
  res.json({ ok: true, directive })
}))

router.put('/agents/:agentName/directive', asyncHandler(async (req, res) => {
  const name = String(req.params.agentName || '').toLowerCase()
  if (!ALL_AGENTS.includes(name)) {
    return res.status(400).json({ ok: false, error: 'invalid_agent', allowed: ALL_AGENTS })
  }
  const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction : ''
  const directive = await setAgentDirective(req.db, name, instruction, { userEmail: req.user?.email || null })
  await logAdminAction(req, 'agent.directive', { agent: name, instruction: instruction.slice(0, 500) })
  res.json({ ok: true, directive })
}))

export default router
