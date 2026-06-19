/**
 * Larry — env-gated scheduler.
 *
 * ⚠️  DEPRECATED ⚠️
 * Larry's role (Client/Lead Discovery + outreach pipeline) has been
 * succeeded by Yana + John in the canonical agent registry
 * (backend/services/agentControl/agentControlTypes.js — ALL_AGENTS =
 * ['sam', 'robert', 'yana', 'john', 'hamilton'], with Larry NOT
 * listed). Yana is the lead-discovery agent; John handles outreach.
 *
 * Larry is kept ONLY for backward compatibility with deployments that
 * still set LARRY_ENABLED=true. The scheduler now refuses to start
 * when YANA_ENABLED is also truthy because both pipelines would
 * double-discover the same prospects into different tables (and
 * Larry runs outside Mission Control, so cancel/pause/emergency-stop
 * don't reach it). Operators see a clear log line directing them to
 * the Yana flags.
 *
 * Wakes Larry up periodically when LARRY_ENABLED=true and
 * LARRY_RUN_ON_SCHEDULE=true. Default state is DISABLED. Even when scheduled,
 * the scheduler defaults to discovery+verify+score modes — never auto-send.
 *
 * The scheduler:
 *   - never blocks server startup
 *   - never crashes the host process if a run fails
 *   - never overlaps runs (single in-process lock)
 *   - never bypasses the agent's normal safety gates (which already include
 *     send-approval, suppression, DNC, etc.)
 *
 * The cron parser is intentionally simple — it understands the same five
 * fields cron does (minute hour dayOfMonth month dayOfWeek) but only the
 * subset we actually use: `*`, `*\/N`, comma lists, and digit values. That
 * keeps us off a third-party cron dep just for one feature flag.
 */

import { getLarryConfig } from './larrySafety.js'
import { LARRY_MODES, LARRY_TRIGGERS } from './larryTypes.js'
import { runLarry } from './larryAgent.js'

const STATE = {
  started: false,
  running: false,
  timer: null,
  lastRunAt: null,
  lastResult: null,
}

function logger(externalLogger) {
  if (externalLogger && typeof externalLogger === 'object') return externalLogger
  return console
}

export function parseSchedule(spec) {
  const fallback = { minute: 0, hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' }
  if (!spec || typeof spec !== 'string') return fallback
  const parts = spec.trim().split(/\s+/)
  if (parts.length !== 5) return fallback
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts
  return { minute, hour, dayOfMonth, month, dayOfWeek }
}

function fieldMatches(field, value) {
  if (field === '*') return true
  if (field.startsWith('*/')) {
    const step = Number.parseInt(field.slice(2), 10)
    if (!Number.isFinite(step) || step <= 0) return false
    return value % step === 0
  }
  if (field.includes(',')) {
    return field
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .some((n) => n === value)
  }
  const n = Number.parseInt(field, 10)
  return Number.isFinite(n) && n === value
}

export function isCronMinuteMatch(spec, date = new Date()) {
  const parsed = parseSchedule(spec)
  return (
    fieldMatches(parsed.minute, date.getMinutes()) &&
    fieldMatches(parsed.hour, date.getHours()) &&
    fieldMatches(parsed.dayOfMonth, date.getDate()) &&
    fieldMatches(parsed.month, date.getMonth() + 1) &&
    fieldMatches(parsed.dayOfWeek, date.getDay())
  )
}

/**
 * Detect whether Yana — the canonical successor — is also enabled.
 * Mirrors getYanaConfig.enabled without importing Yana directly so
 * Larry has zero runtime coupling to the new agent. Pure env read.
 */
function isYanaEnabled(env = process.env) {
  const raw = String(env?.YANA_ENABLED ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

export function startLarryScheduler({
  db,
  deps = {},
  logger: externalLogger = null,
  env = process.env,
} = {}) {
  const cfg = getLarryConfig()
  const log = logger(externalLogger)

  if (!cfg.enabled) {
    return { started: false, reason: 'LARRY_ENABLED=false' }
  }

  // Deprecation guard: Yana is the canonical lead-discovery agent in
  // ALL_AGENTS. If both schedulers came up, they'd double-discover the
  // same prospects into different tables (`yana_lead_candidates` vs
  // `larry_*`) and only Yana is reachable from the Agent Control
  // Center. Refuse to start so operators see the conflict instead of
  // silently paying for it.
  if (isYanaEnabled(env)) {
    const msg =
      '[Larry/scheduler] DEPRECATED: refusing to start because YANA_ENABLED=true. ' +
      'Larry has been superseded by Yana (lead discovery) + John (outreach). ' +
      'Set LARRY_ENABLED=false and configure YANA_* / JOHN_* flags instead.'
    if (typeof log.warn === 'function') log.warn(msg)
    else log.info?.(msg)
    return {
      started: false,
      reason: 'deprecated_superseded_by_yana',
      detail: 'YANA_ENABLED=true; Larry refuses to run alongside Yana',
    }
  }

  // Standalone Larry boot — still functional, but warn the operator
  // that this is the deprecated path so it doesn't go unnoticed.
  const deprecationNotice =
    '[Larry/scheduler] DEPRECATION NOTICE: Larry is superseded by Yana + John. ' +
    'Migrate to YANA_ENABLED / JOHN_ENABLED for unified Mission Control coverage.'
  if (typeof log.warn === 'function') log.warn(deprecationNotice)
  else log.info?.(deprecationNotice)

  if (!cfg.runOnSchedule && !cfg.runOnStartup) {
    return { started: false, reason: 'LARRY_RUN_ON_SCHEDULE=false and LARRY_RUN_ON_STARTUP=false' }
  }
  if (STATE.started) {
    return { started: false, reason: 'already_started' }
  }
  STATE.started = true

  async function runOnce(trigger) {
    if (STATE.running) {
      log.info?.('[Larry/scheduler] skip: already running')
      return
    }
    STATE.running = true
    try {
      const result = await runLarry({
        db,
        mode: deps.scheduledMode || LARRY_MODES.SCORE_FIT,
        trigger,
        options: deps.scheduledOptions || {},
      })
      STATE.lastRunAt = new Date().toISOString()
      STATE.lastResult = { ok: result?.ok, run_id: result?.run_id, mode: result?.mode }
      log.info?.('[Larry/scheduler] run complete', STATE.lastResult)
    } catch (err) {
      log.warn?.('[Larry/scheduler] run failed', { error: err?.message || String(err) })
      STATE.lastResult = { ok: false, error: err?.message || String(err) }
    } finally {
      STATE.running = false
    }
  }

  if (cfg.runOnStartup) {
    setTimeout(() => {
      runOnce(LARRY_TRIGGERS.STARTUP).catch(() => {})
    }, 5000)
  }

  if (cfg.runOnSchedule) {
    const nextTickMs = (60 - new Date().getSeconds()) * 1000 + 50
    STATE.timer = setTimeout(function tick() {
      try {
        if (isCronMinuteMatch(cfg.schedule, new Date())) {
          runOnce(LARRY_TRIGGERS.SCHEDULER).catch(() => {})
        }
      } finally {
        STATE.timer = setTimeout(tick, 60_000)
        if (typeof STATE.timer?.unref === 'function') STATE.timer.unref()
      }
    }, nextTickMs)
    if (typeof STATE.timer?.unref === 'function') STATE.timer.unref()
  }

  return { started: true, scheduledOnStartup: cfg.runOnStartup, scheduledRecurring: cfg.runOnSchedule }
}

export function stopLarryScheduler() {
  if (STATE.timer) {
    clearTimeout(STATE.timer)
    STATE.timer = null
  }
  STATE.started = false
  STATE.running = false
  return { stopped: true }
}

export function getSchedulerState() {
  return { ...STATE }
}
