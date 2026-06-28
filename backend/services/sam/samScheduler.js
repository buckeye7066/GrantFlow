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
 *                                       'repair-safe' is REJECTED here — the scheduler
 *                                       will never silently mutate code
 *   SAM_ALLOW_SAFE_REPAIR=false         informational; scheduler still won't write
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

function chooseScheduledMode() {
  const requested = String(process.env.SAM_MODE || SAM_MODES.OBSERVE).toLowerCase()
  if (requested === SAM_MODES.GATEKEEPER) return SAM_MODES.GATEKEEPER
  // The scheduler refuses to run repair-safe — that mode requires an
  // authenticated admin in the request context.
  if (requested === SAM_MODES.REPAIR_SAFE) {
    console.warn('[sam:scheduler] SAM_MODE=repair-safe is not allowed for scheduled runs; falling back to observe.')
    return SAM_MODES.OBSERVE
  }
  return SAM_MODES.OBSERVE
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
        lockName: 'sam:observe',
        ttlMs: 60 * 60 * 1000,
        logger,
      }, () => runSam({
          db,
          ctx: null,
          mode: chooseScheduledMode(),
          trigger: SAM_TRIGGERS.STARTUP,
          dryRun: true,
          // Without a probe, autonomous Sam fail-skips every HTTP check yet still
          // reports a green score. Loopback probe with the server's admin token.
          httpProbe: makeInternalHttpProbe(),
        })).catch((err) => logger.warn?.('[sam:scheduler] startup run failed:', err?.message || err))
    }
    if (shouldRunOnSchedule()) {
      scheduleNext({ db, logger })
      logger.info?.('[sam:scheduler] scheduled mode armed', {
        schedule: process.env.SAM_SCHEDULE || '0 4 * * *',
        mode: chooseScheduledMode(),
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
        lockName: 'sam:observe',
        ttlMs: 60 * 60 * 1000,
        logger,
      }, () => runSam({
          db,
          ctx: null,
          mode: chooseScheduledMode(),
          trigger: SAM_TRIGGERS.SCHEDULED,
          dryRun: true,
          httpProbe: makeInternalHttpProbe(),
        }))
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
}
