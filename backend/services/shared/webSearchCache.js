/**
 * Persistent, bounded SERP cache — the STRUCTURAL half of the search-backend
 * durability fix (2026-07-28).
 *
 * WHY: the nightly fan-out (Amy's 50-synthetic cohort × 6-8 queries, the
 * parity benchmark, coverage sweeps) fires hundreds of queries at the
 * self-hosted SearXNG in a few hours, and MANY are near-duplicates night over
 * night (archetype queries like "<school> scholarships" recur verbatim; the
 * two golden profiles even share queries within one run). That sustained
 * volume is what rate-limits/CAPTCHAs the upstream engines ("Suspended: too
 * many requests"), collapsing the fleet to bing-only junk — the
 * institution_recall_miss / parity-regression root cause that has now
 * recurred twice (2026-07-27, 2026-07-28). Pacing spreads the load; this
 * cache REMOVES the repeated share of it: a query answered within the TTL
 * never re-hits an upstream engine.
 *
 * Semantics:
 * - Only HEALTHY result sets are cached (webSearchEngine caches on its clean
 *   return paths only — held/degenerate junk is never persisted, so a bad
 *   night cannot poison the next day).
 * - TTL default 20h (WEB_SEARCH_CACHE_TTL_HOURS; 0 disables) — nightly jobs
 *   get one fresh upstream pass per day per query, intra-night repeats are
 *   free.
 * - Bounded: expired rows are pruned opportunistically on write and the table
 *   is capped (oldest evicted) so it can never grow unbounded.
 * - Best-effort everywhere: no db, a schema hiccup, or any throw → cache
 *   miss / silent skip. searchWeb's behavior without a db is byte-identical
 *   to before this module existed.
 * - Lazy CREATE TABLE IF NOT EXISTS (the conditionSourceSearch precedent) —
 *   works on both the SQLite and Postgres shims without a migration.
 */

import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:webSearchCache')

export const CACHE_TABLE = 'web_search_cache'
const MAX_ROWS = 5000

let _ensured = false

function ttlMs() {
  const raw = Number(process.env.WEB_SEARCH_CACHE_TTL_HOURS)
  const hours = Number.isFinite(raw) && raw >= 0 ? raw : 20
  return hours * 3600 * 1000
}

/** Test seam. */
export function _resetWebSearchCacheForTests() {
  _ensured = false
}

function normalizeQueryKey(query) {
  return String(query || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

async function resolveDb(db) {
  if (db) return db
  // In the unit-test runner, never reach for the real DB — tests inject one.
  if (process.env.GRANTFLOW_TEST_RUNNER === '1') return null
  try {
    const mod = await import('../../db/index.js')
    return mod.getDb ? mod.getDb() : null
  } catch {
    return null
  }
}

async function ensureTable(db) {
  if (_ensured) return
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS ${CACHE_TABLE} (
       query_key TEXT PRIMARY KEY,
       query TEXT,
       results_json TEXT,
       created_at TEXT
     )`,
  ).run()
  _ensured = true
}

/**
 * Return cached results for a query, or null on miss/expiry/any failure.
 * Results are sliced to `count`.
 */
export async function getCachedSearch(query, { count = 8, db = null, now = Date.now } = {}) {
  if (ttlMs() === 0) return null
  const key = normalizeQueryKey(query)
  if (!key) return null
  try {
    const conn = await resolveDb(db)
    if (!conn?.prepare) return null
    await ensureTable(conn)
    const row = await conn.prepare(`SELECT results_json, created_at FROM ${CACHE_TABLE} WHERE query_key = ?`).get(key)
    if (!row?.results_json) return null
    const age = now() - Date.parse(row.created_at || '')
    if (!Number.isFinite(age) || age > ttlMs()) return null
    const parsed = JSON.parse(row.results_json)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    return parsed.slice(0, Math.max(1, count))
  } catch (err) {
    log.warn(`[webSearchCache] read failed for "${key}": ${err?.message ?? err}`)
    return null
  }
}

/**
 * Store a HEALTHY result set. Caller is responsible for only passing sets it
 * would itself return as healthy (never held/degenerate junk). Never throws.
 */
export async function putCachedSearch(query, results, { db = null, now = Date.now } = {}) {
  if (ttlMs() === 0) return false
  const key = normalizeQueryKey(query)
  if (!key || !Array.isArray(results) || results.length === 0) return false
  try {
    const conn = await resolveDb(db)
    if (!conn?.prepare) return false
    await ensureTable(conn)
    const at = new Date(now()).toISOString()
    const json = JSON.stringify(results.map((r) => ({ url: r.url, title: r.title || '', snippet: r.snippet || '' })))
    const res = await conn.prepare(
      `UPDATE ${CACHE_TABLE} SET query = ?, results_json = ?, created_at = ? WHERE query_key = ?`,
    ).run(String(query), json, at, key)
    if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
      await conn.prepare(
        `INSERT INTO ${CACHE_TABLE} (query_key, query, results_json, created_at) VALUES (?, ?, ?, ?)`,
      ).run(key, String(query), json, at)
    }
    await pruneCache(conn, now)
    return true
  } catch (err) {
    log.warn(`[webSearchCache] write failed for "${key}": ${err?.message ?? err}`)
    return false
  }
}

// Opportunistic bound: drop expired rows, then evict oldest past the cap.
async function pruneCache(conn, now = Date.now) {
  try {
    const cutoff = new Date(now() - ttlMs()).toISOString()
    await conn.prepare(`DELETE FROM ${CACHE_TABLE} WHERE created_at < ?`).run(cutoff)
    const row = await conn.prepare(`SELECT COUNT(*) AS n FROM ${CACHE_TABLE}`).get()
    const n = Number(row?.n ?? 0)
    if (n > MAX_ROWS) {
      await conn.prepare(
        `DELETE FROM ${CACHE_TABLE} WHERE query_key IN (
           SELECT query_key FROM ${CACHE_TABLE} ORDER BY created_at ASC LIMIT ?
         )`,
      ).run(n - MAX_ROWS)
    }
  } catch {
    /* bound is best-effort */
  }
}

export default { getCachedSearch, putCachedSearch, _resetWebSearchCacheForTests, CACHE_TABLE }
