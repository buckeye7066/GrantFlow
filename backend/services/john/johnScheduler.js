/**
 * John — scheduler.
 *
 * Boots from server.js. Runs `runJohn({ mode: 'draft' })` at the configured
 * cron-like cadence, but only when:
 *   - JOHN_ENABLED=true
 *   - JOHN_RUN_ON_SCHEDULE=true (and/or JOHN_RUN_ON_STARTUP=true for boot)
 * and never overlaps two runs. Failures are logged but never crash the
 * server.
 *
 * The scheduler does NOT introduce a cron dependency; it parses a small
 * subset of crontab (minute, hour, day-of-month, month, day-of-week) and
 * polls every 60 seconds. That matches the Yana lead pipeline's pattern.
 */

import { runJohn } from './johnAgent.js'
import { getJohnConfig } from './johnOutreachSafety.js'
import { JOHN_MODES, JOHN_TRIGGERS } from './johnTypes.js'
import { runWithSchedulerLock } from '../schedulerLock.js'

const POLL_INTERVAL_MS = 60_000

let timer = null
let running = false
let lastTickedMinute = null

function parseCronField(field, min, max) {
  const f = String(field || '').trim()
  if (f === '*' || f === '') {
    const arr = []
    for (let i = min; i <= max; i++) arr.push(i)
    return arr
  }
  const parts = f.split(',')
  const out = new Set()
  for (const part of parts) {
    if (part.includes('/')) {
      const [range, stepRaw] = part.split('/')
      const step = parseInt(stepRaw, 10) || 1
      let lo = min, hi = max
      if (range !== '*') {
        const [a, b] = range.split('-').map((x) => parseInt(x, 10))
        lo = a; hi = isNaN(b) ? max : b
      }
      for (let i = lo; i <= hi; i += step) out.add(i)
    } else if (part.includes('-')) {
      const [a, b] = part.split('-').map((x) => parseInt(x, 10))
      for (let i = a; i <= b; i++) out.add(i)
    } else {
      const n = parseInt(part, 10)
      if (!isNaN(n)) out.add(n)
    }
  }
  return [...out].filter((n) => n >= min && n <= max).sort((a, b) => a - b)
}

export function parseCron(expr) {
  const fields = String(expr || '').trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [min, hr, dom, mon, dow] = fields
  return {
    minute: parseCronField(min, 0, 59),
    hour: parseCronField(hr, 0, 23),
    dayOfMonth: parseCronField(dom, 1, 31),
    month: parseCronField(mon, 1, 12),
    dayOfWeek: parseCronField(dow, 0, 6),
  }
}

export function cronMatches(cron, date) {
  if (!cron) return false
  return (
    cron.minute.includes(date.getMinutes()) &&
    cron.hour.includes(date.getHours()) &&
    cron.dayOfMonth.includes(date.getDate()) &&
    cron.month.includes(date.getMonth() + 1) &&
    cron.dayOfWeek.includes(date.getDay())
  )
}

async function tick({ db, logger, config }) {
  if (running) return { skipped: true, reason: 'overlap' }
  const cfg = config || getJohnConfig()
  if (!cfg.enabled) return { skipped: true, reason: 'disabled' }
  if (!cfg.runOnSchedule) return { skipped: true, reason: 'schedule_disabled' }
  const cron = parseCron(cfg.schedule)
  if (!cron) return { skipped: true, reason: 'invalid_cron' }
  const now = new Date()
  const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`
  if (lastTickedMinute === minuteKey) return { skipped: true, reason: 'already_ticked' }
  if (!cronMatches(cron, now)) return { skipped: true, reason: 'no_match' }
  lastTickedMinute = minuteKey

  running = true
  try {
    const result = await runWithSchedulerLock(db, {
      lockName: 'john:draft',
      ttlMs: 60 * 60 * 1000,
      logger,
    }, () => runJohn({
      db,
      mode: JOHN_MODES.DRAFT,
      trigger: JOHN_TRIGGERS.SCHEDULE,
      logger,
    }))
    if (result?.skipped) {
      return result
    }
    return { ran: true, result }
  } catch (err) {
    logger?.warn?.('[John] scheduler tick failed', { error: err?.message })
    return { ran: false, error: err?.message }
  } finally {
    running = false
  }
}

export function startJohnScheduler({ db, logger = console, config = getJohnConfig() } = {}) {
  if (!config.enabled) return { started: false, reason: 'JOHN_ENABLED=false' }
  if (!config.runOnSchedule && !config.runOnStartup) {
    return { started: false, reason: 'no_schedule_or_startup' }
  }
  if (timer) return { started: false, reason: 'already_started' }

  if (config.runOnStartup) {
    // Fire-and-forget startup run.
    Promise.resolve()
      .then(() => runWithSchedulerLock(db, {
        lockName: 'john:draft',
        ttlMs: 60 * 60 * 1000,
        logger,
      }, () => runJohn({
        db,
        mode: config.mode === JOHN_MODES.OBSERVE ? JOHN_MODES.OBSERVE : JOHN_MODES.DRAFT,
        trigger: JOHN_TRIGGERS.STARTUP,
        logger,
      })))
      .catch((err) => logger?.warn?.('[John] startup run failed', { error: err?.message }))
  }

  if (config.runOnSchedule) {
    timer = setInterval(() => {
      tick({ db, logger, config: getJohnConfig() }).catch(() => {})
    }, POLL_INTERVAL_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }
  return { started: true, runOnStartup: !!config.runOnStartup, runOnSchedule: !!config.runOnSchedule, schedule: config.schedule }
}

export function stopJohnScheduler() {
  if (timer) {
    clearInterval(timer)
    timer = null
    return { stopped: true }
  }
  return { stopped: false }
}

export const _internal = { tick, parseCronField }
