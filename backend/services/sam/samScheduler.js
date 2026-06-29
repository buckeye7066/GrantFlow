/**
 * samScheduler.js
 *
 * Optional, opt-in background runner for Sam.
 *
 * EVERYTHING IS OFF BY DEFAULT.
 *
 * Env contract:
 *   SAM_ENABLED=false                   master switch
 *   SAM_RUN_ON_STARTUP=false            run once on server boot
 *   SAM_RUN_ON_SCHEDULE=false           run on a recurring interval
 *   SAM_SCHEDULE='0 4 * * *'            cron-style; we accept the cron form
 *                                       but only support a daily-at-HH:MM
 *                                       subset to keep the scheduler tiny
 *                                       and dependency-free
 *   SAM_MODE=observe                    'observe' or 'gatekeeper' for scheduled runs;
 *                                       'repair-safe' is REJECTED here UNLESS
 *                                       SAM_SCHEDULE_AUTOFIX=true (see below)
 *   SAM_ALLOW_SAFE_REPAIR=false         informational; scheduler still won't write
 *                                       unless SAM_SCHEDULE_AUTOFIX is on
 *   SAM_SCHEDULE_AUTOFIX=false          OPT-IN: when true the daily run does the
 *                                       full heavy code/function sweep AND applies
 *                                       Sam's whitelisted SAFE fixes (eslint --fix,
 *                                       readiness logs) autonomously, then emails
 *                                       the operator the issues + corrections. Still
 *                                       bounded by samSafeFixes' allowlist, forbidden
 *                                       paths, and policy gate — it can only touch
 *                                       src/, docs/, backend/services/sam.
 *
 * If anything is misconfigured, the scheduler logs once and goes back to
 * sleep. It never throws on the hot path.
 */

import { runSam } from './samAgent.js'
import { SAM_MODES, SAM_TRIGGERS } from './samTypes.js'
import { makeInternalHttpProbe } from './samHttpProbe.js'
import { runWithSchedulerLock } from '../schedulerLock.js'

let activeTimer = null
let starting = false

export function isSamEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.SAM_ENABLED || '').trim())
}

export function shouldRunOnStartup() {
  return isSamEnabled() && /^(1|true|yes|on)$/i.test(String(process.env.SAM_RUN_ON_STARTUP || '').trim())
}

export function shouldRunOnSchedule() {
  return isSamEnabled() && /^(1|true|yes|on)$/i.test(String(process.env.SAM_RUN_ON_SCHEDULE || '').trim())
}

export function shouldAutofix() {
  return /^(1|true|yes|on)$/i.test(String(process.env.SAM_SCHEDULE_AUTOFIX || '').trim())
}

function chooseScheduledMode() {
  // Opt-in autonomous autofix: the daily run does the full code/function sweep
  // AND applies Sam's whitelisted SAFE fixes. This is the ONLY way the scheduler
  // runs repair-safe; it stays bounded by samSafeFixes' allowlist + policy gate.
  if (shouldAutofix()) return SAM_MODES.REPAIR_SAFE

  const requested = String(process.env.SAM_MODE || SAM_MODES.OBSERVE).toLowerCase()
  if (requested === SAM_MODES.GATEKEEPER) return SAM_MODES.GATEKEEPER
  // Without autofix, the scheduler refuses repair-safe — that mode requires an
  // authenticated admin in the request context.
  if (requested === SAM_MODES.REPAIR_SAFE) {
    console.warn('[sam:scheduler] SAM_MODE=repair-safe requires SAM_SCHEDULE_AUTOFIX=true; falling back to observe.')
    return SAM_MODES.OBSERVE
  }
  return SAM_MODES.OBSERVE
}

/**
 * Build the runSam() args for a scheduled/startup run. Read-only by default;
 * when SAM_SCHEDULE_AUTOFIX is on it authorises the repair-safe run, turns OFF
 * dryRun (so fixes actually apply), and forces the heavy code sweep.
 */
function buildRunArgs({ db, trigger }) {
  const mode = chooseScheduledMode()
  const autofix = mode === SAM_MODES.REPAIR_SAFE && shouldAutofix()
  return {
    db,
    // An authorised internal context lets runSam honour repair-safe. Without
    // autofix this stays null so the run is purely read-only.
    ctx: autofix ? { samAuthorised: true, userId: null, source: 'sam-scheduler' } : null,
    mode,
    trigger,
    // dryRun:false is required for repair-safe to apply fixes; observe/gatekeeper
    // ignore it and never write regardless.
    dryRun: !autofix,
    // The autofix sweep wants the full heavy code/function scan even though it
    // runs in repair-safe (which is otherwise light). Gatekeeper already implies
    // heavy via its own default, so only force it for the autofix path.
    ...(autofix ? { includeHeavy: true } : {}),
    // Without a probe, autonomous Sam fail-skips every HTTP check yet still
    // reports a green score. Loopback probe with the server's admin token.
    httpProbe: makeInternalHttpProbe(),
  }
}

/**
 * Parse a tiny subset of cron expressions: `M H * * *` (daily at HH:MM).
 * Anything else falls back to 04:00 UTC.
 *
 * Returns { hour, minute }.
 */
export function parseDailyCron(expr) {
  const fallback = { hour: 4, minute: 0 }
  if (typeof expr !== 'string') return fallback
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return fallback
  const [m, h, dom, mon, dow] = parts
  if (dom !== '*' || mon !== '*' || dow !== '*') return fallback
  const minute = Number(m)
  const hour = Number(h)
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return fallback
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return fallback
  return { hour, minute }
}

function msUntilNextDaily({ hour, minute }, now = new Date()) {
  const next = new Date(now)
  next.setHours(hour, minute, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

export function startSamScheduler({ db, logger = console } = {}) {
  if (starting) return false
  starting = true
  try {
    if (!isSamEnabled()) {
      logger.info?.('[sam:scheduler] SAM_ENABLED=false — scheduler not started.')
      return false
    }
    if (shouldRunOnStartup()) {
      // Fire-and-forget, never block boot.
      runWithSchedulerLock(db, {
        lockName: 'sam:scheduler',
        ttlMs: 60 * 60 * 1000,
        logger,
      }, () => runSam(buildRunArgs({ db, trigger: SAM_TRIGGERS.STARTUP })))
        .catch((err) => logger.warn?.('[sam:scheduler] startup run failed:', err?.message || err))
    }
    if (shouldRunOnSchedule()) {
      scheduleNext({ db, logger })
      logger.info?.('[sam:scheduler] scheduled mode armed', {
        schedule: process.env.SAM_SCHEDULE || '0 4 * * *',
        mode: chooseScheduledMode(),
        autofix: shouldAutofix(),
      })
    }
    return true
  } finally {
    starting = false
  }
}

export function stopSamScheduler() {
  if (activeTimer) {
    clearTimeout(activeTimer)
    activeTimer = null
  }
}

function scheduleNext({ db, logger }) {
  const cron = parseDailyCron(process.env.SAM_SCHEDULE || '0 4 * * *')
  const delay = msUntilNextDaily(cron)
  activeTimer = setTimeout(async () => {
    try {
      await runWithSchedulerLock(db, {
        lockName: 'sam:scheduler',
        ttlMs: 60 * 60 * 1000,
        logger,
      }, () => runSam(buildRunArgs({ db, trigger: SAM_TRIGGERS.SCHEDULED })))
    } catch (err) {
      logger.warn?.('[sam:scheduler] scheduled run failed:', err?.message || err)
    } finally {
      // Re-arm only if the env still says yes (operators can flip it off
      // at runtime without restarting).
      if (shouldRunOnSchedule()) scheduleNext({ db, logger })
    }
  }, delay)
  // Don't pin the event loop open — let the process exit cleanly if Sam is
  // the only timer left.
  activeTimer.unref?.()
}

export const __testing__ = {
  parseDailyCron,
  msUntilNextDaily,
  chooseScheduledMode,
  shouldAutofix,
  buildRunArgs,
}
