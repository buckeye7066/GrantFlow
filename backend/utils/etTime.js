/**
 * etTime.js — shared America/New_York wall-clock helpers for the in-process
 * schedulers in server.js (weekly verify report, Hamilton weekly digest,
 * Monday portal reminder, nightly maintenance, Sam daily code sweep, Anya
 * daily owner report).
 *
 * WHY THIS EXISTS (prod bug, 2026-07-02): Node 20's ICU renders midnight as
 * hour "24" when `hour12: false` is used (h24 hour cycle), while newer Node
 * renders "00". Every scheduler that computed `Number(parts.hour)` therefore
 * read 24 during the 00:00–00:59 ET hour — which is ≥ ANY trigger hour — so a
 * tick (or a fresh deploy's first tick) landing in that hour opened the WHOLE
 * day's windows at midnight. Observed in prod: Sam's "05:00 ET" sweep and
 * Anya's "09:00 ET" owner email both fired at ~00:05 ET after a midnight
 * deploy. The date parts already belong to the new day, so clamping 24 → 0 is
 * the complete fix. (invoiceSchedule.js, portalAccessSchedule.js and
 * emailGrantScheduler.js each already clamp locally; this is the shared
 * equivalent for server.js.)
 */

const TZ = 'America/New_York'

/** Clamp the ICU h24 quirk: hour "24" means midnight (0). */
export function normalizeEtHour(hour) {
  const n = Number(hour)
  return n === 24 ? 0 : n
}

/**
 * The current (or given) instant as ET wall-clock parts:
 * `{ weekday: 'Mon'.., hour: 0-23, ymd: 'YYYY-MM-DD' }`. DST-correct via Intl.
 */
export function etNowParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', hour: 'numeric', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]))
  return { weekday: p.weekday, hour: normalizeEtHour(p.hour), ymd: `${p.year}-${p.month}-${p.day}` }
}

/**
 * The ET day (YYYY-MM-DD) whose `triggerHour` window has most recently opened.
 * Before that hour it returns the PREVIOUS day, so "today" only becomes
 * eligible once the trigger hour arrives. Used with a persisted day marker for
 * once-per-day jobs with restart catch-up.
 */
export function eligibleDayKey(triggerHour, { hour, ymd } = etNowParts()) {
  if (hour >= triggerHour) return ymd
  const [Y, M, D] = ymd.split('-').map(Number)
  const d = new Date(Date.UTC(Y, M - 1, D))
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * The Monday (YYYY-MM-DD, ET) whose `triggerHour` window has most recently
 * opened. Before Monday `triggerHour` it points at the PREVIOUS Monday, so the
 * new week only becomes eligible once the window opens. Used with a persisted
 * week marker for once-per-week jobs with restart catch-up.
 */
export function eligibleWeekKey(triggerHour, { weekday, hour, ymd } = etNowParts()) {
  const off = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[weekday] ?? 0
  const back = weekday === 'Mon' && hour < triggerHour ? 7 : off
  const [Y, M, D] = ymd.split('-').map(Number)
  const d = new Date(Date.UTC(Y, M - 1, D))
  d.setUTCDate(d.getUTCDate() - back)
  return d.toISOString().slice(0, 10)
}
