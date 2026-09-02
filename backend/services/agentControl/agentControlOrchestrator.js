/**
 * agentControlOrchestrator.js
 *
 * The Admin Agent Control Center orchestrator. Coordinates Sam, Robert,
 * Yana (Client Discovery, NOT Hamilton), John, and Hamilton (Application
 * Autopilot) through their adapter contracts.
 *
 * Single operator configured by the deployed environment and resolved from
 * canonical request context.
 *
 * Lifecycle:
 *
 *   1. Route handler validates the admin and calls `startRun(...)` or
 *      `startSelectedAgents(...)` etc.
 *   2. We create an `agent_control_runs` row + ordered
 *      `agent_control_steps` rows + (for full_cycle) acquire the
 *      `agent_control:full_cycle` lock.
 *   3. We kick off `executeRun({ db, runId })` without awaiting it
 *      (fire-and-forget) so the HTTP response returns immediately.
 *   4. The orchestrator iterates queued steps in order:
 *        - poll `latestUnfulfilledStop` between every step to honour
 *          stop / pause / cancel requests
 *        - call `adapter.start({ ..., signal })` with a signal object
 *          the adapter is expected to poll inside its own loops
 *        - update the step row + the agent_control_events timeline
 *   5. When the run finishes, we release the lock, mark the run row
 *      `completed` / `failed` / `stopped` / `cancelled`, and emit the
 *      lifecycle notification to the canonical admin.
 *
 * Stop semantics:
 *   - graceful_stop  finish the current step's atomic op, do not start
 *                    the next step. Run status: stopping → stopped.
 *   - pause          finish the current atomic op, do not advance.
 *                    Run status: pausing → paused. Resume continues
 *                    the next queued step.
 *   - cancel         like graceful_stop but explicitly user-cancelled.
 *                    Run status: cancelled.
 *   - emergency_stop record the request, mark queued steps stopped,
 *                    notify admin loudly. Run status: stopped or
 *                    partial_stop if an in-flight step could not be
 *                    safely interrupted.
 */

import {
  ALL_AGENTS,
  STATUS_AGENTS,
  CANONICAL_ADMIN_EMAIL_DEFAULT,
  DEFAULT_RUN_OPTIONS,
  assertNoDryRunOption,
  FULL_CYCLE_LOCK,
  FULL_CYCLE_ORDER,
  RUN_TYPES,
  agentLockName,
  resolveAgentsForRun,
} from './agentControlTypes.js'
import {
  acquireLock,
  createRun,
  createSteps,
  ensureSchema,
  fulfillStopRequestsByType,
  getActiveRun,
  getAgentSetting,
  getRun,
  heartbeat,
  latestUnfulfilledStop,
  listSteps,
  recordEvent,
  recordStopRequest,
  releaseLock,
  setAgentSetting,
  setRunStatus,
  setStepStatus,
} from './agentControlStore.js'
import { getAdapter } from './agentAdapters/agentAdapterRegistry.js'
import { makeSignal } from './agentAdapters/baseAgentAdapter.js'
import { insertActivityEvent } from '../agentTelemetry/agentTelemetryStore.js'
import { createLogger } from '../../utils/logger.js'
import { isSyntheticServiceAdmin } from '../../middleware/syntheticServiceTokens.js'
const qualityLog = createLogger('services:agentControl:agentControlOrchestrator')

// ---------------------------------------------------------------------------
// Per-agent directives — a one-shot free-text instruction the owner attaches
// to an agent from the admin UI ("give the agent a specific instruction").
// Persisted via the same agent_settings KV the Anya autonomy toggle uses, so
// it survives restarts. Consumed (cleared) the moment a run that includes the
// agent actually starts, and threaded onto that run's options so every
// adapter can read `options.directives[agentName]` and fold it into the
// underlying call it makes (Sam scopes checkIds from it; others at minimum
// record + display it on the run).
// ---------------------------------------------------------------------------
function directiveKey(agentName) {
  return `agent.directive.${agentName}`
}

export async function getAgentDirective(db, agentName) {
  const raw = await getAgentSetting(db, directiveKey(agentName))
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function setAgentDirective(db, agentName, text, { userEmail = null } = {}) {
  const key = directiveKey(agentName)
  const trimmed = String(text || '').trim()
  if (!trimmed) {
    await setAgentSetting(db, key, null, { updatedByEmail: userEmail })
    return null
  }
  const record = { text: trimmed, createdAt: new Date().toISOString(), createdByEmail: userEmail }
  await setAgentSetting(db, key, JSON.stringify(record), { updatedByEmail: userEmail })
  return record
}

/** Reads + clears each agent's pending directive, returning {agentName: text}. One-shot. */
async function consumeDirectives(db, agentNames) {
  const directives = {}
  for (const name of agentNames) {
    try {
      const record = await getAgentDirective(db, name)
      if (record?.text) {
        directives[name] = record.text
        await setAgentSetting(db, directiveKey(name), null)
      }
    } catch { /* best-effort — a directive read failure must never block a run */ }
  }
  return directives
}

/**
 * Count the real, persisted units of work an agent reported in its step
 * summary. Drives (a) the unified telemetry event status (succeeded vs noop)
 * and (b) whether the whole run actually did anything (honest completion).
 */
function countAgentWork(agentName, summary) {
  const s = summary || {}
  const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0 }
  switch (String(agentName || '').toLowerCase()) {
    case 'sam':
      return num(s.findings_total) + (s.sam_run_id ? 1 : 0)
    case 'robert':
      return num(s.candidates_inserted) + num(s.recommendations_created)
        + num(s.opportunities_ingested) + num(s.candidates_found)
    case 'yana':
      return num(s.candidates_qualified) + num(s.leads_pushed_to_john) + num(s.candidates_total)
    case 'john':
      return num(s.drafts_created) + num(s.drafts_blocked)
    case 'hamilton':
      return num(s.processed)
    case 'anya':
      return num(s.interactions) + num(s.actions)
    default:
      return 0
  }
}
import { canTransition } from './agentRunStateMachine.js'
import {
  notifyAgentBlocked,
  notifyAgentFailed,
  notifyCompleted,
  notifyEmergencyStopped,
  notifyFailed,
  notifyPaused,
  notifyResumed,
  notifyStarted,
  notifyStopped,
} from './agentControlNotifications.js'

const DEPLOYED_RUNTIME = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production'
  || Boolean(String(process.env.RAILWAY_ENVIRONMENT_ID || '').trim())
  || Boolean(String(process.env.RAILWAY_DEPLOYMENT_ID || '').trim())
const ADMIN_EMAIL = (process.env.AGENT_CONTROL_ADMIN_EMAIL
  || process.env.ADMIN_EMAIL
  || (DEPLOYED_RUNTIME ? '' : CANONICAL_ADMIN_EMAIL_DEFAULT)).trim().toLowerCase()

/** Verifies a user previously authorized from canonical request context. */
export function isControlCenterAdmin(user) {
  if (!ADMIN_EMAIL) return false
  if (isSyntheticServiceAdmin(user)) return true
  if (user?.controlCenterAuthorized !== true) return false
  if (!user) return false
  const email = String(user.email || user.primary_email || '').trim().toLowerCase()
  if (!email) return false
  return email === ADMIN_EMAIL
}

/**
 * Convert an authenticated request principal into the narrow operator actor
 * consumed by command methods. Token email/role claims never authorize this
 * step: a real user must be DB-resolved, DB-admin, and have the configured
 * primary email. Validated synthetic service tokens retain their existing
 * provenance-bound access.
 */
export function authorizeControlCenterUser(user, context) {
  if (!ADMIN_EMAIL || context?.identityResolved !== true || context?.isAdmin !== true) return null

  if (isSyntheticServiceAdmin(user)) {
    return { ...user, email: ADMIN_EMAIL, controlCenterAuthorized: true }
  }

  const trustedEmail = String(context?.email || '').trim().toLowerCase()
  if (!trustedEmail || trustedEmail !== ADMIN_EMAIL) return null
  return { ...user, email: trustedEmail, controlCenterAuthorized: true }
}

export function getCanonicalAdminEmail() { return ADMIN_EMAIL }

/**
 * Start the documented background full-agent cycle without manufacturing an
 * HTTP request principal. This is the single internal entry point used by the
 * scheduler; it still goes through startRun, schema checks, durable run rows,
 * distributed locks, adapter consent gates, and the normal audit timeline.
 */
export async function startScheduledCycle(db, { options = {} } = {}) {
  if (!ADMIN_EMAIL) {
    return { skipped: true, reason: 'agent_control_admin_email_not_configured' }
  }
  return startRun(db, {
    runType: 'scheduled_cycle',
    options: {
      scheduled: true,
      skip_if_locked: true,
      run_name: 'Scheduled background agent cycle',
      ...options,
    },
    user: {
      userId: 'system_agent_scheduler',
      email: ADMIN_EMAIL,
      primary_email: ADMIN_EMAIL,
      controlCenterAuthorized: true,
    },
  })
}

/**
 * Build the ordered step plan for a run. Sam pre/postflight only fire
 * for full_cycle / scheduled_cycle / selected_agents runs that include sam.
 */
export function buildStepPlan(runType, agents, options) {
  const sel = new Set(agents)
  const includeSam = sel.has('sam')
  const plan = []
  let order = 0

  if ((runType === 'full_cycle' || runType === 'scheduled_cycle' || runType === 'selected_agents' || runType === 'sam_only')
      && includeSam
      && options.run_sam_preflight !== false) {
    plan.push({ agent: 'sam', step_name: 'sam_preflight', step_order: order++, stage: 'preflight' })
  }

  for (const agent of FULL_CYCLE_ORDER) {
    if (!sel.has(agent)) continue
    if (agent === 'sam') continue // handled by pre/postflight
    plan.push({ agent, step_name: `${agent}_main`, step_order: order++ })
  }

  // sam_only: still allow a single main run alongside pre/postflight
  if (runType === 'sam_only' && includeSam) {
    plan.push({ agent: 'sam', step_name: 'sam_main', step_order: order++, stage: 'observe' })
  }

  if ((runType === 'full_cycle' || runType === 'scheduled_cycle' || runType === 'selected_agents' || runType === 'sam_only')
      && includeSam
      && options.run_sam_postflight !== false) {
    plan.push({ agent: 'sam', step_name: 'sam_postflight', step_order: order++, stage: 'postflight' })
  }

  return plan
}

/**
 * Public API: start a run. Returns { run, steps } so the route handler
 * can render the new run immediately while orchestration continues
 * asynchronously.
 *
 * Throws { status: 409 } when a full_cycle is already in flight.
 */
export async function startRun(db, {
  runType,
  agents = [],
  options = {},
  user = null,
} = {}) {
  if (!db) throw new Error('startRun: db required')
  if (!RUN_TYPES.includes(runType)) {
    const e = new Error(`invalid runType "${runType}"`)
    e.status = 400
    throw e
  }
  // Naming the removed dry_run flag FAILS the request outright — it must
  // never silently proceed as a real run the caller believed was a preview.
  assertNoDryRunOption(options)
  if (!isControlCenterAdmin(user)) {
    const e = new Error('Only the canonical admin/operator may start agent control runs.')
    e.status = 403
    throw e
  }

  await ensureSchema(db)

  const resolvedAgents = resolveAgentsForRun(runType, agents)
  if (resolvedAgents.length === 0) {
    const e = new Error('No valid agents resolved for this run.')
    e.status = 400
    throw e
  }

  const directives = await consumeDirectives(db, resolvedAgents)
  const mergedOptions = { ...DEFAULT_RUN_OPTIONS, ...(options || {}), directives }

  // Single full_cycle at a time. We check the active run first for a
  // friendlier error, then back it up with the lock so concurrent calls
  // can't race past us.
  if (runType === 'full_cycle') {
    const active = await getActiveRun(db)
    if (active && ['full_cycle', 'scheduled_cycle'].includes(active.run_type)) {
      const e = new Error(`A full agent cycle is already in progress (id=${active.id}).`)
      e.status = 409
      e.runId = active.id
      throw e
    }
  }

  const runId = await createRun(db, {
    runType,
    runName: options?.run_name || null,
    startedByUserId: user?.userId || user?.id || null,
    startedByEmail: user?.email || user?.primary_email || null,
    adminEmail: ADMIN_EMAIL,
    requestedAgents: resolvedAgents,
    options: mergedOptions,
    status: 'queued',
  })

  if (Object.keys(directives).length) {
    await recordEvent(db, {
      controlRunId: runId,
      agentName: resolvedAgents.length === 1 ? resolvedAgents[0] : null,
      eventType: 'control.agent.directive_applied',
      severity: 'info',
      message: `Applying owner instruction to ${Object.keys(directives).join(', ')}`,
      data: { directives },
    })
  }

  // Acquire the appropriate lock. For full_cycle we lock everything;
  // for other run types we lock the per-agent name so individual runs
  // can't overlap with each other (but they can overlap with a
  // full_cycle if explicitly allowed).
  const lockName = ['full_cycle', 'scheduled_cycle'].includes(runType)
    ? FULL_CYCLE_LOCK
    : (resolvedAgents.length === 1 ? agentLockName(resolvedAgents[0]) : null)

  // Automated/scheduled triggers (and any caller that opts in) treat a
  // held lock as "already running" — a graceful skip, not a failure — so a
  // recurring scheduler can't spam the failure dashboard. A manual start
  // still surfaces a 409 so the operator knows their click was a no-op, but
  // we never record it as a `failed` run.
  const skipIfLocked = runType === 'scheduled_cycle'
    || mergedOptions.skip_if_locked === true
    || mergedOptions.scheduled === true
  // Bounded retry-with-backoff smooths over the brief window where a prior
  // run is mid-teardown or its lock is a tick away from expiry.
  const lockRetries = Number.isFinite(mergedOptions.lock_acquire_retries)
    ? mergedOptions.lock_acquire_retries
    : 5

  let lockLease = null
  if (lockName) {
    lockLease = await acquireLock(db, {
      lockName,
      controlRunId: runId,
      acquiredBy: user?.email || ADMIN_EMAIL,
      ttlMs: Math.max(60_000, Number(mergedOptions.max_runtime_minutes) * 60_000 || 60 * 60_000),
      retries: lockRetries,
      backoffMs: 250,
    })
    if (!lockLease.acquired) {
      // Mark the run terminal as `cancelled` (a no-op skip), NOT `failed`:
      // `cancelled` is excluded from the Mission Control failure highlights,
      // so a contended lock stops generating "Last failure" noise.
      await setRunStatus(db, runId, 'cancelled', {
        errorMessage: `Skipped: "${lockName}" already held by run ${lockLease.heldBy || 'unknown'}.`,
        summary: { skipped: true, reason: 'lock_held', lock_name: lockName, held_by: lockLease.heldBy },
      })
      await recordEvent(db, {
        controlRunId: runId,
        eventType: 'control.run.skipped',
        severity: 'info',
        message: `Run skipped — "${lockName}" already running (held by run ${lockLease.heldBy || 'unknown'}).`,
        data: { lock_name: lockName, held_by: lockLease.heldBy, expires_at: lockLease.expiresAt },
      })
      if (skipIfLocked) {
        const skippedRun = await getRun(db, runId)
        return { run: skippedRun, steps: [], skipped: true }
      }
      const e = new Error(`Lock "${lockName}" already held by another run.`)
      e.status = 409
      e.skipped = true
      throw e
    }
  }

  // From here on a lock may be held. Any failure during setup must release
  // it (try/catch below) so a setup crash can never orphan the lock — the
  // executor only takes ownership once it's running.
  try {
    const plan = buildStepPlan(runType, resolvedAgents, mergedOptions)
    await createSteps(db, runId, plan.map((p) => ({
      agentName: p.agent,
      stepName: p.step_name,
      stepOrder: p.step_order,
      status: 'queued',
      progress: { stage: p.stage || 'main' },
    })))

    await recordEvent(db, {
      controlRunId: runId,
      eventType: 'control.run.created',
      severity: 'info',
      message: `Run created: ${runType} (agents: ${resolvedAgents.join(', ')})`,
      data: { run_type: runType, agents: resolvedAgents, options: mergedOptions },
    })

    const run = await getRun(db, runId)
    await notifyStarted(db, run)

    // Fire-and-forget execution. The run keeps going after the HTTP
    // response returns.
    executeRun({ db, runId }).catch((err) => {
      qualityLog.error('[agent-control] executeRun crashed:', err?.message || err)
    })

    const steps = await listSteps(db, runId)
    return { run, steps }
  } catch (setupErr) {
    if (lockLease?.acquired) {
      await releaseLock(db, {
        lockName,
        controlRunId: runId,
        ownerToken: lockLease.ownerToken,
      }).catch(() => {})
    }
    await setRunStatus(db, runId, 'failed', {
      errorMessage: `Run setup failed: ${setupErr?.message || setupErr}`,
    }).catch(() => {})
    throw setupErr
  }
}

// ---------------------------------------------------------------------------
// Stop / pause / resume command surface
// ---------------------------------------------------------------------------
async function requireRunTransition(db, runId, event) {
  const run = await getRun(db, runId)
  if (!run) {
    const error = new Error(`Agent-control run not found: ${runId}`)
    error.status = 404
    error.code = 'agent_control_run_not_found'
    throw error
  }
  if (!canTransition(run.status, event)) {
    const error = new Error(
      `Cannot ${event} agent-control run ${runId} while it is ${run.status}.`,
    )
    error.status = 409
    error.code = 'invalid_run_transition'
    error.currentStatus = run.status
    throw error
  }
  return run
}

export async function pauseRun(db, runId, { user = null, reason = null } = {}) {
  if (!isControlCenterAdmin(user)) { const e = new Error('admin only'); e.status = 403; throw e }
  await requireRunTransition(db, runId, 'pause')
  await recordStopRequest(db, {
    controlRunId: runId,
    requestType: 'pause',
    requestedByEmail: user?.email,
    requestedByUserId: user?.userId,
    reason,
  })
  await setRunStatus(db, runId, 'pausing', { pauseRequestedAt: new Date().toISOString() })
  await recordEvent(db, {
    controlRunId: runId,
    eventType: 'control.run.pause_requested',
    severity: 'medium',
    message: `Pause requested by ${user?.email || 'admin'}${reason ? `: ${reason}` : ''}`,
  })
  const run = await getRun(db, runId)
  await notifyPaused(db, run, reason)
  return run
}

export async function resumeRun(db, runId, { user = null } = {}) {
  if (!isControlCenterAdmin(user)) { const e = new Error('admin only'); e.status = 403; throw e }
  await requireRunTransition(db, runId, 'resume')
  await recordStopRequest(db, {
    controlRunId: runId,
    requestType: 'resume',
    requestedByEmail: user?.email,
    requestedByUserId: user?.userId,
  })
  // Mark the existing pause requests fulfilled so the next poll sees
  // the resume state cleanly. A step that cooperatively paused is requeued:
  // its adapter resumes from durable task state instead of being skipped.
  await fulfillStopRequestsByType(db, runId, 'pause')
  const pausedSteps = await listSteps(db, runId)
  for (const step of pausedSteps) {
    if (step.status === 'paused') {
      await setStepStatus(db, step.id, 'queued', {
        progress: { ...(step.progress || {}), resumed_at: new Date().toISOString() },
      })
    }
  }
  await setRunStatus(db, runId, 'running', { resumeRequestedAt: new Date().toISOString() })
  await recordEvent(db, {
    controlRunId: runId,
    eventType: 'control.run.resume_requested',
    severity: 'info',
    message: `Resume requested by ${user?.email || 'admin'}`,
  })
  const run = await getRun(db, runId)
  await notifyResumed(db, run)

  // Re-kick the executor — it idempotently picks up the next queued
  // step. (Already-completed / running steps are not re-run.)
  executeRun({ db, runId }).catch((err) => {
    qualityLog.error('[agent-control] executeRun (resume) crashed:', err?.message || err)
  })

  return run
}

export async function stopRun(db, runId, { user = null, reason = null } = {}) {
  if (!isControlCenterAdmin(user)) { const e = new Error('admin only'); e.status = 403; throw e }
  await requireRunTransition(db, runId, 'graceful_stop')
  await recordStopRequest(db, {
    controlRunId: runId,
    requestType: 'graceful_stop',
    requestedByEmail: user?.email,
    requestedByUserId: user?.userId,
    reason,
  })
  await setRunStatus(db, runId, 'stopping', { cancellationRequestedAt: new Date().toISOString() })
  await recordEvent(db, {
    controlRunId: runId,
    eventType: 'control.run.stop_requested',
    severity: 'medium',
    message: `Graceful stop requested by ${user?.email || 'admin'}${reason ? `: ${reason}` : ''}`,
  })
  const run = await getRun(db, runId)
  return run
}

export async function emergencyStopRun(db, runId, { user = null, reason = null } = {}) {
  if (!isControlCenterAdmin(user)) { const e = new Error('admin only'); e.status = 403; throw e }
  await requireRunTransition(db, runId, 'emergency_stop')
  await recordStopRequest(db, {
    controlRunId: runId,
    requestType: 'emergency_stop',
    requestedByEmail: user?.email,
    requestedByUserId: user?.userId,
    reason,
  })
  await setRunStatus(db, runId, 'stopping', { cancellationRequestedAt: new Date().toISOString() })

  // Mark every queued step stopped immediately so they never start.
  const steps = await listSteps(db, runId)
  let inFlight = 0
  for (const s of steps) {
    if (s.status === 'queued') {
      await setStepStatus(db, s.id, 'stopped', { errorMessage: 'emergency_stop' })
    } else if (s.status === 'running' || s.status === 'pausing' || s.status === 'paused') {
      inFlight += 1
    }
  }

  await recordEvent(db, {
    controlRunId: runId,
    eventType: 'control.run.emergency_stop',
    severity: 'critical',
    message: `Emergency stop by ${user?.email || 'admin'}${reason ? `: ${reason}` : ''}. ${inFlight} step(s) still in-flight.`,
    data: { in_flight_steps: inFlight, reason },
  })

  // If nothing was in flight, finalise immediately. Otherwise the
  // executor's stop polling will land us in 'partial_stop' or 'stopped'.
  let run = await getRun(db, runId)
  if (inFlight === 0) {
    await setRunStatus(db, runId, 'stopped', { errorMessage: reason || 'emergency_stop' })
    await releaseLock(db, { controlRunId: runId })
    run = await getRun(db, runId)
  }
  await notifyEmergencyStopped(db, run, reason)
  return run
}

export async function cancelRun(db, runId, { user = null, reason = null } = {}) {
  if (!isControlCenterAdmin(user)) { const e = new Error('admin only'); e.status = 403; throw e }
  await requireRunTransition(db, runId, 'cancel')
  await recordStopRequest(db, {
    controlRunId: runId,
    requestType: 'cancel',
    requestedByEmail: user?.email,
    requestedByUserId: user?.userId,
    reason,
  })
  // Mark every queued step skipped.
  const steps = await listSteps(db, runId)
  for (const s of steps) {
    if (s.status === 'queued') {
      await setStepStatus(db, s.id, 'skipped', { errorMessage: 'cancelled' })
    }
  }
  await setRunStatus(db, runId, 'cancelled', {
    cancellationRequestedAt: new Date().toISOString(),
    errorMessage: reason || 'cancelled by admin',
  })
  await releaseLock(db, { controlRunId: runId })
  await recordEvent(db, {
    controlRunId: runId,
    eventType: 'control.run.cancelled',
    severity: 'medium',
    message: `Cancelled by ${user?.email || 'admin'}${reason ? `: ${reason}` : ''}`,
  })
  const run = await getRun(db, runId)
  await notifyStopped(db, run, { partial: false, reason: reason || 'cancelled' })
  return run
}

// ---------------------------------------------------------------------------
// Per-agent command surface (start/stop a single agent without a run)
// ---------------------------------------------------------------------------
export async function startAgent(db, agentName, { user = null, options = {} } = {}) {
  const name = String(agentName || '').toLowerCase()
  if (!ALL_AGENTS.includes(name)) {
    const e = new Error(`invalid agent "${agentName}"`); e.status = 400; throw e
  }
  const runType = `${name}_only`
  return startRun(db, { runType, agents: [name], options, user })
}

export async function stopAgent(db, agentName, { user = null, reason = null } = {}) {
  if (!isControlCenterAdmin(user)) { const e = new Error('admin only'); e.status = 403; throw e }
  const name = String(agentName || '').toLowerCase()
  if (!ALL_AGENTS.includes(name)) {
    const e = new Error(`invalid agent "${agentName}"`); e.status = 400; throw e
  }
  // Find the most recent active run that includes this agent and stop it.
  const active = await getActiveRun(db)
  if (!active) return { ok: true, message: 'no active run' }
  if (!(active.requested_agents || []).includes(name)) {
    return { ok: false, message: `active run does not include ${name}` }
  }
  // Per-agent stop: write a stop_request scoped to the agent so the
  // adapter knows to halt mid-loop, but don't tear down the whole run.
  await recordStopRequest(db, {
    controlRunId: active.id,
    agentName: name,
    requestType: 'graceful_stop',
    requestedByEmail: user?.email,
    requestedByUserId: user?.userId,
    reason,
  })
  await recordEvent(db, {
    controlRunId: active.id,
    agentName: name,
    eventType: 'control.agent.stop_requested',
    severity: 'medium',
    message: `Stop ${name} requested by ${user?.email || 'admin'}${reason ? `: ${reason}` : ''}`,
  })
  return { ok: true, run: active }
}

export async function getAgentStatus(db, agentName) {
  const adapter = getAdapter(agentName)
  if (!adapter) return null
  return adapter.getStatus({ db })
}

// ---------------------------------------------------------------------------
// Status / overview surface
// ---------------------------------------------------------------------------
export async function getControlCenterStatus(db) {
  const active = await getActiveRun(db)
  let activeSteps = []
  if (active) activeSteps = await listSteps(db, active.id)

  const agents = {}
  // STATUS_AGENTS = ALL_AGENTS + anya (status-only). Anya is surfaced for
  // observability but never started/stopped here (those gate on ALL_AGENTS).
  for (const name of STATUS_AGENTS) {
    try {
      agents[name] = await getAdapter(name).getStatus({ db })
    } catch (err) {
      agents[name] = { agent_name: name, health: 'error', error: err?.message || String(err) }
    }
  }

  return {
    admin_email: ADMIN_EMAIL,
    active_run: active ? { ...active, current_steps: activeSteps } : null,
    agents,
  }
}

// ---------------------------------------------------------------------------
// Internal: orchestration loop
// ---------------------------------------------------------------------------
export async function executeRun(args = {}) {
  const { db, runId } = args
  if (!db || !runId) return

  // A run-level lock prevents rapid Resume clicks or two Railway replicas from
  // starting concurrent executors for the same durable run. The full-cycle
  // lock prevents other runs; this narrower lease prevents duplicate side
  // effects inside one run. It is released on pause so Resume can take over.
  const executorLockName = `agent_control:executor:${runId}`
  const executorLease = await acquireLock(db, {
    lockName: executorLockName,
    controlRunId: runId,
    acquiredBy: 'agent-control-executor',
    ttlMs: 60 * 60 * 1000,
    retries: 0,
  })
  if (!executorLease.acquired) {
    return { skipped: true, reason: 'executor_already_active' }
  }
  try {
    return await executeRunOnce(args)
  } finally {
    await releaseLock(db, {
      lockName: executorLockName,
      controlRunId: runId,
      ownerToken: executorLease.ownerToken,
    }).catch(() => {})
  }
}

async function executeRunOnce({ db, runId } = {}) {
  const run = await getRun(db, runId)
  if (!run) return

  const finalStates = ['completed', 'completed_noop', 'failed', 'cancelled', 'stopped', 'partial_stop', 'stop_failed']
  if (finalStates.includes(run.status)) {
    // Run is already terminal (e.g. a skipped/cancelled start). Guarantee no
    // lock lingers for it — releasing by runId is owner-safe because run IDs
    // are unique, so we can only ever free this run's own lock.
    await releaseLock(db, { controlRunId: runId }).catch(() => {})
    return
  }

  if (run.status === 'queued') {
    await setRunStatus(db, runId, 'running')
  }

  // Defense-in-depth: guarantee every agent's telemetry/run tables exist
  // before any adapter executes. Boot already self-heals these, but a run
  // can be triggered against a server that booted before the agent
  // migrations landed (or where _migrations was stamped without the table
  // actually being created) — without this, an agent like Robert hard-fails
  // mid-cycle with `relation "robert_runs" does not exist`. Idempotent and a
  // fast no-op once applied.
  try {
    const { ensureAgentSubsystemTables } = await import('../../utils/ensureAgentSubsystemTables.js')
    await ensureAgentSubsystemTables(db, { logger: console })
  } catch (ensureErr) {
    console.warn(`[agent-control] ensureAgentSubsystemTables failed (continuing): ${ensureErr?.message || ensureErr}`)
  }

  let stoppedRequested = false
  let emergency = false
  let partial = false
  let pauseRequested = false
  let runError = null
  const stepResults = []
  let totalWork = 0

  // Everything from here is wrapped so the lock is ALWAYS released on the way
  // out — happy path, agent failure, OR an unexpected exception in the loop /
  // finalization. The only exception is an intentional pause `return` inside
  // the loop, which deliberately keeps the lock so resume can continue (the
  // lock's TTL is the safety net if resume never comes).
  try {
  while (true) {
    // Refresh run-wide stop signal between every step. Agent-scoped stops are
    // consumed only by that agent's live signal and never terminate the fleet.
    const stopReq = await latestUnfulfilledStop(db, runId, { runWideOnly: true })
    if (stopReq) {
      if (stopReq.request_type === 'pause') {
        pauseRequested = true
        await setRunStatus(db, runId, 'paused')
        await recordEvent(db, {
          controlRunId: runId,
          eventType: 'control.run.paused',
          severity: 'medium',
          message: 'Run paused; remaining steps held in queue.',
        })
        // Pause is not terminal — we exit the loop and a future
        // resumeRun() call will re-invoke executeRun().
        return
      }
      if (stopReq.request_type === 'graceful_stop' || stopReq.request_type === 'cancel') {
        stoppedRequested = true
      }
      if (stopReq.request_type === 'emergency_stop') {
        stoppedRequested = true
        emergency = true
      }
    }

    if (stoppedRequested) break

    const steps = await listSteps(db, runId)
    const next = steps.find((s) => s.status === 'queued')
    if (!next) break

    const adapter = getAdapter(next.agent_name)
    if (!adapter) {
      await setStepStatus(db, next.id, 'failed', {
        errorMessage: `No adapter registered for agent "${next.agent_name}"`,
      })
      await recordEvent(db, {
        controlRunId: runId,
        stepId: next.id,
        agentName: next.agent_name,
        eventType: 'control.step.adapter_missing',
        severity: 'high',
        message: `No adapter for ${next.agent_name}`,
      })
      stepResults.push({ step: next, ok: false, status: 'failed' })
      runError = `Missing adapter: ${next.agent_name}`
      break
    }

    await setStepStatus(db, next.id, 'running')
    await recordEvent(db, {
      controlRunId: runId,
      stepId: next.id,
      agentName: next.agent_name,
      eventType: 'control.step.started',
      severity: 'info',
      message: `${next.agent_name} (${next.step_name}) started`,
    })

    const stage = (next.progress?.stage) || (next.step_name?.endsWith('preflight') ? 'preflight'
      : next.step_name?.endsWith('postflight') ? 'postflight'
      : 'main')

    let agentStopRequested = false
    let signalRefreshInFlight = false
    const refreshStepControl = async () => {
      if (signalRefreshInFlight) return
      signalRefreshInFlight = true
      try {
        const request = await latestUnfulfilledStop(db, runId, { agentName: next.agent_name })
        if (!request) return
        const agentScoped = Boolean(request.agent_name)
        if (request.request_type === 'pause' && !agentScoped) pauseRequested = true
        if (request.request_type === 'graceful_stop' || request.request_type === 'cancel') {
          if (agentScoped) agentStopRequested = true
          else stoppedRequested = true
        }
        if (request.request_type === 'emergency_stop') {
          stoppedRequested = true
          emergency = true
        }
      } finally {
        signalRefreshInFlight = false
      }
    }
    await refreshStepControl()
    const controlPollTimer = setInterval(() => {
      void refreshStepControl().catch(() => {})
    }, 100)
    controlPollTimer.unref?.()

    const signal = makeSignal({
      runId,
      stepId: next.id,
      agentName: next.agent_name,
      // Pause is distinct from stop: adapters may finish their current atomic
      // unit and return paused so Resume can requeue the same durable step.
      shouldStop: () => emergency || stoppedRequested || agentStopRequested,
      shouldPause: () => pauseRequested,
      isEmergency: () => emergency,
      heartbeat: async (progress) => heartbeat(db, next.id, progress),
      recordEvent: async (args) => recordEvent(db, {
        ...args,
        controlRunId: runId,
        stepId: next.id,
        agentName: next.agent_name,
      }),
    })

    let result
    try {
      result = await adapter.start({
        db,
        controlRunId: runId,
        stepId: next.id,
        options: run.options || {},
        stage,
        signal,
      })
    } catch (err) {
      result = {
        ok: false,
        status: 'failed',
        error: err?.message || String(err),
        summary: { agent: next.agent_name, error: String(err?.message || err) },
      }
    } finally {
      clearInterval(controlPollTimer)
      await refreshStepControl().catch(() => {})
    }

    const status = (() => {
      if (result?.status === 'blocked') return 'blocked'
      if (result?.status === 'skipped') return 'skipped'
      if (result?.status === 'stopped') return 'stopped'
      if (result?.status === 'paused') return 'paused'
      if (result?.status === 'failed') return 'failed'
      return result?.ok === false ? 'failed' : 'completed'
    })()

    await setStepStatus(db, next.id, status, {
      result: result?.summary || null,
      errorMessage: result?.error || null,
    })

    await recordEvent(db, {
      controlRunId: runId,
      stepId: next.id,
      agentName: next.agent_name,
      eventType: status === 'failed' ? 'control.step.failed'
        : status === 'blocked' ? 'control.step.blocked'
        : status === 'stopped' ? 'control.step.stopped'
        : status === 'paused' ? 'control.step.paused'
        : status === 'skipped' ? 'control.step.skipped'
        : 'control.step.completed',
      severity: status === 'failed' ? 'high' : status === 'blocked' ? 'high' : 'info',
      message: `${next.agent_name} (${next.step_name}) ${status}`,
      data: result?.summary || null,
    })

    stepResults.push({ step: next, ok: result?.ok !== false, status, result })

    // Emit a REAL unified telemetry event (agent_activity_events) so Mission
    // Control's timeline + per-agent metrics reflect this actual execution
    // instead of the synthetic fallback. The event's status is 'succeeded' only
    // when the agent persisted real work; 'noop' when it ran clean but did
    // nothing — that honesty also drives the run's final status below.
    const work = countAgentWork(next.agent_name, result?.summary)
    if (status === 'completed') totalWork += work
    const activityStatus = status === 'completed'
      ? (work > 0 ? 'succeeded' : 'noop')
      : (status === 'failed' ? 'failed'
        : status === 'blocked' ? 'blocked'
        : status === 'stopped' ? 'stopped'
        : status === 'paused' ? 'paused'
        : status === 'skipped' ? 'skipped'
        : status)
    await insertActivityEvent(db, {
      agent_name: next.agent_name,
      event_type: `agent.${next.agent_name}.${stage}`,
      status: activityStatus,
      severity: status === 'failed' ? 'high' : status === 'blocked' ? 'medium' : 'info',
      title: `${next.agent_name} ${next.step_name} ${activityStatus}`,
      description: result?.error || null,
      metric_key: 'work_units',
      metric_value: work,
      entity_type: 'agent_control_run',
      entity_id: runId,
      details_json: result?.summary || {},
    }).catch(() => { /* telemetry is best-effort; never fail a run on it */ })

    // If an agent failed and stop_on_agent_failure is set, end the run.
    if (status === 'failed') {
      await notifyAgentFailed(db, run, next.agent_name, result?.error || 'unknown')
      if (run.options?.stop_on_agent_failure) {
        runError = `Agent ${next.agent_name} failed: ${result?.error || 'unknown'}`
        break
      }
    }

    if (status === 'blocked') {
      await notifyAgentBlocked(db, run, next.agent_name, result?.blocked_reason || 'blocked')
      // Sam preflight blocking ends the cycle so the rest of the agents
      // don't run on a critical-finding system.
      if (next.agent_name === 'sam' && next.step_name === 'sam_preflight') {
        runError = `Sam preflight blocked: ${result?.blocked_reason || 'critical findings'}`
        break
      }
    }

    if (status === 'paused') {
      await setRunStatus(db, runId, 'paused')
      await recordEvent(db, {
        controlRunId: runId,
        eventType: 'control.run.paused',
        severity: 'medium',
        message: `Run paused after ${next.agent_name}; the same durable step will resume.`,
      })
      return
    }

    if (status === 'stopped' && !agentStopRequested) {
      stoppedRequested = true
      partial = true
    }

    // Refresh run before looping — pause/stop may have arrived during
    // a long-running step.
  }

  // Any in-flight step wasn't cleanly ended? Mark it stopped.
  let stepsAfter = await listSteps(db, runId)
  const persistedTotalWork = stepsAfter.reduce(
    (sum, step) => sum + (step.status === 'completed' ? countAgentWork(step.agent_name, step.result) : 0),
    0,
  )
  const failedSteps = stepsAfter.filter((step) => step.status === 'failed')
  for (const s of stepsAfter) {
    if (s.status === 'queued' && stoppedRequested) {
      await setStepStatus(db, s.id, 'skipped', { errorMessage: emergency ? 'emergency_stop' : 'stop_requested' })
    }
  }
  // Re-read after terminalizing queued steps so the persisted summary reports
  // their actual final states instead of stale "queued" snapshots.
  stepsAfter = await listSteps(db, runId)

  // Resolve final run status. If a previous command (cancelRun /
  // emergencyStopRun) already set the run to a terminal state, respect
  // that — we should not downgrade `cancelled` → `stopped` just because
  // the orchestrator loop noticed a graceful_stop request along the way.
  const TERMINAL = new Set(['completed', 'completed_noop', 'failed', 'cancelled', 'stopped', 'partial_stop', 'stop_failed'])
  const currentRun = await getRun(db, runId)
  let finalStatus
  if (currentRun && TERMINAL.has(currentRun.status)) {
    finalStatus = currentRun.status
  } else if (emergency) {
    const stillRunning = stepsAfter.some((s) => s.status === 'running')
    finalStatus = stillRunning ? 'partial_stop' : 'stopped'
  } else if (stoppedRequested) {
    finalStatus = 'stopped'
  } else if (runError || failedSteps.length > 0) {
    finalStatus = 'failed'
    if (!runError) {
      runError = `${failedSteps.length} agent step(s) failed: ${failedSteps.map((step) => step.agent_name).join(', ')}`
    }
  } else if (persistedTotalWork > 0 || totalWork > 0) {
    finalStatus = 'completed'
  } else {
    // Acceptance/verification: the agents executed without error but none
    // persisted any real work. Report that honestly instead of a hollow
    // "completed" so the dashboard never claims work that didn't happen.
    finalStatus = 'completed_noop'
  }

  await setRunStatus(db, runId, finalStatus, {
    errorMessage: runError || null,
    summary: {
      step_results: stepsAfter.map((step) => ({
        agent: step.agent_name,
        step: step.step_name,
        status: step.status,
        ok: !['failed', 'blocked', 'stopped'].includes(step.status),
      })),
      stopped: stoppedRequested,
      emergency,
      partial,
    },
  })

  await releaseLock(db, { controlRunId: runId })

  // Mark stop/cancel requests fulfilled now that we've acted on them.
  await fulfillStopRequestsByType(db, runId, 'graceful_stop')
  await fulfillStopRequestsByType(db, runId, 'emergency_stop')
  await fulfillStopRequestsByType(db, runId, 'cancel')

  const finalRun = await getRun(db, runId)
  if (finalStatus === 'completed') {
    await notifyCompleted(db, finalRun, finalRun?.summary || {})
  } else if (finalStatus === 'failed') {
    await notifyFailed(db, finalRun, runError || 'unknown error')
  } else if (finalStatus === 'stopped' || finalStatus === 'partial_stop') {
    if (!emergency) await notifyStopped(db, finalRun, { partial: finalStatus === 'partial_stop' })
  }

  await recordEvent(db, {
    controlRunId: runId,
    eventType: `control.run.${finalStatus}`,
    severity: finalStatus === 'failed' ? 'high' : finalStatus === 'partial_stop' ? 'high' : 'info',
    message: `Run finished with status: ${finalStatus}`,
    data: { final_status: finalStatus, error: runError, emergency, stopped: stoppedRequested },
  })
  } catch (runtimeErr) {
    // Unexpected failure anywhere in the loop or finalization. Never leak the
    // lock: drive the run to `failed` (unless a stop/cancel command already
    // moved it terminal) and release. The TTL would eventually reclaim it,
    // but releasing now lets the next run for this agent start immediately.
    qualityLog.error('[agent-control] executeRun fatal:', runtimeErr?.message || runtimeErr)
    try {
      const cur = await getRun(db, runId)
      const TERMINAL = new Set(['completed', 'completed_noop', 'failed', 'cancelled', 'stopped', 'partial_stop', 'stop_failed'])
      if (!cur || !TERMINAL.has(cur.status)) {
        await setRunStatus(db, runId, 'failed', {
          errorMessage: `Orchestrator crashed: ${runtimeErr?.message || runtimeErr}`,
        })
      }
    } catch { /* best-effort */ }
    await releaseLock(db, { controlRunId: runId }).catch(() => {})
    try {
      await recordEvent(db, {
        controlRunId: runId,
        eventType: 'control.run.crashed',
        severity: 'critical',
        message: `Orchestrator crashed: ${runtimeErr?.message || runtimeErr}`,
      })
    } catch { /* best-effort */ }
  }
}
