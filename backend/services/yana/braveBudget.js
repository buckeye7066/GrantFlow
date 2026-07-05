/**
 * braveBudget.js — proactive monthly PACER for the shared Brave Search API key.
 *
 * braveRateLimit.js (the circuit breaker) reacts AFTER Brave starts returning
 * 429s — by which point the month's quota is already gone and every consumer
 * (web-discovery lane, Yana enrichment, Robert, John) is dark until the
 * calendar month resets. That is exactly what happened in early July 2026: the
 * crawler fleet drained the full monthly quota in the first days, then Brave
 * served 402/429 for weeks.
 *
 * This module makes the quota last the WHOLE month by rationing it up front:
 *
 *   today's allowance = max(MIN_DAILY, floor(remaining_quota / days_left))
 *
 * Unused budget rolls forward (remaining grows relative to days left); an
 * early-month burn shrinks later allowances instead of zeroing them. When
 * today's allowance is spent, callers skip Brave for the rest of the UTC day
 * and the existing fallbacks (SearXNG / DDG) carry the load.
 *
 * State lives in system_kv (`brave_search_budget`) so it survives deploys —
 * an in-memory counter would reset on every push and overspend. All I/O is
 * best-effort: if the DB is unavailable the pacer FAILS OPEN (allows the
 * call) rather than silently killing web search.
 *
 * Env:
 *   BRAVE_MONTHLY_QUERY_BUDGET — queries/month to spend (default 1900, i.e.
 *                                the ~2,000 free tier minus headroom)
 *   BRAVE_BUDGET_MIN_DAILY     — floor so late-month days are never starved
 *                                (default 10)
 *   BRAVE_BUDGET_ENABLED       — set false to disable pacing entirely
 */

import { createLogger } from '../../utils/logger.js'

const log = createLogger('braveBudget')

export const KV_KEY = 'brave_search_budget'

export function isBraveBudgetEnabled() {
  return String(process.env.BRAVE_BUDGET_ENABLED ?? 'true').toLowerCase() !== 'false'
}

export function monthlyBudget() {
  const n = Number(process.env.BRAVE_MONTHLY_QUERY_BUDGET)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1900
}

export function minDaily() {
  const n = Number(process.env.BRAVE_BUDGET_MIN_DAILY)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10
}

function utcMonthKey(now) {
  return new Date(now).toISOString().slice(0, 7) // YYYY-MM
}

function utcDayKey(now) {
  return new Date(now).toISOString().slice(0, 10) // YYYY-MM-DD
}

function daysInUtcMonth(now) {
  const d = new Date(now)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
}

/**
 * PURE: today's query allowance given the month's state.
 * remainingBeforeToday = budget - (used - usedToday); days_left includes today.
 */
export function computeDailyAllowance({ budget, used, usedToday, now = Date.now(), floorDaily = minDaily() }) {
  const dayOfMonth = new Date(now).getUTCDate()
  const daysLeft = Math.max(1, daysInUtcMonth(now) - dayOfMonth + 1)
  const remainingBeforeToday = Math.max(0, budget - (Math.max(0, used) - Math.max(0, usedToday)))
  return Math.max(floorDaily, Math.floor(remainingBeforeToday / daysLeft))
}

function emptyState(now) {
  return { month: utcMonthKey(now), used: 0, days: {} }
}

async function readState(db, now) {
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(KV_KEY)
    if (!row?.value) return emptyState(now)
    const parsed = JSON.parse(row.value)
    if (!parsed || typeof parsed !== 'object' || parsed.month !== utcMonthKey(now)) return emptyState(now)
    return {
      month: parsed.month,
      used: Number(parsed.used) || 0,
      days: parsed.days && typeof parsed.days === 'object' ? parsed.days : {},
    }
  } catch {
    return null // DB unavailable — caller fails open
  }
}

async function writeState(db, state, now) {
  try {
    const iso = new Date(now).toISOString()
    const value = JSON.stringify(state)
    const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, iso, KV_KEY)
    if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
      await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(KV_KEY, value, iso)
    }
  } catch (err) {
    log.warn('brave budget persist failed (non-fatal)', { error: err?.message })
  }
}

/**
 * Reserve one Brave query against the monthly budget. Call BEFORE firing the
 * request (attempts count — safe side). Fails OPEN on any storage problem.
 *
 * @param {object} [opts] { db, now } — db defaults to the live handle.
 * @returns {Promise<{allowed: boolean, reason?: string, state?: object}>}
 */
export async function tryConsumeBraveQuery({ db = null, now = Date.now() } = {}) {
  if (!isBraveBudgetEnabled()) return { allowed: true, reason: 'pacing_disabled' }

  let liveDb = db
  if (!liveDb) {
    try {
      const { getDb } = await import('../../db/index.js')
      liveDb = getDb()
    } catch {
      return { allowed: true, reason: 'no_db_fail_open' }
    }
  }
  if (!liveDb?.prepare) return { allowed: true, reason: 'no_db_fail_open' }

  const state = await readState(liveDb, now)
  if (!state) return { allowed: true, reason: 'kv_unreadable_fail_open' }

  const budget = monthlyBudget()
  const dayKey = utcDayKey(now)
  const usedToday = Number(state.days[dayKey]) || 0

  if (state.used >= budget) {
    return { allowed: false, reason: 'monthly_budget_exhausted', state: summarize(state, budget, now) }
  }
  const allowance = computeDailyAllowance({ budget, used: state.used, usedToday, now })
  if (usedToday >= allowance) {
    return { allowed: false, reason: 'daily_pace_reached', state: summarize(state, budget, now) }
  }

  state.used += 1
  state.days[dayKey] = usedToday + 1
  // Retain ~40 day keys (month view + a little history for dashboards).
  const keys = Object.keys(state.days).sort()
  while (keys.length > 40) delete state.days[keys.shift()]
  await writeState(liveDb, state, now)
  return { allowed: true, state: summarize(state, budget, now) }
}

function summarize(state, budget, now) {
  const dayKey = utcDayKey(now)
  const usedToday = Number(state.days[dayKey]) || 0
  return {
    month: state.month,
    used: state.used,
    budget,
    used_today: usedToday,
    allowance_today: computeDailyAllowance({ budget, used: state.used, usedToday, now }),
  }
}

/** Observable budget state for Sam diagnostics / dashboards. Never throws. */
export async function getBraveBudgetState({ db = null, now = Date.now() } = {}) {
  let liveDb = db
  if (!liveDb) {
    try {
      const { getDb } = await import('../../db/index.js')
      liveDb = getDb()
    } catch {
      return null
    }
  }
  if (!liveDb?.prepare) return null
  const state = await readState(liveDb, now)
  if (!state) return null
  return summarize(state, monthlyBudget(), now)
}

export default {
  KV_KEY,
  isBraveBudgetEnabled,
  monthlyBudget,
  minDaily,
  computeDailyAllowance,
  tryConsumeBraveQuery,
  getBraveBudgetState,
}
