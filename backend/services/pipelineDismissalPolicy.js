// Closed provenance contract: these are automated gate decisions, never owner intent.
import crypto from 'node:crypto'

export function isAutomaticGateDismissal(row = {}) {
  if (/duplicate/i.test(String(row.reason ?? ''))) return false
  const actor = String(row.dismissed_by ?? '')
  const reason = String(row.reason ?? '')
  if (actor === 'system_crawler_os') return reason === 'crawler_os_reject'
  const gate = '(?:relatable|qualifies|covers_need|engine|real):'
  if (actor === 'system_pipeline_precision') return new RegExp(`^pipeline_precision:${gate}`).test(reason)
  if (['migration:999_strict_pipeline_task_reconciliation', 'migration:1000_fail_closed_hamilton_reconciliation'].includes(actor)) {
    return new RegExp(`^strict_pipeline:${gate}`).test(reason)
  }
  return false
}

export async function withDismissalProfileTransaction(db, profileId, callback) {
  if (db?.dialect === 'postgres') {
    const locked = async tx => {
      await tx.prepare('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?)) AS locked')
        .get('pipeline-dismissal-profile', String(profileId))
      return callback(tx)
    }
    // An explicit PostgresTx already owns its connection and transaction.
    return typeof db.withTransaction === 'function' ? db.withTransaction(locked) : locked(db)
  }
  if (db?.inTransaction === true) return callback(db)
  if (typeof db?.withTransaction === 'function') return db.withTransaction(tx => callback(tx || db))
  // Raw SQLite callers do not have the app adapter's transaction helper.
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = await callback(db)
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
    throw error
  }
}

// INSERT-only archive, in the same transaction as supersession/removal. Failure
// to retain the original row aborts the change rather than losing its history.
export async function archiveDismissal(tx, row, evidence, action = 'automatic_dismissal_revalidated') {
  await tx.prepare(`INSERT INTO audit_events
    (id, actor_type, actor_id, entity_type, entity_id, action, before_json, after_json)
    VALUES (?, 'system', 'automatic-dismissal-revalidation', 'pipeline_dismissal', ?, ?, ?, ?)`)
    .run(crypto.randomUUID(), String(row.id), action, JSON.stringify(row), JSON.stringify(evidence))
}

// PostgreSQL's Date decoder truncates TIMESTAMPTZ microseconds. JSONB retains
// the exact database timestamp string for both the original archive and CAS.
export async function readLockedDismissals(tx, profileId) {
  if (tx.dialect === 'postgres') {
    const rows = await tx.prepare('SELECT to_jsonb(d) AS original_row FROM pipeline_dismissals d WHERE profile_id = ? FOR UPDATE').all(profileId)
    return rows.map(row => typeof row.original_row === 'string' ? JSON.parse(row.original_row) : row.original_row)
  }
  return tx.prepare('SELECT * FROM pipeline_dismissals WHERE profile_id = ?').all(profileId)
}
