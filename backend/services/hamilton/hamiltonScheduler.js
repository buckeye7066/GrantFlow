/**
 * hamiltonScheduler.js
 *
 * Optional, opt-in background runner for Hamilton (Application Autopilot).
 *
 * WHY THIS EXISTS
 * ---------------
 * The orchestrator defers out-of-window AUTONOMOUS portal runs to
 * status='waiting_for_window' with next_retry_at = the next window start
 * (see hamiltonAutomationOrchestrator.js). The thing that actually RE-PICKS
 * those due tasks is HamiltonAgentAdapter.start(): it SELECTs
 *   application_tasks WHERE status='waiting_for_window'
 *     AND next_retry_at <= now()
 * (alongside queued/auth-blocked tasks) and re-invokes automateSingleSource
 * with options.autonomous=true.
 *
 * That adapter was only ever invoked by a manually-created Agent Control
 * run, so without this scheduler nothing re-attempts deferred portal runs
 * when their window opens — the task just sits at waiting_for_window forever.
 * This tiny poller closes that gap by driving the same adapter on a timer,
 * exactly like robert/yana/john/sam have their own schedulers.
 *
 * EVERYTHING IS OFF BY DEFAULT.
 *
 * Env contract:
 *   HAMILTON_RUN_ON_SCHEDULE=false           master switch for this poller
 *   HAMILTON_ENABLE_BROWSER_AUTOMATION=true  REQUIRED — the scheduler only
 *                                            arms when browser automation is
 *                                            globally enabled, so a disabled
 *                                            fleet never auto-drives portals
 *   HAMILTON_SCHEDULE_INTERVAL_MS=300000     poll cadence (default 5 min,
 *                                            floored at 60s)
 *   HAMILTON_SCHEDULE_BATCH_SIZE=5           tasks per tick (1..25)
 *
 * It never throws on the hot path, never overlaps two runs, and never pins
 * the event loop open (timer is unref'd).
 */

import { HamiltonAgentAdapter } from '../agentControl/agentAdapters/hamiltonAgentAdapter.js'
import { isBrowserAutomationEnabled } from './hamiltonAutomationOrchestrator.js'
import { runWithSchedulerLock } from '../schedulerLock.js'

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000
const MIN_INTERVAL_MS = 60 * 1000

let timer = null
let running = false
let stopped = false

function isTrue(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim())
}

export function shouldRunOnSchedule() {
  // Both gates must be on: the operator opted Hamilton into scheduled runs AND
  // browser automation is globally enabled. The browser-automation gate is the
  // same authority the orchestrator enforces before opening a browser, so we
  // never silently arm a poller that the rest of the system would refuse.
  return isTrue(process.env.HAMILTON_RUN_ON_SCHEDULE) && isBrowserAutomationEnabled()
}

export function resolveIntervalMs() {
  const raw = Number.parseInt(process.env.HAMILTON_SCHEDULE_INTERVAL_MS || '', 10)
  if (!Number.isInteger(raw) || raw <= 0) return DEFAULT_INTERVAL_MS
  return Math.max(MIN_INTERVAL_MS, raw)
}

export function resolveBatchSize() {
  const raw = Number.parseInt(process.env.HAMILTON_SCHEDULE_BATCH_SIZE || '', 10)
  if (!Number.isInteger(raw) || raw <= 0) return 5
  return Math.max(1, Math.min(25, raw))
}

/**
 * Run one Hamilton tick: drive the existing adapter, which re-picks due
 * waiting_for_window (+ queued/auth-blocked) tasks and re-runs the
 * orchestrator with autonomous=true. The adapter is the single source of
 * truth for which tasks are due and how they run — we never duplicate that
 * SELECT here.
 */
async function tick({ db, logger = console } = {}) {
  if (stopped || running) return { skipped: true, reason: running ? 'overlap' : 'stopped' }
  // Re-check the gate every tick so an operator can flip it off at runtime
  // without restarting the server.
  if (!shouldRunOnSchedule()) return { skipped: true, reason: 'disabled' }

  running = true
  try {
    const result = await runWithSchedulerLock(db, {
      lockName: 'hamilton:autopilot',
      ttlMs: 30 * 60 * 1000,
      logger,
    }, async () => {
      const adapter = new HamiltonAgentAdapter()
      // Provide an inert signal: this is a headless scheduled run with no Agent
      // Control run row, so there is no stop/pause channel and heartbeats/events
      // are no-ops. The adapter already tolerates an absent/partial signal.
      return await adapter.start({
        db,
        controlRunId: null,
        stepId: null,
        options: {
          allow_hamilton_autopilot: true,
          hamilton_batch_size: resolveBatchSize(),
        },
        signal: {
          shouldStop: () => stopped,
          shouldPause: () => false,
          isEmergency: () => false,
          heartbeat: async () => {},
          recordEvent: async () => {},
        },
      })
    })
    if (result?.skipped) return result
    const summary = result?.summary || {}
    if ((summary.attempted || 0) > 0) {
      logger?.info?.('[hamilton:scheduler] tick', {
        attempted: summary.attempted,
        processed: summary.processed,
        failed: summary.failed,
        blocked: summary.blocked,
      })
    }
    return { ran: true, result }
  } catch (err) {
    logger?.warn?.('[hamilton:scheduler] tick failed:', err?.message || err)
    return { ran: false, error: err?.message || String(err) }
  } finally {
    running = false
  }
}

/**
 * Arm the poller if the env gates allow. Safe to call multiple times; a second
 * call while already armed is a no-op. Returns a small status object mirroring
 * the other agent schedulers.
 */
export function startHamiltonScheduler({ db, logger = console } = {}) {
  stopped = false
  if (timer) return { started: false, reason: 'already_started' }
  if (!isTrue(process.env.HAMILTON_RUN_ON_SCHEDULE)) {
    return { started: false, reason: 'HAMILTON_RUN_ON_SCHEDULE!=true' }
  }
  if (!isBrowserAutomationEnabled()) {
    return { started: false, reason: 'HAMILTON_ENABLE_BROWSER_AUTOMATION!=true' }
  }

  const intervalMs = resolveIntervalMs()
  timer = setInterval(() => {
    tick({ db, logger }).catch(() => {})
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return { started: true, intervalMs, batchSize: resolveBatchSize() }
}

export function stopHamiltonScheduler() {
  stopped = true
  if (timer) {
    clearInterval(timer)
    timer = null
    return { stopped: true }
  }
  return { stopped: false }
}

// Test-only: clear the module-level run/stop flags so a test that drives
// tick() directly isn't affected by a prior stopHamiltonScheduler() call.
function _resetState() {
  stopped = false
  running = false
}

export const __testing__ = {
  tick,
  shouldRunOnSchedule,
  resolveIntervalMs,
  resolveBatchSize,
  _resetState,
}
