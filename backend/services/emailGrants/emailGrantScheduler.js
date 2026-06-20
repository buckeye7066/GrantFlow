/**
 * Email→grant nightly scheduler.
 *
 * Runs the Outlook inbox feed (read dr.johnwhite@axiombiolabs.org → parse grant
 * emails → catalog) on a cron, evaluated in a real timezone so "9 PM Eastern"
 * stays 9 PM Eastern across EDT/EST (the other agent schedulers match against
 * the server's UTC clock; we deliberately don't, to honor a local-time ask).
 *
 * Defaults: enabled, `0 21 * * *` (21:00) in America/New_York, scan 50 messages.
 * Override via EMAIL_GRANTS_SYNC_ENABLED / _CRON / _TZ / _TOP. The feed itself
 * no-ops gracefully when the mailbox/Graph creds aren't configured, so leaving
 * this on is safe.
 *
 * Mirrors johnScheduler's poll-every-60s pattern (no cron dependency added) and
 * reuses its crontab parser.
 */

import { parseCron } from '../john/johnScheduler.js'
import { runOutlookGrantFeed } from './outlookGrantFeeder.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:emailGrantScheduler')
const POLL_INTERVAL_MS = 60_000

let timer = null
let running = false
let lastTickedMinute = null

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function isEnabled() {
  return String(process.env.EMAIL_GRANTS_SYNC_ENABLED ?? 'true').toLowerCase() !== 'false'
}
function cronExpr() {
  return process.env.EMAIL_GRANTS_SYNC_CRON || '0 21 * * *'
}
function timeZone() {
  return process.env.EMAIL_GRANTS_SYNC_TZ || 'America/New_York'
}
function scanTop() {
  return Math.max(1, Math.min(100, Number(process.env.EMAIL_GRANTS_SYNC_TOP) || 50))
}

/** Break a Date into calendar parts AS OBSERVED in `tz` (DST-correct). */
export function zonedParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', weekday: 'short',
  })
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]))
  let hour = parseInt(p.hour, 10)
  if (hour === 24) hour = 0 // some ICU builds render midnight as 24
  return {
    minute: parseInt(p.minute, 10),
    hour,
    day: parseInt(p.day, 10),
    month: parseInt(p.month, 10),
    dow: DOW[p.weekday] ?? 0,
  }
}

export function cronMatchesZoned(cron, parts) {
  if (!cron) return false
  return (
    cron.minute.includes(parts.minute) &&
    cron.hour.includes(parts.hour) &&
    cron.dayOfMonth.includes(parts.day) &&
    cron.month.includes(parts.month) &&
    cron.dayOfWeek.includes(parts.dow)
  )
}

async function tick({ db, now = new Date() } = {}) {
  if (running) return { skipped: true, reason: 'overlap' }
  if (!isEnabled()) return { skipped: true, reason: 'disabled' }
  const cron = parseCron(cronExpr())
  if (!cron) return { skipped: true, reason: 'invalid_cron' }
  const tz = timeZone()
  const parts = zonedParts(now, tz)
  const minuteKey = `${parts.month}-${parts.day}-${parts.hour}-${parts.minute}`
  if (lastTickedMinute === minuteKey) return { skipped: true, reason: 'already_ticked' }
  if (!cronMatchesZoned(cron, parts)) return { skipped: true, reason: 'no_match' }
  lastTickedMinute = minuteKey

  running = true
  try {
    const result = await runOutlookGrantFeed(db, { top: scanTop() })
    log.info('nightly email→grant sync ran', {
      ok: result?.ok, candidates: result?.candidates, imported: result?.summary?.imported,
    })
    return { ran: true, result }
  } catch (err) {
    log.warn('email→grant sync tick failed', { error: err?.message })
    return { ran: false, error: err?.message }
  } finally {
    running = false
  }
}

export function startEmailGrantSyncScheduler({ db } = {}) {
  if (!isEnabled()) return { started: false, reason: 'EMAIL_GRANTS_SYNC_ENABLED=false' }
  if (timer) return { started: false, reason: 'already_started' }
  timer = setInterval(() => { tick({ db }).catch(() => {}) }, POLL_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()
  log.info('email→grant nightly scheduler started', { cron: cronExpr(), tz: timeZone(), top: scanTop() })
  return { started: true, cron: cronExpr(), tz: timeZone() }
}

export function stopEmailGrantSyncScheduler() {
  if (timer) { clearInterval(timer); timer = null; return { stopped: true } }
  return { stopped: false }
}

export const _internal = { tick, zonedParts, cronMatchesZoned }
