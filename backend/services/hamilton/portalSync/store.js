/**
 * portalSync/store.js
 *
 * Persistence for portal sync runs. Self-healing schema (mirrors the
 * ensurePipelineDismissalsSchema pattern) so the feature works even on a DB
 * where the migration runner hasn't run yet. Per-db WeakMap cache so concurrent
 * node:test suites (each with its own in-memory db) don't race on a global flag.
 */

import crypto from 'node:crypto'

let schemaReady = new WeakMap()
export function _resetPortalSyncSchemaCache() { schemaReady = new WeakMap() }

export async function ensurePortalSyncSchema(db) {
  if (!db || schemaReady.has(db) || typeof db.prepare !== 'function') return
  const isPostgres = db?.dialect === 'postgres'
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  const jsonType = isPostgres ? 'JSONB' : 'TEXT'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS portal_sync_runs (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      profile_id TEXT NOT NULL,
      portal_host TEXT NOT NULL,
      connector_id TEXT,
      direction TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      summary ${jsonType},
      error TEXT,
      actor_user_id TEXT,
      started_at ${tsType} DEFAULT ${nowFn},
      finished_at ${tsType}
    );
    CREATE INDEX IF NOT EXISTS idx_portal_sync_runs_profile ON portal_sync_runs(profile_id);
    CREATE INDEX IF NOT EXISTS idx_portal_sync_runs_host    ON portal_sync_runs(portal_host);
    CREATE INDEX IF NOT EXISTS idx_portal_sync_runs_status  ON portal_sync_runs(status);
  `)
  schemaReady.set(db, true)
}

function rowToRun(row) {
  if (!row) return null
  let summary = null
  if (row.summary) {
    if (typeof row.summary === 'object') summary = row.summary
    else { try { summary = JSON.parse(row.summary) } catch { summary = null } }
  }
  return {
    id: row.id,
    profile_id: row.profile_id,
    portal_host: row.portal_host,
    connector_id: row.connector_id || null,
    direction: row.direction,
    status: row.status,
    summary,
    error: row.error || null,
    actor_user_id: row.actor_user_id || null,
    started_at: row.started_at,
    finished_at: row.finished_at || null,
  }
}

/** Insert a 'running' run row and return its id. */
export async function recordRunStart(db, { profileId, portalHost, connectorId = null, direction, actorUserId = null } = {}) {
  if (!db || !profileId || !portalHost) throw new Error('profileId and portalHost required')
  await ensurePortalSyncSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const id = crypto.randomUUID()
  await db.prepare(
    `INSERT INTO portal_sync_runs
       (id, profile_id, portal_host, connector_id, direction, status, actor_user_id, started_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ${nowFn})`,
  ).run(id, String(profileId), String(portalHost), connectorId, String(direction), actorUserId)
  return id
}

/** Mark a run completed/failed with a summary + optional error. No-op if id is null. */
export async function finishRun(db, runId, { status = 'completed', summary = null, error = null } = {}) {
  if (!db || !runId) return null
  await ensurePortalSyncSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `UPDATE portal_sync_runs SET status = ?, summary = ?, error = ?, finished_at = ${nowFn} WHERE id = ?`,
  ).run(String(status), summary ? JSON.stringify(summary) : null, error ? String(error) : null, String(runId))
  return rowToRun(await db.prepare('SELECT * FROM portal_sync_runs WHERE id = ?').get(String(runId)))
}

/** List runs, optionally filtered by profile and/or host, most recent first. */
export async function listRuns(db, { profileId = null, portalHost = null, limit = 50 } = {}) {
  if (!db) return []
  await ensurePortalSyncSchema(db)
  const where = []
  const params = []
  if (profileId) { where.push('profile_id = ?'); params.push(String(profileId)) }
  if (portalHost) { where.push('portal_host = ?'); params.push(String(portalHost)) }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const lim = Math.max(1, Math.min(500, Number(limit) || 50))
  const rows = await db.prepare(
    `SELECT * FROM portal_sync_runs ${whereSql} ORDER BY started_at DESC LIMIT ${lim}`,
  ).all(...params)
  return (rows || []).map(rowToRun)
}

export default { ensurePortalSyncSchema, recordRunStart, finishRun, listRuns, _resetPortalSyncSchemaCache }
