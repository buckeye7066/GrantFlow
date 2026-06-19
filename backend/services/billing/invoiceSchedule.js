/**
 * invoiceSchedule.js — WHEN a billing account should be invoiced.
 *
 * Cadences (chosen at signup, stored on billing_accounts.billing_cadence):
 *   - weekly       → every Friday 09:00 America/New_York (Eastern)
 *   - semimonthly  → the 1st and 16th, 09:00 Eastern (twice a month)
 *   - monthly      → the 1st, 09:00 Eastern
 *
 * Pure + timezone-correct via Intl (handles EST/EDT). `billingMomentPassed`
 * returns the most recent billing moment at/before `now` as a stable
 * `period_key` (so the invoice table can be idempotent — one invoice per
 * account per period) plus the period bounds. The caller skips periods that
 * start before the account's billing anchor.
 */

export const BILLING_CADENCES = Object.freeze(['weekly', 'semimonthly', 'monthly'])
export const DEFAULT_CADENCE = 'weekly'
const TZ = 'America/New_York'
const BILLING_HOUR = 9 // 09:00 ET

export function normalizeCadence(c) {
  const v = String(c || '').trim().toLowerCase()
  return BILLING_CADENCES.includes(v) ? v : DEFAULT_CADENCE
}

/** Date → its wall-clock parts in Eastern time, incl. weekday (0=Sun..6=Sat). */
function etParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]))
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +(p.hour === '24' ? '0' : p.hour), minute: +p.minute,
    weekday: weekdayMap[p.weekday],
  }
}

/** UTC instant for wall-clock Y/M/D HH:00 in Eastern time. */
function etDateTimeToUtc(year, month, day, hour) {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0)
  const back = etParts(new Date(guess))
  const asLocal = Date.UTC(back.year, back.month - 1, back.day, back.hour, back.minute, 0)
  return new Date(guess - (asLocal - guess))
}

const pad = (n) => String(n).padStart(2, '0')
const isoDate = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`

/** Add N days to an Eastern calendar date, returning {year,month,day}. */
function addDaysEt(year, month, day, days) {
  const base = Date.UTC(year, month - 1, day)
  const d = new Date(base + days * 86400000)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * The most recent billing moment at/before `now` for a cadence, or null if none
 * has occurred yet today. Returns { period_key, period_start, period_end (ISO
 * dates), billed_at (ISO instant) }.
 */
export function billingMomentPassed(cadence, now = new Date()) {
  const c = normalizeCadence(cadence)
  const et = etParts(now)

  if (c === 'monthly') {
    // The 1st at 09:00 ET. If today is past the 1st (or it's the 1st ≥09:00),
    // bill for this month; else bill for last month.
    let y = et.year; let m = et.month
    const firstMoment = etDateTimeToUtc(y, m, 1, BILLING_HOUR)
    if (now < firstMoment) { const p = addDaysEt(y, m, 1, -1); y = p.year; m = p.month }
    return {
      period_key: `monthly:${y}-${pad(m)}`,
      period_start: isoDate(y, m, 1),
      period_end: isoDate(y, m, lastDayOfMonth(y, m)),
      billed_at: etDateTimeToUtc(y, m, 1, BILLING_HOUR).toISOString(),
    }
  }

  if (c === 'semimonthly') {
    const y = et.year; const m = et.month
    const firstMoment = etDateTimeToUtc(y, m, 1, BILLING_HOUR)
    const midMoment = etDateTimeToUtc(y, m, 16, BILLING_HOUR)
    if (now >= midMoment) {
      return { period_key: `semimonthly:${y}-${pad(m)}-H2`, period_start: isoDate(y, m, 16), period_end: isoDate(y, m, lastDayOfMonth(y, m)), billed_at: midMoment.toISOString() }
    }
    if (now >= firstMoment) {
      return { period_key: `semimonthly:${y}-${pad(m)}-H1`, period_start: isoDate(y, m, 1), period_end: isoDate(y, m, 15), billed_at: firstMoment.toISOString() }
    }
    // Before the 1st 09:00 → the prior month's H2.
    const prev = addDaysEt(y, m, 1, -1)
    return { period_key: `semimonthly:${prev.year}-${pad(prev.month)}-H2`, period_start: isoDate(prev.year, prev.month, 16), period_end: isoDate(prev.year, prev.month, lastDayOfMonth(prev.year, prev.month)), billed_at: etDateTimeToUtc(prev.year, prev.month, 16, BILLING_HOUR).toISOString() }
  }

  // weekly → most recent Friday 09:00 ET (weekday 5).
  let daysSinceFri = (et.weekday - 5 + 7) % 7
  let fri = addDaysEt(et.year, et.month, et.day, -daysSinceFri)
  let friMoment = etDateTimeToUtc(fri.year, fri.month, fri.day, BILLING_HOUR)
  if (now < friMoment) { // it's Friday but before 09:00 → use last Friday
    fri = addDaysEt(et.year, et.month, et.day, -daysSinceFri - 7)
    friMoment = etDateTimeToUtc(fri.year, fri.month, fri.day, BILLING_HOUR)
  }
  const start = addDaysEt(fri.year, fri.month, fri.day, -6) // 7-day period ending Friday
  return {
    period_key: `weekly:${isoDate(fri.year, fri.month, fri.day)}`,
    period_start: isoDate(start.year, start.month, start.day),
    period_end: isoDate(fri.year, fri.month, fri.day),
    billed_at: friMoment.toISOString(),
  }
}
