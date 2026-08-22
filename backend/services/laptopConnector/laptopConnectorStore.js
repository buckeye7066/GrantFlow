/**
 * laptopConnectorStore — persistence for the Laptop Connector pipeline.
 *
 * Three tables (migration 108 / pg 0105):
 *   laptop_ingest_runs      — one row per connector scan
 *   laptop_source_documents — provenance per ingested file (no bytes)
 *   laptop_review_items     — the check-off inbox (pending → accepted/dismissed)
 *
 * All writes go through here so the route + analyzer never hand-roll SQL and
 * the dialect quirks (NOW() vs CURRENT_TIMESTAMP) live in one place.
 */

import { randomUUID } from 'node:crypto'
import { safeParseJSON } from '../../utils/safeJson.js'

function nowFn(db) {
  return db?.dialect === 'postgres' ? 'NOW()' : 'CURRENT_TIMESTAMP'
}

function safeStringify(value, fallback = '{}') {
  try {
    return JSON.stringify(value ?? (fallback === '[]' ? [] : {}))
  } catch {
    return fallback
  }
}

// --- runs --------------------------------------------------------------------

export async function createRun(db, { host, connectorVersion, rootPaths } = {}) {
  const id = randomUUID()
  await db
    .prepare(
      `INSERT INTO laptop_ingest_runs (id, host, connector_version, root_paths_json, status)
       VALUES (?, ?, ?, ?, 'running')`,
    )
    .run(id, host || null, connectorVersion || null, safeStringify(rootPaths, '[]'))
  return id
}

export async function getRun(db, id) {
  return db.prepare('SELECT * FROM laptop_ingest_runs WHERE id = ? LIMIT 1').get(String(id))
}

/**
 * Atomically bump the per-run counters. Called once per ingested file so the
 * run row reflects live progress even before completion.
 */
export async function bumpRunCounters(db, runId, { scanned = 0, skipped = 0, ingested = 0, candidates = 0 } = {}) {
  await db
    .prepare(
      `UPDATE laptop_ingest_runs
       SET files_scanned   = files_scanned   + ?,
           files_skipped   = files_skipped   + ?,
           files_ingested  = files_ingested  + ?,
           candidates_created = candidates_created + ?
       WHERE id = ?`,
    )
    .run(Number(scanned) || 0, Number(skipped) || 0, Number(ingested) || 0, Number(candidates) || 0, runId)
}

export async function completeRun(db, runId, { status = 'completed', summary = {}, errorText = null } = {}) {
  await db
    .prepare(
      `UPDATE laptop_ingest_runs
       SET status = ?, summary_json = ?, error_text = ?, completed_at = ${nowFn(db)}
       WHERE id = ?`,
    )
    .run(status, safeStringify(summary), errorText, runId)
}

export async function listRuns(db, { limit = 20 } = {}) {
  const rows = await db
    .prepare('SELECT * FROM laptop_ingest_runs ORDER BY started_at DESC LIMIT ?')
    .all(Math.min(Number(limit) || 20, 100))
  return (rows || []).map((r) => ({ ...r, summary: safeParseJSON(r.summary_json, {}) }))
}

// --- source documents --------------------------------------------------------

export async function findDocumentByHash(db, hash) {
  if (!hash) return null
  return db
    .prepare('SELECT * FROM laptop_source_documents WHERE file_hash = ? LIMIT 1')
    .get(String(hash))
}

export async function insertSourceDocument(
  db,
  { runId, filePath, fileName, fileType, fileHash, byteSize, modifiedAt, charCount } = {},
) {
  const id = randomUUID()
  await db
    .prepare(
      `INSERT INTO laptop_source_documents
         (id, run_id, file_path, file_name, file_type, file_hash, byte_size, modified_at, char_count, analyzed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowFn(db)})`,
    )
    .run(
      id,
      runId || null,
      filePath,
      fileName || null,
      fileType || null,
      fileHash || null,
      Number(byteSize) || null,
      modifiedAt || null,
      Number(charCount) || 0,
    )
  return id
}

export async function setDocumentCandidateCount(db, documentId, count) {
  await db
    .prepare('UPDATE laptop_source_documents SET candidate_count = ? WHERE id = ?')
    .run(Number(count) || 0, documentId)
}

// --- review items ------------------------------------------------------------

export async function insertReviewItem(
  db,
  { runId, documentId, candidateType, targetProfileId, title, summary, payload, provenance, confidence } = {},
) {
  const id = randomUUID()
  await db
    .prepare(
      `INSERT INTO laptop_review_items
         (id, run_id, document_id, candidate_type, target_profile_id, title, summary,
          payload_json, provenance_json, confidence, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .run(
      id,
      runId || null,
      documentId || null,
      candidateType,
      targetProfileId || null,
      String(title || '').slice(0, 200) || '(untitled)',
      summary ? String(summary).slice(0, 500) : null,
      safeStringify(payload),
      safeStringify(provenance),
      Math.max(0, Math.min(1, Number(confidence) || 0)),
    )
  return id
}

export function mapReviewItem(row) {
  if (!row) return null
  return {
    id: row.id,
    run_id: row.run_id,
    document_id: row.document_id,
    candidate_type: row.candidate_type,
    target_profile_id: row.target_profile_id,
    title: row.title,
    summary: row.summary,
    payload: safeParseJSON(row.payload_json, {}),
    provenance: safeParseJSON(row.provenance_json, {}),
    confidence: typeof row.confidence === 'number' ? row.confidence : Number(row.confidence) || 0,
    status: row.status,
    created_at: row.created_at,
    acted_at: row.acted_at,
    action_result: row.action_result,
  }
}

export async function getReviewItem(db, id) {
  return db.prepare('SELECT * FROM laptop_review_items WHERE id = ? LIMIT 1').get(String(id))
}

export async function listPendingReviewItems(db, { candidateType = null, limit = 100 } = {}) {
  const cap = Math.min(Number(limit) || 100, 500)
  let rows
  if (candidateType) {
    rows = await db
      .prepare(
        `SELECT * FROM laptop_review_items
         WHERE status = 'pending' AND candidate_type = ?
         ORDER BY confidence DESC, created_at DESC LIMIT ?`,
      )
      .all(candidateType, cap)
  } else {
    rows = await db
      .prepare(
        `SELECT * FROM laptop_review_items
         WHERE status = 'pending'
         ORDER BY candidate_type ASC, confidence DESC, created_at DESC LIMIT ?`,
      )
      .all(cap)
  }
  return (rows || []).map(mapReviewItem)
}

export async function markReviewItem(db, id, status, actionResult = null) {
  await db
    .prepare(
      `UPDATE laptop_review_items
       SET status = ?, acted_at = ${nowFn(db)}, action_result = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(status, actionResult ? String(actionResult).slice(0, 300) : null, id)
}

/**
 * Bulk-dismiss pending review items. Target is (in priority order): an explicit
 * id list, else a single candidate_type, else EVERY pending item. Only rows
 * still in 'pending' flip to 'dismissed', so the op is idempotent and can never
 * resurrect an accepted row. Returns { requested, dismissed } — requested is
 * the count of pending rows the predicate matched BEFORE the update, so the
 * caller can report requested == dismissed + skipped honestly regardless of DB
 * driver .changes semantics.
 */
export async function bulkDismissReviewItems(
  db,
  { ids = null, candidateType = null, reason = 'user_bulk_dismissed' } = {},
) {
  const safeReason = String(reason || 'user_bulk_dismissed').slice(0, 200)
  let whereSql = "status = 'pending'"
  let params = []
  if (Array.isArray(ids) && ids.length) {
    const chunk = ids.slice(0, 1000)
    whereSql += ` AND id IN (${chunk.map(() => '?').join(',')})`
    params = chunk
  } else if (candidateType) {
    whereSql += ' AND candidate_type = ?'
    params = [candidateType]
  }
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM laptop_review_items WHERE ${whereSql}`)
    .get(...params)
  const requested = Number(countRow?.n) || 0
  if (requested > 0) {
    await db
      .prepare(
        `UPDATE laptop_review_items
         SET status = 'dismissed', acted_at = ${nowFn(db)}, action_result = ?
         WHERE ${whereSql}`,
      )
      .run(safeReason, ...params)
  }
  return { requested, dismissed: requested }
}
