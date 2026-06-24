/**
 * freeWeek.js — global "Free Week" promotional access window.
 *
 * When the window is ACTIVE, every profile is treated as fully entitled (all
 * capability flags on) and billed $0, regardless of their assigned tier. This
 * is the owner's "give the app away for a week" switch.
 *
 * It is controlled entirely by environment variables so it can be flipped on
 * and off in the hosting dashboard (Railway / Vercel) with no code deploy, and
 * it SELF-EXPIRES — there is no scheduler or cleanup job to remember.
 *
 *   FREE_WEEK_ENABLED   "true" to arm the promotion (default: off)
 *   FREE_WEEK_START     ISO date/time the window opens (optional; if omitted,
 *                       the window is open as soon as it is enabled)
 *   FREE_WEEK_END       ISO date/time the window closes (optional; if omitted,
 *                       defaults to 7 days after START)
 *   FREE_WEEK_LABEL     Optional banner text shown to users while active.
 *
 * This module is PURE and dependency-free so it is trivially testable and safe
 * to import from both the backend and the frontend. It never reads process.env
 * itself — the caller passes an env-like object — so the same function works in
 * Node, in Vite (import.meta.env), and in unit tests.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_DURATION_MS = 7 * DAY_MS

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'y', 'on'])

function isTruthy(value) {
  return TRUE_VALUES.has(String(value ?? '').trim().toLowerCase())
}

function parseTimestamp(value) {
  if (!value) return null
  const t = Date.parse(String(value))
  return Number.isNaN(t) ? null : t
}

/**
 * Resolve the full status of the promotion from an env-like object.
 * @param {Record<string, string|undefined>} env
 * @param {number} now epoch millis (injectable for tests)
 * @returns {{active:boolean, enabled:boolean, start:string|null, end:string|null, label:string|null}}
 */
export function computeFreeWeekStatus(env = {}, now = Date.now()) {
  const enabled = isTruthy(env.FREE_WEEK_ENABLED)
  if (!enabled) {
    return { active: false, enabled: false, start: null, end: null, label: null }
  }

  const start = parseTimestamp(env.FREE_WEEK_START) ?? now
  const end = parseTimestamp(env.FREE_WEEK_END) ?? start + DEFAULT_DURATION_MS

  const active = now >= start && now < end
  const label =
    (env.FREE_WEEK_LABEL && String(env.FREE_WEEK_LABEL).trim()) ||
    'Free Week — all premium features are unlocked, on the house. 🎉'

  return {
    active,
    enabled: true,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    label: active ? label : null,
  }
}

/**
 * Convenience boolean: is the promotion currently giving everything away?
 * @param {Record<string, string|undefined>} env
 * @param {number} now epoch millis (injectable for tests)
 */
export function isFreeWeekActive(env = {}, now = Date.now()) {
  return computeFreeWeekStatus(env, now).active
}
