/**
 * Durable, human-attested proof for a portal submission completed outside
 * GrantFlow. Procedural SQLite migration because ADD COLUMN IF NOT EXISTS is
 * unavailable on supported SQLite versions and a trigger body cannot pass the
 * SQL migration runner's idempotent-statement splitter.
 */
export default async function migrateHamiltonManualSubmissionReceipts(db) {
  const documentColumns = await db.prepare('PRAGMA table_info(documents)').all()
  if (!(documentColumns || []).some((column) => column.name === 'file_bytes')) {
    await db.exec('ALTER TABLE documents ADD COLUMN file_bytes BLOB')
  }

  // This column was historically created by the runtime schema self-heal,
  // rather than a numbered migration. Receipt triggers reference it directly,
  // so add it here before installing the trigger. Otherwise SQLite can create
  // the trigger from schema.sql but later fail an unrelated ALTER TABLE while
  // recompiling that trigger on a legacy database.
  const applicationTaskColumns = await db.prepare('PRAGMA table_info(application_tasks)').all()
  if (!(applicationTaskColumns || []).some((column) => column.name === 'output_proposal_document_id')) {
    await db.exec('ALTER TABLE application_tasks ADD COLUMN output_proposal_document_id TEXT')
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS hamilton_manual_submission_receipts (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      task_id TEXT NOT NULL REFERENCES application_tasks(id) ON DELETE RESTRICT,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
      document_id TEXT NOT NULL UNIQUE REFERENCES documents(id) ON DELETE RESTRICT,
      channel TEXT NOT NULL DEFAULT 'portal_manual'
        CHECK(channel = 'portal_manual'),
      portal_origin TEXT NOT NULL,
      portal_target_sha256 TEXT NOT NULL CHECK(length(portal_target_sha256) = 64),
      task_identity_sha256 TEXT NOT NULL CHECK(length(task_identity_sha256) = 64),
      confirmation_reference TEXT,
      submitted_at DATETIME NOT NULL,
      attestation_version TEXT NOT NULL,
      attested_by_user_id TEXT NOT NULL,
      attested_at DATETIME NOT NULL,
      receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256) = 64),
      file_size INTEGER NOT NULL CHECK(file_size > 0 AND file_size <= 10485760),
      mime_type TEXT NOT NULL
        CHECK(mime_type IN ('application/pdf', 'image/png', 'image/jpeg')),
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'revoked')),
      revoked_at DATETIME,
      revoked_by_user_id TEXT,
      revocation_reason TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(task_id, idempotency_key)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ux_hamilton_manual_receipt_active_task
      ON hamilton_manual_submission_receipts(task_id)
      WHERE status = 'active';

    CREATE INDEX IF NOT EXISTS idx_hamilton_manual_receipt_profile
      ON hamilton_manual_submission_receipts(profile_id);

    CREATE INDEX IF NOT EXISTS idx_hamilton_manual_receipt_document
      ON hamilton_manual_submission_receipts(document_id);

    CREATE TRIGGER IF NOT EXISTS trg_hamilton_manual_receipt_document_immutable
    BEFORE UPDATE OF file_bytes, content_hash ON documents
    FOR EACH ROW
    WHEN EXISTS (
      SELECT 1
        FROM hamilton_manual_submission_receipts
       WHERE document_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'manual submission receipt evidence is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_hamilton_manual_receipt_no_delete
    BEFORE DELETE ON hamilton_manual_submission_receipts
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'manual submission receipt bindings are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_hamilton_manual_receipt_monotonic_revoke
    BEFORE UPDATE ON hamilton_manual_submission_receipts
    FOR EACH ROW
    WHEN OLD.status = 'revoked'
      OR NEW.status <> 'revoked'
      OR NEW.revoked_at IS NULL
      OR NEW.revoked_by_user_id IS NULL
      OR NEW.revocation_reason IS NULL
      OR NEW.id IS NOT OLD.id
      OR NEW.task_id IS NOT OLD.task_id
      OR NEW.profile_id IS NOT OLD.profile_id
      OR NEW.document_id IS NOT OLD.document_id
      OR NEW.channel IS NOT OLD.channel
      OR NEW.portal_origin IS NOT OLD.portal_origin
      OR NEW.portal_target_sha256 IS NOT OLD.portal_target_sha256
      OR NEW.task_identity_sha256 IS NOT OLD.task_identity_sha256
      OR NEW.confirmation_reference IS NOT OLD.confirmation_reference
      OR NEW.submitted_at IS NOT OLD.submitted_at
      OR NEW.attestation_version IS NOT OLD.attestation_version
      OR NEW.attested_by_user_id IS NOT OLD.attested_by_user_id
      OR NEW.attested_at IS NOT OLD.attested_at
      OR NEW.receipt_sha256 IS NOT OLD.receipt_sha256
      OR NEW.file_size IS NOT OLD.file_size
      OR NEW.mime_type IS NOT OLD.mime_type
      OR NEW.idempotency_key IS NOT OLD.idempotency_key
      OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
      OR NEW.created_at IS NOT OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'manual submission receipt bindings are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_hamilton_manual_receipt_task_identity
    BEFORE UPDATE OF user_id, profile_id, opportunity_id, grant_id,
      status, current_step, submitted_at, completed_at,
      portal_url, application_url, portal_id, application_id,
      university_application_id, automation_type, output_document_id,
      output_pdf_document_id, output_docx_document_id,
      output_proposal_document_id, auto_submit_enabled, allow_auto_submit
      ON application_tasks
    FOR EACH ROW
    WHEN EXISTS (
      SELECT 1
        FROM hamilton_manual_submission_receipts
       WHERE task_id = OLD.id AND status = 'active'
    ) AND (
      NEW.user_id IS NOT OLD.user_id
      OR NEW.profile_id IS NOT OLD.profile_id
      OR NEW.opportunity_id IS NOT OLD.opportunity_id
      OR NEW.grant_id IS NOT OLD.grant_id
      OR NEW.status IS NOT OLD.status
      OR NEW.current_step IS NOT OLD.current_step
      OR NEW.submitted_at IS NOT OLD.submitted_at
      OR NEW.completed_at IS NOT OLD.completed_at
      OR NEW.portal_url IS NOT OLD.portal_url
      OR NEW.application_url IS NOT OLD.application_url
      OR NEW.portal_id IS NOT OLD.portal_id
      OR NEW.application_id IS NOT OLD.application_id
      OR NEW.university_application_id IS NOT OLD.university_application_id
      OR NEW.automation_type IS NOT OLD.automation_type
      OR NEW.output_document_id IS NOT OLD.output_document_id
      OR NEW.output_pdf_document_id IS NOT OLD.output_pdf_document_id
      OR NEW.output_docx_document_id IS NOT OLD.output_docx_document_id
      OR NEW.output_proposal_document_id IS NOT OLD.output_proposal_document_id
      OR NEW.auto_submit_enabled IS NOT OLD.auto_submit_enabled
      OR NEW.allow_auto_submit IS NOT OLD.allow_auto_submit
    )
    BEGIN
      SELECT RAISE(ABORT, 'active manual submission receipt locks task identity');
    END;
  `)
}
