// 163_hamilton_submission_attempt_states.mjs (SQLite)
//
// Widen application_tasks.status for the durable external-submit boundary.
// SQLite cannot drop an inline CHECK constraint with ALTER TABLE, and the live
// table has accumulated columns across many migrations, so rebuilding it from a
// hand-copied column list would risk data loss. As in migration 076, this
// surgically rewrites only the status CHECK in sqlite_master, bumps
// schema_version, and verifies integrity before the migration transaction can
// commit.

export const APPLICATION_TASK_STATUSES = Object.freeze([
  'queued',
  'ready',
  'waiting_for_user',
  'waiting_for_admin',
  'blocked_login_required',
  'blocked_missing_info',
  'blocked_2fa',
  'blocked_captcha',
  'blocked_terms_or_policy',
  'in_progress',
  'draft_completed',
  'submitted',
  'failed',
  'cancelled',
  'analyzing',
  'ready_to_start',
  'generating_application',
  'generating_documents',
  'saving_documents',
  'launching_portal',
  'waiting_for_login',
  'waiting_for_2fa',
  'waiting_for_captcha',
  'waiting_for_email_verification',
  'waiting_for_window',
  'waiting_for_missing_info',
  'filling_portal',
  'submit_attempt_started',
  'submit_evidence_pending',
  'submission_verification_required',
  'saving_portal_draft',
  'waiting_for_review',
  'ready_to_submit',
  'ready_to_print_mail',
  'ready_to_email',
  'ready_to_fax',
  'completed',
  'blocked',
])

const STATUS_CHECK_RX = /CHECK\s*\(\s*status\s+IN\s*\((?:\s*'[^']*'\s*,?)+\s*\)\s*\)/i

function quotedStatusList() {
  return APPLICATION_TASK_STATUSES
    .map((status) => `'${String(status).replace(/'/g, "''")}'`)
    .join(', ')
}

export default async function up(db) {
  const row = await db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'application_tasks'`)
    .get()
  if (!row || typeof row.sql !== 'string') return

  const match = row.sql.match(STATUS_CHECK_RX)
  // Runtime-created minimal/test tables intentionally have no inline CHECK;
  // the applicationTaskStore's TASK_STATUSES validation remains authoritative.
  if (!match) return

  const nextCheck = `CHECK(status IN (${quotedStatusList()}))`
  if (match[0] === nextCheck) return
  const rewrittenSql = row.sql.replace(STATUS_CHECK_RX, nextCheck)
  if (rewrittenSql === row.sql) {
    throw new Error('163_hamilton_submission_attempt_states: application_tasks status CHECK was not rewritten')
  }
  if (typeof db.unsafeMode !== 'function') {
    throw new Error('163_hamilton_submission_attempt_states: SQLite unsafeMode is required for schema rewrite')
  }

  const versionRow = await db.prepare('PRAGMA schema_version').get()
  const schemaVersion = Number(versionRow?.schema_version ?? 0)

  db.unsafeMode(true)
  try {
    await db.exec('PRAGMA writable_schema = ON')
    await db
      .prepare(`UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'application_tasks'`)
      .run(rewrittenSql)
    await db.exec(`PRAGMA schema_version = ${schemaVersion + 1}`)
  } finally {
    try { await db.exec('PRAGMA writable_schema = OFF') } finally { db.unsafeMode(false) }
  }

  const integrity = await db.prepare('PRAGMA integrity_check').all()
  const ok = Array.isArray(integrity)
    && integrity.every((item) => String(item?.integrity_check || '').toLowerCase() === 'ok')
  if (!ok) {
    throw new Error(
      `163_hamilton_submission_attempt_states: integrity_check failed — ${JSON.stringify(integrity)}`,
    )
  }
}
