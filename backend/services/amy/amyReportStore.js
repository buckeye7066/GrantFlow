/**
 * amyReportStore.js
 *
 * Durable persistence for Amy's combined crawler-improvement reports so the
 * admin panel can read them after a run. Uses system_kv (dialect-agnostic
 * key/value) — mirrors the self-heal status pattern. Keeps:
 *   - amy_last_report     : the full latest combined report
 *   - amy_recent_runs     : capped array of run summaries (history)
 *   - amy_approval_queue  : open deeper-improvement proposals queued for an operator decision
 */

import { createLogger } from '../../utils/logger.js'

const log = createLogger('services:amy:reportStore')

const KEY_LATEST = 'amy_last_report'
const KEY_HISTORY = 'amy_recent_runs'
const KEY_APPROVALS = 'amy_approval_queue'
const HISTORY_MAX = 20

async function ensureTable(db) {
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
  } catch {
    // Table may already exist with a richer shape on some dialects — fine.
  }
}

async function kvSet(db, key, obj) {
  await ensureTable(db)
  const now = new Date().toISOString()
  const value = JSON.stringify(obj)
  const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, now, key)
  const changed = Number(res?.changes ?? res?.rowCount ?? 0)
  if (!changed) {
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, now)
  }
}

async function kvGet(db, key) {
  try {
    await ensureTable(db)
    const row = await db.prepare('SELECT value, updated_at FROM system_kv WHERE key = ?').get(key)
    if (!row?.value) return null
    const parsed = JSON.parse(row.value)
    return { value: parsed, updated_at: row.updated_at }
  } catch (err) {
    log.warn('kvGet failed', { key, error: err?.message })
    return null
  }
}

/** Persist a combined Amy report: latest + history + open approval queue. */
export async function saveAmyReport(db, report) {
  if (!db || !report) return false
  try {
    await kvSet(db, KEY_LATEST, report)

    const history = (await kvGet(db, KEY_HISTORY))?.value || []
    const summaryRow = {
      run_id: report.run_id,
      completed_at: report.completed_at,
      slider_floor: report.slider_floor,
      metrics_before: report.metrics?.before || null,
      metrics_after: report.metrics?.after || null,
      tuning: report.tuning ? { changed: report.tuning.change, from: report.tuning.from, to: report.tuning.to } : null,
      approval_queue_size: Array.isArray(report.approval_queue) ? report.approval_queue.length : 0,
      summary: report.amy?.summary || null,
    }
    const nextHistory = [summaryRow, ...(Array.isArray(history) ? history : [])].slice(0, HISTORY_MAX)
    await kvSet(db, KEY_HISTORY, nextHistory)

    if (Array.isArray(report.approval_queue)) {
      await kvSet(db, KEY_APPROVALS, { items: report.approval_queue, updated_run_id: report.run_id, updated_at: report.completed_at })
    }
    return true
  } catch (err) {
    log.warn('saveAmyReport failed', { error: err?.message })
    return false
  }
}

export async function readLatestAmyReport(db) {
  const r = await kvGet(db, KEY_LATEST)
  return r ? { ...r.value, persisted_at: r.updated_at } : null
}

export async function readAmyHistory(db) {
  const r = await kvGet(db, KEY_HISTORY)
  return r?.value || []
}

export async function readAmyApprovalQueue(db) {
  const r = await kvGet(db, KEY_APPROVALS)
  return r ? { ...r.value, persisted_at: r.updated_at } : { items: [] }
}

export default { saveAmyReport, readLatestAmyReport, readAmyHistory, readAmyApprovalQueue }
