/**
 * googleBudget.js — daily pacer for the Google Custom Search JSON API key.
 *
 * Google's CSE quota is DAILY (100/day free; paid tiers up to 10k/day) and
 * resets at UTC midnight, so unlike braveBudget.js there is no monthly pacing
 * math — just a per-UTC-day counter with headroom. When today's budget is
 * spent, callers skip the Google rung for the rest of the UTC day and the
 * existing ladder (SearXNG → fallback engines → Brave → DDG) carries the load.
 *
 * State lives in system_kv (`google_cse_budget`) so it survives deploys.
 * All I/O is best-effort: an unreadable DB FAILS OPEN (allows the call) —
 * Google itself hard-refuses past the real quota, and the provider's
 * `google_quota` error degrades the rung until the UTC reset.
 *
 * Env:
 *   GOOGLE_CSE_DAILY_BUDGET — queries/day to spend (default 90: the free
 *                             tier's 100 minus headroom for manual use)
 *   GOOGLE_BUDGET_ENABLED   — set false to disable pacing entirely
 */

import { createLogger } from '../../utils/logger.js'

const log = createLogger('googleBudget')

export const KV_KEY = 'google_cse_budget'

export function isGoogleBudgetEnabled() {
  return String(process.env.GOOGLE_BUDGET_ENABLED ?? 'true').toLowerCase() !== 'false'
}

export function dailyBudget() {
  const n = Number(process.env.GOOGLE_CSE_DAILY_BUDGET)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 90
}

function utcDayKey(now) {
  return new Date(now).toISOString().slice(0, 10) // YYYY-MM-DD
}

function emptyState(now) {
  return { day: utcDayKey(now), used: 0 }
}

async function readState(db, now) {
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(KV_KEY)
    if (!row?.value) return emptyState(now)
    const parsed = JSON.parse(row.value)
    if (!parsed || typeof parsed !== 'object' || parsed.day !== utcDayKey(now)) return emptyState(now)
    return { day: parsed.day, used: Number(parsed.used) || 0 }
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
    log.warn('google budget persist failed (non-fatal)', { error: err?.message })
  }
}

/**
 * Reserve one Google query against today's budget. Call BEFORE firing the
 * request (attempts count — safe side). Fails OPEN on any storage problem.
 *
 * @param {object} [opts] { db, now } — db defaults to the live handle.
 * @returns {Promise<{allowed: boolean, reason?: string, state?: object}>}
 */
export async function tryConsumeGoogleQuery({ db = null, now = Date.now() } = {}) {
  if (!isGoogleBudgetEnabled()) return { allowed: true, reason: 'pacing_disabled' }

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

  const budget = dailyBudget()
  if (state.used >= budget) {
    return { allowed: false, reason: 'daily_budget_exhausted', state: summarize(state, budget) }
  }

  state.used += 1
  await writeState(liveDb, state, now)
  return { allowed: true, state: summarize(state, budget) }
}

function summarize(state, budget) {
  return { day: state.day, used: state.used, budget }
}

/** Observable budget state for Sam diagnostics / dashboards. Never throws. */
export async function getGoogleBudgetState({ db = null, now = Date.now() } = {}) {
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
  return summarize(state, dailyBudget())
}

export default {
  KV_KEY,
  isGoogleBudgetEnabled,
  dailyBudget,
  tryConsumeGoogleQuery,
  getGoogleBudgetState,
}
