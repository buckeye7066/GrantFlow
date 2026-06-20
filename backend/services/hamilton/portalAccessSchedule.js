/**
 * portalAccessSchedule.js
 *
 * A per-profile schedule for WHEN Hamilton may access portals unattended, so the
 * user can be available for any sign-in / 2FA / approval prompts. The owner picks
 * one or more time-of-day windows in their timezone; Hamilton's autonomous runner
 * only drives portals inside a window and defers anything else to the next one.
 *
 * Stored on the profile under profile_sections.automation_preferences:
 *   { portal_access: { enabled: true, timezone: "America/New_York",
 *                      windows: [{ start: "09:00", end: "10:00" },
 *                                { start: "18:00", end: "19:30" }] } }
 *
 * Pure + timezone-correct via Intl.DateTimeFormat (no external tz dependency).
 * An empty/disabled schedule means "any time" — the prior always-on behavior.
 */

export const DEFAULT_TIMEZONE = 'America/New_York'

export function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim())
  if (!m) return null
  const h = Number(m[1]); const min = Number(m[2])
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

function pad2(n) { return String(n).padStart(2, '0') }
export function minutesToHHMM(mins) {
  const m = ((Math.round(Number(mins) || 0)) % 1440 + 1440) % 1440
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`
}

/** Normalize raw prefs into a validated schedule. Drops malformed windows. */
export function normalizeSchedule(prefs = {}) {
  const raw = prefs?.portal_access ?? prefs ?? {}
  const timezone = typeof raw.timezone === 'string' && raw.timezone.trim() ? raw.timezone.trim() : DEFAULT_TIMEZONE
  const windows = []
  for (const w of Array.isArray(raw.windows) ? raw.windows : []) {
    const startMin = parseHHMM(w?.start)
    const endMin = parseHHMM(w?.end)
    if (startMin === null || endMin === null || startMin === endMin) continue
    windows.push({ start: minutesToHHMM(startMin), end: minutesToHHMM(endMin), startMin, endMin })
  }
  const enabled = raw.enabled === true && windows.length > 0
  return { enabled, timezone, windows }
}

/** Date → {year,month,day,hour,minute} as read in the given IANA timezone. */
function tzParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]))
  return { year: +p.year, month: +p.month, day: +p.day, hour: +(p.hour === '24' ? '0' : p.hour), minute: +p.minute }
}

/** Minutes since local midnight, in the schedule's timezone. */
export function minutesOfDayInTz(date, timeZone) {
  const p = tzParts(date, timeZone)
  return p.hour * 60 + p.minute
}

/** The UTC instant when wall-clock Y/M/D HH:MM occurs in `timeZone`. */
function zonedTimeToUtc(year, month, day, minutes, timeZone) {
  const hour = Math.floor(minutes / 60); const minute = minutes % 60
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0)
  const back = tzParts(new Date(guess), timeZone)
  const asLocal = Date.UTC(back.year, back.month - 1, back.day, back.hour, back.minute, 0)
  const offset = asLocal - guess // how far ahead of UTC the zone is at that instant
  return new Date(guess - offset)
}

function inWindow(nowMin, w) {
  if (w.startMin <= w.endMin) return nowMin >= w.startMin && nowMin < w.endMin
  // Overnight window (e.g. 22:00–02:00).
  return nowMin >= w.startMin || nowMin < w.endMin
}

/** Is `date` inside an allowed window? A disabled schedule is always allowed. */
export function isWithinWindow(schedule, date = new Date()) {
  const s = schedule?.enabled ? schedule : normalizeSchedule(schedule)
  if (!s.enabled) return true
  const nowMin = minutesOfDayInTz(date, s.timezone)
  return s.windows.some((w) => inWindow(nowMin, w))
}

/**
 * ISO timestamp of the next window START at/after `date`. Returns null for a
 * disabled schedule (run anytime). If currently inside a window, returns the
 * current instant (run now).
 */
export function nextWindowStart(schedule, date = new Date()) {
  const s = schedule?.enabled ? schedule : normalizeSchedule(schedule)
  if (!s.enabled) return null
  if (isWithinWindow(s, date)) return new Date(date).toISOString()

  const nowMin = minutesOfDayInTz(date, s.timezone)
  const today = tzParts(date, s.timezone)
  const startsToday = s.windows.map((w) => w.startMin).filter((m) => m > nowMin).sort((a, b) => a - b)
  if (startsToday.length > 0) {
    return zonedTimeToUtc(today.year, today.month, today.day, startsToday[0], s.timezone).toISOString()
  }
  // Otherwise the earliest window start tomorrow.
  const earliest = Math.min(...s.windows.map((w) => w.startMin))
  const tomorrow = new Date(zonedTimeToUtc(today.year, today.month, today.day, 0, s.timezone).getTime() + 24 * 60 * 60 * 1000)
  const tp = tzParts(tomorrow, s.timezone)
  return zonedTimeToUtc(tp.year, tp.month, tp.day, earliest, s.timezone).toISOString()
}

/**
 * Every distinct window START instant (ISO) between startDate and endDate,
 * inclusive — used to plot Hamilton's scheduled access windows on the calendar.
 * Returns [] for a disabled schedule (Hamilton can run anytime, so there is no
 * fixed window to plot). Capped at `cap` days to bound work.
 */
export function windowStartsBetween(schedule, startDate, endDate, cap = 120) {
  const s = schedule?.enabled ? schedule : normalizeSchedule(schedule)
  if (!s.enabled) return []
  const start = new Date(startDate)
  const end = new Date(endDate)
  const out = []
  let dayCursor = new Date(start)
  for (let i = 0; i < cap && dayCursor <= end; i += 1) {
    const p = tzParts(dayCursor, s.timezone)
    for (const w of s.windows) {
      const inst = zonedTimeToUtc(p.year, p.month, p.day, w.startMin, s.timezone)
      if (inst >= start && inst <= end) out.push(inst.toISOString())
    }
    // Advance one calendar day in the schedule's timezone.
    dayCursor = new Date(zonedTimeToUtc(p.year, p.month, p.day, 0, s.timezone).getTime() + 24 * 60 * 60 * 1000)
  }
  return [...new Set(out)].sort()
}
