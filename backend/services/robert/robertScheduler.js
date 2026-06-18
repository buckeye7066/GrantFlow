/**
 * robertScheduler.js
 *
 * Optional background runner. Disabled by default. The scheduler:
 *   - reads ROBERT_ENABLED, ROBERT_RUN_ON_STARTUP, ROBERT_RUN_ON_SCHEDULE
 *   - runs at most one job at a time (locked by an in-memory flag)
 *   - persists run state via robertRunStore
 *   - never crashes the server if Robert fails
 *   - never blocks app startup
 *
 * Cron syntax intentionally simplified: we only support the
 * "0 H * * *" daily-at-hour pattern and "0 * * * *" hourly. Anything
 * else falls back to "every <ROBERT_INTERVAL_MS or 1 hour>".
 */

import { runRobert } from './robertAgent.js'
import { ROBERT_TRIGGERS } from './robertTypes.js'
import { getRobertConfig } from './robertSafety.js'
import { autoSeedWeakestProfiles } from './robertFundingTraceBridge.js'
import { upsertSourceCandidate } from './robertRunStore.js'

let _running = false
let _interval = null
let _stopped = false
let _autoSeedRunning = false
let _autoSeedInterval = null

/**
 * Start the scheduler if the env says so. Safe to call multiple times.
 */
export function startRobertScheduler({ db, deps = {}, logger = console } = {}) {
  const cfg = getRobertConfig()

  // Funding-trace weak-coverage sweep runs automatically and INDEPENDENTLY of
  // the master ROBERT_ENABLED switch: it only reads vetted public APIs
  // (USASpending / ProPublica) and stages PENDING source candidates for admin
  // review — it never crawls the open web and never publishes. So it self-
  // starts here even when the broader Robert crawl is disabled. Opt out with
  // ROBERT_AUTOSEED_ON_SCHEDULE=false.
  let autoSeedStarted = false
  if (cfg.autoSeedOnSchedule) {
    const intervalMs = parseSchedule(cfg.autoSeedSchedule)
    if (_autoSeedInterval) clearInterval(_autoSeedInterval)
    _autoSeedInterval = setInterval(() => kickOffAutoSeed({ db, cfg, logger }), intervalMs)
    if (typeof _autoSeedInterval.unref === 'function') _autoSeedInterval.unref()
    // Kick off an initial sweep a few minutes after boot so it doesn't wait a
    // full interval — delayed so the schema self-heal + warm-up have settled.
    const initial = setTimeout(() => kickOffAutoSeed({ db, cfg, logger }), 5 * 60 * 1000)
    if (typeof initial.unref === 'function') initial.unref()
    autoSeedStarted = true
  }

  if (!cfg.enabled) {
    return { started: autoSeedStarted, reason: autoSeedStarted ? 'autoseed_only' : 'robert_disabled' }
  }
  if (!cfg.runOnSchedule && !cfg.runOnStartup) {
    return { started: autoSeedStarted, reason: autoSeedStarted ? 'autoseed_only' : 'no_runtime_triggers_enabled' }
  }

  if (cfg.runOnStartup) {
    queueMicrotask(() => kickOff({ db, deps, logger, trigger: ROBERT_TRIGGERS.STARTUP }))
  }
  if (cfg.runOnSchedule) {
    const intervalMs = parseSchedule(cfg.schedule)
    if (_interval) clearInterval(_interval)
    _interval = setInterval(() => kickOff({ db, deps, logger, trigger: ROBERT_TRIGGERS.SCHEDULED }), intervalMs)
    if (typeof _interval.unref === 'function') _interval.unref()
  }
  return { started: true }
}

export function stopRobertScheduler() {
  _stopped = true
  if (_interval) {
    clearInterval(_interval)
    _interval = null
  }
  if (_autoSeedInterval) {
    clearInterval(_autoSeedInterval)
    _autoSeedInterval = null
  }
}

async function kickOff({ db, deps, logger, trigger }) {
  if (_stopped || _running) return
  _running = true
  try {
    const result = await runRobert({ db, deps, trigger, mode: null })
    if (logger?.info) logger.info('robert.scheduler.run', { run_id: result?.run_id, mode: result?.mode, status: result?.status })
  } catch (err) {
    if (logger?.error) logger.error('robert.scheduler.error', { message: String(err?.message || err) })
  } finally {
    _running = false
  }
}

async function kickOffAutoSeed({ db, cfg, logger }) {
  if (_stopped || _autoSeedRunning) return
  _autoSeedRunning = true
  try {
    const result = await autoSeedWeakestProfiles(db, {
      limit: cfg.autoSeedMaxProfiles,
      maxEntitiesPerProfile: cfg.autoSeedMaxEntitiesPerProfile,
      minRisk: cfg.autoSeedMinRisk,
      deps: { upsert: upsertSourceCandidate },
    })
    if (logger?.info) {
      logger.info('robert.scheduler.autoseed', {
        evaluated: result?.evaluated,
        weak_profiles: result?.weak_profiles,
        upserted: result?.total_upserted,
      })
    }
  } catch (err) {
    if (logger?.error) logger.error('robert.scheduler.autoseed.error', { message: String(err?.message || err) })
  } finally {
    _autoSeedRunning = false
  }
}

/**
 * Convert a cron string to milliseconds (very simplified — we only
 * need correctness for "0 H * * *" daily-at-hour and "0 * * * *"
 * hourly). Returns 1 hour by default.
 */
export function parseSchedule(spec) {
  if (typeof spec !== 'string' || spec.trim().length === 0) return 60 * 60 * 1000
  const parts = spec.trim().split(/\s+/)
  if (parts.length !== 5) return 60 * 60 * 1000
  // "0 * * * *" → hourly
  if (parts[0] === '0' && parts[1] === '*' && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
    return 60 * 60 * 1000
  }
  // "0 H * * *" → daily-at-hour (we approximate as 24h interval)
  const minute = parts[0]
  const hour = parts[1]
  if (minute === '0' && /^\d+$/.test(hour) && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
    return 24 * 60 * 60 * 1000
  }
  return 60 * 60 * 1000
}

export const __testing__ = { parseSchedule }
