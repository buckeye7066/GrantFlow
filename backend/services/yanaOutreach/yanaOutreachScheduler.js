/**
 * Yana — Lead Pipeline scheduler (env-gated, in-process cron).
 *
 * This is the legacy Yana lead/outreach pipeline. Files live under
 * backend/services/yanaOutreach/ and use the `yanaOutreach`/`YanaOutreach`
 * identifier spelling. The canonical user-facing identity is "Yana".
 *
 * Two implementations of Yana coexist in the repo:
 *
 *  1) The CANONICAL Yana client-discovery adapter at
 *     backend/services/yana/yanaLeadDiscovery.js, listed in
 *     ALL_AGENTS and wired to the Admin Agent Control Center
 *     (start / pause / cancel / emergency-stop reach it). Enabled by
 *     YANA_ENABLED=true.
 *
 *  2) This LEGACY Yana lead pipeline, kept for backward compatibility
 *     with deployments that set YANA_LEADS_ENABLED=true (legacy alias
 *     LARRY_ENABLED). It runs *outside* Mission Control on its own
 *     scheduler.
 *
 * To stop the two from double-discovering the same prospects into
 * different tables (`yana_lead_candidates` vs `larry_*`), this
 * scheduler refuses to start when YANA_ENABLED=true. Operators see a
 * clear log line directing them to consolidate on the canonical
 * adapter.
 *
 * Wakes the legacy Yana lead pipeline up periodically when
 * YANA_LEADS_ENABLED=true and YANA_LEADS_RUN_ON_SCHEDULE=true. Default
 * state is DISABLED. Even when scheduled, the scheduler defaults to
 * discovery+verify+score modes — never auto-send.
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

import { getYanaOutreachConfig } from './yanaOutreachSafety.js'
import { YANA_OUTREACH_MODES, YANA_OUTREACH_TRIGGERS } from './yanaOutreachTypes.js'
import { runYanaOutreach } from './yanaOutreachAgent.js'
import { runWithSchedulerLock } from '../schedulerLock.js'

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
 * the legacy lead pipeline has zero runtime coupling to the canonical
 * Yana adapter. Pure env read.
 */
function isYanaEnabled(env = process.env) {
  const raw = String(env?.YANA_ENABLED ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

export function startYanaOutreachScheduler({
  db,
  deps = {},
  logger: externalLogger = null,
  env = process.env,
} = {}) {
  const cfg = getYanaOutreachConfig()
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
      '[Yana/leads] refusing to start the legacy lead pipeline because YANA_ENABLED=true. ' +
      'The canonical Yana client-discovery adapter (backend/services/yana/) is the supported path; ' +
      'this older pipeline would double-discover into different tables. ' +
      'Set LARRY_ENABLED=false (alias YANA_LEADS_ENABLED=false) to silence this notice.'
    if (typeof log.warn === 'function') log.warn(msg)
    else log.info?.(msg)
    return {
      started: false,
      reason: 'deprecated_superseded_by_yana',
      detail: 'YANA_ENABLED=true; legacy Yana lead pipeline refuses to run alongside the canonical Yana adapter',
    }
  }

  // Standalone legacy-Yana boot — still functional, but warn the operator
  // that this is the older code path so it doesn't go unnoticed.
  const deprecationNotice =
    '[Yana/leads] notice: running the legacy lead pipeline. ' +
    'For unified Mission Control coverage, migrate to YANA_ENABLED + JOHN_ENABLED.'
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
      log.info?.('[Yana/leads] skip: already running')
      return
    }
    STATE.running = true
    try {
      const result = await runWithSchedulerLock(db, {
        lockName: 'yana-leads:legacy',
        ttlMs: 60 * 60 * 1000,
        logger: log,
      }, () => runYanaOutreach({
        db,
        mode: deps.scheduledMode || YANA_OUTREACH_MODES.SCORE_FIT,
        trigger,
        options: deps.scheduledOptions || {},
      }))
      if (result?.skipped) {
        STATE.lastResult = result
        return
      }
      STATE.lastRunAt = new Date().toISOString()
      STATE.lastResult = { ok: result?.ok, run_id: result?.run_id, mode: result?.mode }
      log.info?.('[Yana/leads] run complete', STATE.lastResult)
    } catch (err) {
      log.warn?.('[Yana/leads] run failed', { error: err?.message || String(err) })
      STATE.lastResult = { ok: false, error: err?.message || String(err) }
    } finally {
      STATE.running = false
    }
  }

  if (cfg.runOnStartup) {
    setTimeout(() => {
      runOnce(YANA_OUTREACH_TRIGGERS.STARTUP).catch(() => {})
    }, 5000)
  }

  if (cfg.runOnSchedule) {
    const nextTickMs = (60 - new Date().getSeconds()) * 1000 + 50
    STATE.timer = setTimeout(function tick() {
      try {
        if (isCronMinuteMatch(cfg.schedule, new Date())) {
          runOnce(YANA_OUTREACH_TRIGGERS.SCHEDULER).catch(() => {})
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

export function stopYanaOutreachScheduler() {
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
