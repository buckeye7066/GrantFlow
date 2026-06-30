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

const SIGNUP_GRANT_DAYS = Object.freeze({ week: 7, month: 30 })

/**
 * The per-signup grant. When the Free Week window is active, a user who signs
 * up should get their OWN full free period starting now — so someone who joins
 * on the last day of the promo still gets a complete trial instead of a few
 * hours. Returns { period, days, until } or null when the promo is off or
 * signup grants are disabled.
 *
 *   FREE_WEEK_SIGNUP_PERIOD = 'week' (default) | 'month' | 'none'
 */
export function freeWeekSignupGrant(env = {}, now = Date.now()) {
  if (!isFreeWeekActive(env, now)) return null
  const raw = String(env.FREE_WEEK_SIGNUP_PERIOD ?? 'week').trim().toLowerCase()
  if (['none', 'off', 'false', '0', 'no'].includes(raw)) return null
  const period = SIGNUP_GRANT_DAYS[raw] ? raw : 'week'
  const days = SIGNUP_GRANT_DAYS[period]
  return { period, days, until: new Date(now + days * 86400000).toISOString() }
}

/**
 * The always-on NEW-USER free trial — independent of the Free Week promo. Every
 * newly-created profile gets its own free period starting at signup (the timer
 * runs from account creation via billing_accounts.free_until, self-expiring).
 * ON by default: only an explicit falsey value turns it off, so a fresh deploy
 * gives every new user 7 free days with no env config required.
 *
 *   SIGNUP_TRIAL_ENABLED = 'true' (default) | 'false'/'off'/'0'/'no' to disable
 *   SIGNUP_TRIAL_PERIOD  = 'week' (default, 7 days) | 'month' (30) | 'none'/off
 *
 * Returns { period, days, until } or null when disabled.
 */
export function signupTrialGrant(env = {}, now = Date.now()) {
  const enabled = String(env.SIGNUP_TRIAL_ENABLED ?? 'true').trim().toLowerCase()
  if (['false', 'off', '0', 'no', 'none'].includes(enabled)) return null
  const raw = String(env.SIGNUP_TRIAL_PERIOD ?? 'week').trim().toLowerCase()
  if (['none', 'off', 'false', '0', 'no'].includes(raw)) return null
  const period = SIGNUP_GRANT_DAYS[raw] ? raw : 'week'
  const days = SIGNUP_GRANT_DAYS[period]
  return { period, days, until: new Date(now + days * 86400000).toISOString() }
}
