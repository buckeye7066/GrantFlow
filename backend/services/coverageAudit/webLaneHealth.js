/**
 * webLaneHealth.js — observability for the open-web discovery lane.
 *
 * The web lane (webLane.js: profile-keyed search → LLM extraction → reality
 * gate) is the ONLY path to county/community/foundation funding — the exact
 * coverage the hyperlocal/institution gap classes measure. It is deliberately
 * best-effort: a dead search backend (Brave 402, SearXNG upstream engines
 * suspended, DDG throttling) or an exhausted LLM key degrades it to a silent
 * no-op. That silence is the defect this module fixes: in July 2026 the lane
 * was dead for 3+ days and the only symptom was every live crawl logging a
 * hyperlocal gap — the CONSEQUENCE, not the cause.
 *
 * After every live (non-dry-run) discovery, runProfileDiscoveryLive records the
 * lane's telemetry here (system_kv `web_lane_health`, rolling last-N runs).
 * Sam's `crawler.webLaneHealth` check reads it and reds out when recent runs
 * consistently produce zero search pages — naming the layer that died instead
 * of leaving operators to reverse-engineer it from gap counts.
 *
 * Pure fold + summary are separated from I/O so they unit-test with fixtures,
 * mirroring liveCrawlGapLearning.js.
 */

import { createLogger } from '../../utils/logger.js'

const log = createLogger('coverage:webLaneHealth')

/** system_kv key holding the rolling web-lane health store. */
export const KV_KEY = 'web_lane_health'

/** How many recent lane runs to retain. */
export const RECENT_CAP = 30

/** How many recent runs the Sam check judges (must all be dead to alert). */
export const JUDGE_LAST_N = 8

/** Minimum recent runs before the Sam check may alert (avoid cold-start noise). */
export const MIN_RUNS_TO_JUDGE = 5

/**
 * PURE: fold one lane run's telemetry into the rolling store.
 *
 * @param {object|null} prev  previous store value
 * @param {object} entry      { at, profile_id, ok, queries, pages, fetched,
 *                              extracted, stored, reason, error }
 * @returns {{ totals:object, recent:Array, updated_at:string|null }}
 */
export function buildWebLaneHealthUpdate(prev, entry = {}) {
  const base = prev && typeof prev === 'object' ? prev : {}
  const prevTotals = base.totals && typeof base.totals === 'object' ? base.totals : {}
  const totals = {
    runs: (Number(prevTotals.runs) || 0) + 1,
    zero_page_runs: Number(prevTotals.zero_page_runs) || 0,
    stored_total: (Number(prevTotals.stored_total) || 0) + (Number(entry.stored) || 0),
  }
  const pages = Number(entry.pages) || 0
  if (pages === 0) totals.zero_page_runs += 1

  const slim = {
    at: entry.at ?? null,
    profile_id: entry.profile_id ?? null,
    ok: entry.ok !== false,
    queries: Number(entry.queries) || 0,
    pages,
    fetched: Number(entry.fetched) || 0,
    extracted: Number(entry.extracted) || 0,
    stored: Number(entry.stored) || 0,
    reason: entry.reason ?? null,
    error: entry.error ?? null,
  }
  const recent = [slim, ...(Array.isArray(base.recent) ? base.recent : [])].slice(0, RECENT_CAP)
  return { totals, recent, updated_at: entry.at ?? base.updated_at ?? null }
}

/**
 * PURE: judge the last N runs. `dead` is true when there are enough runs to
 * judge AND every one of them produced zero search pages (queries ran, nothing
 * came back — the search backend layer, not one unlucky profile) or errored.
 *
 * @param {object|null} store
 * @param {{ lastN?:number, minRuns?:number }} [opts]
 */
export function summarizeRecentWebLane(store, { lastN = JUDGE_LAST_N, minRuns = MIN_RUNS_TO_JUDGE } = {}) {
  const recent = Array.isArray(store?.recent) ? store.recent.slice(0, lastN) : []
  const judged = recent.length
  const zeroPage = recent.filter((r) => (Number(r?.pages) || 0) === 0).length
  const errored = recent.filter((r) => r?.error).length
  const stored = recent.reduce((n, r) => n + (Number(r?.stored) || 0), 0)
  const reasons = [...new Set(recent.map((r) => r?.error || r?.reason).filter(Boolean))].slice(0, 4)
  return {
    judged,
    zero_page: zeroPage,
    errored,
    stored,
    reasons,
    dead: judged >= minRuns && zeroPage === judged,
  }
}

async function ensureKv(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
}

/** Read the rolling web-lane health store (Sam diagnostics / Anya tools). */
export async function getWebLaneHealth(db) {
  if (!db?.prepare) return null
  try {
    await ensureKv(db)
    const row = await db.prepare('SELECT value, updated_at FROM system_kv WHERE key = ?').get(KV_KEY)
    if (!row?.value) return null
    const parsed = JSON.parse(row.value)
    return { ...parsed, updated_at: row.updated_at ?? parsed.updated_at ?? null }
  } catch {
    return null
  }
}

/**
 * Record one live lane run. Best-effort: never throws (health telemetry must
 * never fail a crawl).
 *
 * @param {object} db
 * @param {object} args { profileId, telemetry } — telemetry is run.web_lane
 *                      from runProfileDiscoveryLive ({ ok, queries[], pages,
 *                      fetched, extracted, stored, reason?, error? }).
 */
export async function recordWebLaneRun(db, { profileId = null, telemetry = null, at = null } = {}) {
  if (!db?.prepare || !telemetry || typeof telemetry !== 'object') return { skipped: true }
  try {
    const entry = {
      at: at ?? new Date().toISOString(),
      profile_id: profileId,
      ok: telemetry.ok !== false,
      queries: Array.isArray(telemetry.queries) ? telemetry.queries.length : Number(telemetry.queries) || 0,
      pages: telemetry.pages,
      fetched: telemetry.fetched,
      extracted: telemetry.extracted,
      stored: telemetry.stored,
      reason: telemetry.reason ?? null,
      error: telemetry.error ?? null,
    }
    await ensureKv(db)
    const prev = await getWebLaneHealth(db)
    const next = buildWebLaneHealthUpdate(prev, entry)
    const now = next.updated_at || new Date().toISOString()
    const value = JSON.stringify(next)
    const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, now, KV_KEY)
    if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
      await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(KV_KEY, value, now)
    }
    return { ok: true }
  } catch (err) {
    log.warn('web-lane health record failed (non-fatal)', { profile: profileId, error: err?.message })
    return { ok: false, error: err?.message }
  }
}

export default {
  KV_KEY,
  RECENT_CAP,
  JUDGE_LAST_N,
  MIN_RUNS_TO_JUDGE,
  buildWebLaneHealthUpdate,
  summarizeRecentWebLane,
  getWebLaneHealth,
  recordWebLaneRun,
}
