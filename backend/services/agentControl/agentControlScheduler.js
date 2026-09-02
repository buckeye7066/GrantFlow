/**
 * Background scheduler for the canonical Agent Control Center cycle.
 *
 * The scheduled_cycle run has long been part of the public contract, but no
 * runtime ever started one. This scheduler completes that path through the
 * existing orchestrator so every run is durable, auditable, lock-protected,
 * stoppable, and governed by each adapter's existing consent boundaries.
 *
 * Defaults:
 *   - ON in deployed production; explicit true also enables local/dev
 *   - disable with AGENT_CONTROL_SCHEDULED_ENABLED=false
 *   - every 6 hours (minimum 15 minutes)
 *   - first cycle 60 seconds after boot
 */
import { startScheduledCycle } from './agentControlOrchestrator.js'

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000
const MIN_INTERVAL_MS = 15 * 60 * 1000
const DEFAULT_INITIAL_DELAY_MS = 60 * 1000
const MIN_INITIAL_DELAY_MS = 10 * 1000

let intervalTimer = null
let kickoffTimer = null
let running = false
let stopped = false

function isTrue(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim())
}

function isFalse(value) {
  return /^(0|false|no|off)$/i.test(String(value || '').trim())
}

function isDeployedRuntime() {
  return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production'
    || Boolean(String(process.env.RAILWAY_ENVIRONMENT_ID || '').trim())
    || Boolean(String(process.env.RAILWAY_DEPLOYMENT_ID || '').trim())
}

export function shouldRunScheduledAgentCycles() {
  const configured = process.env.AGENT_CONTROL_SCHEDULED_ENABLED
  if (isFalse(configured)) return false
  if (isTrue(configured)) return true
  return isDeployedRuntime()
}

export function resolveScheduledCycleIntervalMs() {
  const raw = Number.parseInt(process.env.AGENT_CONTROL_SCHEDULE_INTERVAL_MS || '', 10)
  if (!Number.isInteger(raw) || raw <= 0) return DEFAULT_INTERVAL_MS
  return Math.max(MIN_INTERVAL_MS, raw)
}

export function resolveScheduledCycleInitialDelayMs() {
  const raw = Number.parseInt(process.env.AGENT_CONTROL_SCHEDULE_INITIAL_DELAY_MS || '', 10)
  if (!Number.isInteger(raw) || raw < 0) return DEFAULT_INITIAL_DELAY_MS
  return Math.max(MIN_INITIAL_DELAY_MS, raw)
}

export async function runScheduledAgentCycleTick({
  db,
  logger = console,
  startCycle = startScheduledCycle,
} = {}) {
  if (!db) return { skipped: true, reason: 'database_unavailable' }
  if (stopped) return { skipped: true, reason: 'stopped' }
  if (running) return { skipped: true, reason: 'overlap' }
  if (!shouldRunScheduledAgentCycles()) return { skipped: true, reason: 'disabled' }

  running = true
  try {
    const result = await startCycle(db, {
      options: {
        scheduled: true,
        skip_if_locked: true,
        lock_acquire_retries: 0,
        run_name: 'Scheduled background agent cycle',
      },
    })
    if (result?.skipped) {
      logger?.info?.('[agent-control:scheduler] cycle skipped:', result.reason || 'already_running')
    } else {
      logger?.info?.('[agent-control:scheduler] cycle queued', {
        run_id: result?.run?.id || null,
        run_type: result?.run?.run_type || 'scheduled_cycle',
      })
    }
    return result
  } catch (err) {
    logger?.warn?.('[agent-control:scheduler] cycle failed to start:', err?.message || err)
    return { failed: true, error: err?.message || String(err) }
  } finally {
    running = false
  }
}

export function startAgentControlScheduler({ db, logger = console } = {}) {
  stopped = false
  if (intervalTimer) return { started: false, reason: 'already_started' }
  if (!db) return { started: false, reason: 'database_unavailable' }
  if (!shouldRunScheduledAgentCycles()) return { started: false, reason: 'disabled' }

  const intervalMs = resolveScheduledCycleIntervalMs()
  const initialDelayMs = resolveScheduledCycleInitialDelayMs()
  intervalTimer = setInterval(() => {
    runScheduledAgentCycleTick({ db, logger }).catch(() => {})
  }, intervalMs)
  intervalTimer?.unref?.()

  kickoffTimer = setTimeout(() => {
    kickoffTimer = null
    runScheduledAgentCycleTick({ db, logger }).catch(() => {})
  }, initialDelayMs)
  kickoffTimer?.unref?.()

  return { started: true, intervalMs, initialDelayMs }
}

export function stopAgentControlScheduler() {
  stopped = true
  if (intervalTimer) clearInterval(intervalTimer)
  if (kickoffTimer) clearTimeout(kickoffTimer)
  const hadTimer = Boolean(intervalTimer || kickoffTimer)
  intervalTimer = null
  kickoffTimer = null
  return { stopped: hadTimer }
}

export function resetAgentControlSchedulerForTests() {
  stopAgentControlScheduler()
  stopped = false
  running = false
}
