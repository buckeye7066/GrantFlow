/**
 * crawlLogStore.js
 *
 * Canonical run-summary log for crawlers. `crawl_logs` is the table the
 * Diagnostics page and diagnosticsService read for "last crawl activity",
 * error history, and the crawl-log count. Historically crawlers never wrote
 * to it (only a legacy test harness did), so the count sat at 0.
 *
 * Canonical split (per the audit decision):
 *   - crawl_logs    → ONE row per crawler RUN (this module). Summary level:
 *                     source/status/records/duration. Read by Diagnostics.
 *   - crawler_logs  → line-level audit detail (opportunityMatcher etc.). Kept.
 *
 * Every write is best-effort and idempotently self-heals the table, so a
 * logging failure can never break a crawler run.
 */

import crypto from 'node:crypto'

const isPostgres = (db) => db?.dialect === 'postgres'

// crawl_logs.status CHECK allows only these values.
export const CRAWL_LOG_STATUSES = Object.freeze(['started', 'success', 'error', 'partial'])

let schemaReady = new WeakMap()
export function _resetCrawlLogSchemaCache() { schemaReady = new WeakMap() }

export async function ensureCrawlLogsSchema(db) {
  if (!db || typeof db.prepare !== 'function' || schemaReady.has(db)) return
  const tsType = isPostgres(db) ? 'TIMESTAMPTZ' : 'DATETIME'
  const now = isPostgres(db) ? 'now()' : 'CURRENT_TIMESTAMP'
  const idDefault = isPostgres(db) ? 'gen_random_uuid()::text' : 'lower(hex(randomblob(16)))'
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS crawl_logs (
        id TEXT PRIMARY KEY DEFAULT (${idDefault}),
        created_at ${tsType} DEFAULT ${now},
        source TEXT NOT NULL,
        status TEXT,
        records_found INTEGER DEFAULT 0,
        records_imported INTEGER DEFAULT 0,
        records_updated INTEGER DEFAULT 0,
        duration_ms INTEGER,
        error_message TEXT,
        metadata TEXT
      )
    `).run()
  } catch { /* table already exists via migrations */ }
  schemaReady.set(db, true)
}

/**
 * Write one run-summary row. Best-effort: never throws.
 *
 * @param {object} db
 * @param {object} entry
 * @param {string} entry.source   crawler type / source name (required)
 * @param {string} entry.status   one of CRAWL_LOG_STATUSES
 * @param {number} [entry.recordsFound]
 * @param {number} [entry.recordsImported]
 * @param {number} [entry.recordsUpdated]
 * @param {number|null} [entry.durationMs]
 * @param {string|null} [entry.errorMessage]
 * @param {object|null} [entry.metadata]
 */
export async function writeCrawlLog(db, {
  source,
  status,
  recordsFound = 0,
  recordsImported = 0,
  recordsUpdated = 0,
  durationMs = null,
  errorMessage = null,
  metadata = null,
} = {}) {
  if (!db || !source) return
  const safeStatus = CRAWL_LOG_STATUSES.includes(status) ? status : 'partial'
  try {
    await ensureCrawlLogsSchema(db)
    await db
      .prepare(`
        INSERT INTO crawl_logs (
          id, source, status, records_found, records_imported, records_updated,
          duration_ms, error_message, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        crypto.randomUUID(),
        String(source),
        safeStatus,
        Number.isFinite(Number(recordsFound)) ? Number(recordsFound) : 0,
        Number.isFinite(Number(recordsImported)) ? Number(recordsImported) : 0,
        Number.isFinite(Number(recordsUpdated)) ? Number(recordsUpdated) : 0,
        Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
        errorMessage ? String(errorMessage).slice(0, 2000) : null,
        metadata ? JSON.stringify(metadata) : null,
      )
  } catch (err) {
    // Logging must never break a crawl.
    console.warn('[crawl_logs] write failed (non-fatal):', err?.message || err)
  }
}

export async function countCrawlLogs(db) {
  if (!db) return 0
  try {
    const r = await db.prepare('SELECT COUNT(*) AS n FROM crawl_logs').get()
    return Number(r?.n || 0)
  } catch {
    return 0
  }
}
