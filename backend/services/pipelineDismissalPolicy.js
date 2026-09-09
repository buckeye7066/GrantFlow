// Closed provenance contract: these are automated gate decisions, never owner intent.
import crypto from 'node:crypto'
import { withIdentityTxn } from './opportunityIdentityStore.js'

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
  // An explicit PostgresTx already owns the transaction; never escape onto a
  // second connection. Raw SQLite callers may likewise supply an open tx.
  if (db?.dialect === 'postgres' && typeof db.withTransaction !== 'function') {
    await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?)) AS locked')
      .get('pipeline-dismissal-profile', String(profileId))
    return callback(db)
  }
  if (db?.inTransaction === true) return callback(db)
  return withIdentityTxn(db, 'pipeline-dismissal-profile', String(profileId), callback)
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
