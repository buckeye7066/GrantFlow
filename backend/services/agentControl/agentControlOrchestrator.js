/**
 * agentControlOrchestrator.js
 *
 * The Admin Agent Control Center orchestrator. Coordinates Sam, Robert,
 * Yana (Client Discovery, NOT Hamilton), John, and Hamilton (Application
 * Autopilot) through their adapter contracts.
 *
 * Single canonical admin / operator: buckeye7066@gmail.com.
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
  CANONICAL_ADMIN_EMAIL_DEFAULT,
  DEFAULT_RUN_OPTIONS,
  FULL_CYCLE_LOCK,
  FULL_CYCLE_ORDER,
  RUN_TYPES,
  agentLockName,
  resolveAgentsForRun,
} from './agentControlTypes.js'
import {
  createRun,
  createSteps,
  ensureSchema,
  fulfillStopRequestsByType,
  getActiveRun,
  getRun,
  heartbeat,
  latestUnfulfilledStop,
  listSteps,
  recordEvent,
  recordStopRequest,
  releaseLock,
  setRunStatus,
  setStepStatus,
  tryAcquireLock,
} from './agentControlStore.js'
import { getAdapter } from './agentAdapters/agentAdapterRegistry.js'
import { makeSignal } from './agentAdapters/baseAgentAdapter.js'
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

const ADMIN_EMAIL = (process.env.AGENT_CONTROL_ADMIN_EMAIL
  || process.env.ADMIN_EMAIL
  || CANONICAL_ADMIN_EMAIL_DEFAULT).trim().toLowerCase()

/**
 * Verifies the caller is the canonical admin. We accept either:
 *   1. authenticated user.email === buckeye7066@gmail.com (default)
 *   2. ADMIN_EMAIL env override (defaults to buckeye7066@gmail.com)
 *   3. AGENT_CONTROL_ADMIN_EMAIL env override (preferred over ADMIN_EMAIL)
 * Anything else (role checks, allowlists, etc.) is REJECTED. The whole
 * Control Center is intentionally restricted to this single account.
 */
export function isControlCenterAdmin(user) {
  if (!user) return false
  const email = String(user.email || user.primary_email || '').trim().toLowerCase()
  if (!email) return false
  return email === ADMIN_EMAIL
}

export function getCanonicalAdminEmail() { return ADMIN_EMAIL }

/**
 * Build the ordered step plan for a run. Sam pre/postflight only fire
 * for full_cycle / selected_agents runs that include sam.
 */
function buildStepPlan(runType, agents, options) {
  const sel = new Set(agents)
  const includeSam = sel.has('sam')
  const plan = []
  let order = 0

  if ((runType === 'full_cycle' || runType === 'selected_agents' || runType === 'sam_only')
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

  if ((runType === 'full_cycle' || runType === 'selected_agents' || runType === 'sam_only')
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

  const mergedOptions = { ...DEFAULT_RUN_OPTIONS, ...(options || {}) }

  // Single full_cycle at a time. We check the active run first for a
  // friendlier error, then back it up with the lock so concurrent calls
  // can't race past us.
  if (runType === 'full_cycle') {
    const active = await getActiveRun(db)
    if (active && active.run_type === 'full_cycle') {
      const e = new Error(`A full_cycle run is already in progress (id=${active.id}).`)
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

  // Acquire the appropriate lock. For full_cycle we lock everything;
  // for other run types we lock the per-agent name so individual runs
  // can't overlap with each other (but they can overlap with a
  // full_cycle if explicitly allowed).
  const lockName = runType === 'full_cycle'
    ? FULL_CYCLE_LOCK
    : (resolvedAgents.length === 1 ? agentLockName(resolvedAgents[0]) : null)

  if (lockName) {
    const acquired = await tryAcquireLock(db, {
      lockName,
      controlRunId: runId,
      acquiredBy: user?.email || ADMIN_EMAIL,
      ttlMs: Math.max(60_000, Number(mergedOptions.max_runtime_minutes) * 60_000 || 60 * 60_000),
    })
    if (!acquired) {
      await setRunStatus(db, runId, 'failed', { errorMessage: `Could not acquire lock "${lockName}".` })
      const e = new Error(`Lock "${lockName}" already held by another run.`)
      e.status = 409
      throw e
    }
  }

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
    console.error('[agent-control] executeRun crashed:', err?.message || err)
  })

  const steps = await listSteps(db, runId)
  return { run, steps }
}

// ---------------------------------------------------------------------------
// Stop / pause / resume command surface
// ---------------------------------------------------------------------------
export async function pauseRun(db, runId, { user = null, reason = null } = {}) {
  if (!isControlCenterAdmin(user)) { const e = new Error('admin only'); e.status = 403; throw e }
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
  await recordStopRequest(db, {
    controlRunId: runId,
    requestType: 'resume',
    requestedByEmail: user?.email,
    requestedByUserId: user?.userId,
  })
  // Mark the existing pause requests fulfilled so the next poll sees
  // the resume state cleanly.
  await fulfillStopRequestsByType(db, runId, 'pause')
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
    console.error('[agent-control] executeRun (resume) crashed:', err?.message || err)
  })

  return run
}

export async function stopRun(db, runId, { user = null, reason = null } = {}) {
  if (!isControlCenterAdmin(user)) { const e = new Error('admin only'); e.status = 403; throw e }
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
  for (const name of ALL_AGENTS) {
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
export async function executeRun({ db, runId } = {}) {
  if (!db || !runId) return
  const run = await getRun(db, runId)
  if (!run) return

  const finalStates = ['completed', 'failed', 'cancelled', 'stopped', 'partial_stop', 'stop_failed']
  if (finalStates.includes(run.status)) return

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

  while (true) {
    // Refresh stop signal between every step.
    const stopReq = await latestUnfulfilledStop(db, runId)
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

    const signal = makeSignal({
      runId,
      stepId: next.id,
      agentName: next.agent_name,
      shouldStop: () => emergency || stoppedRequested || pauseRequested,
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
    }

    const status = (() => {
      if (result?.status === 'blocked') return 'blocked'
      if (result?.status === 'skipped') return 'skipped'
      if (result?.status === 'stopped') return 'stopped'
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
        : status === 'skipped' ? 'control.step.skipped'
        : 'control.step.completed',
      severity: status === 'failed' ? 'high' : status === 'blocked' ? 'high' : 'info',
      message: `${next.agent_name} (${next.step_name}) ${status}`,
      data: result?.summary || null,
    })

    stepResults.push({ step: next, ok: result?.ok !== false, status, result })

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

    if (status === 'stopped') {
      stoppedRequested = true
      partial = true
    }

    // Refresh run before looping — pause/stop may have arrived during
    // a long-running step.
  }

  // Any in-flight step wasn't cleanly ended? Mark it stopped.
  const stepsAfter = await listSteps(db, runId)
  for (const s of stepsAfter) {
    if (s.status === 'queued' && stoppedRequested) {
      await setStepStatus(db, s.id, 'skipped', { errorMessage: emergency ? 'emergency_stop' : 'stop_requested' })
    }
  }

  // Resolve final run status. If a previous command (cancelRun /
  // emergencyStopRun) already set the run to a terminal state, respect
  // that — we should not downgrade `cancelled` → `stopped` just because
  // the orchestrator loop noticed a graceful_stop request along the way.
  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'stopped', 'partial_stop', 'stop_failed'])
  const currentRun = await getRun(db, runId)
  let finalStatus
  if (currentRun && TERMINAL.has(currentRun.status)) {
    finalStatus = currentRun.status
  } else if (emergency) {
    const stillRunning = stepsAfter.some((s) => s.status === 'running')
    finalStatus = stillRunning ? 'partial_stop' : 'stopped'
  } else if (stoppedRequested) {
    finalStatus = 'stopped'
  } else if (runError) {
    finalStatus = 'failed'
  } else {
    finalStatus = 'completed'
  }

  await setRunStatus(db, runId, finalStatus, {
    errorMessage: runError || null,
    summary: {
      step_results: stepResults.map((r) => ({
        agent: r.step.agent_name,
        step: r.step.step_name,
        status: r.status,
        ok: r.ok,
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
}
