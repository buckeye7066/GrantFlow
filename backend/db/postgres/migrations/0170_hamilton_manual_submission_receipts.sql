-- Durable, human-attested proof for a portal submission completed outside
-- GrantFlow. The receipt binding is append-only: revocation changes the binding
-- state but never deletes or rewrites the uploaded evidence document.

-- Historical releases added this field through the application-task runtime
-- schema invariant. Make the durable migration self-contained before the
-- receipt trigger names the column, including on databases that never ran that
-- runtime self-heal.
ALTER TABLE application_tasks
  ADD COLUMN IF NOT EXISTS output_proposal_document_id TEXT;

CREATE TABLE IF NOT EXISTS hamilton_manual_submission_receipts (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  task_id TEXT NOT NULL REFERENCES application_tasks(id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL UNIQUE REFERENCES documents(id) ON DELETE RESTRICT,
  channel TEXT NOT NULL DEFAULT 'portal_manual'
    CHECK(channel = 'portal_manual'),
  portal_origin TEXT NOT NULL,
  portal_target_sha256 TEXT NOT NULL CHECK(length(portal_target_sha256) = 64),
  task_identity_sha256 TEXT NOT NULL CHECK(length(task_identity_sha256) = 64),
  confirmation_reference TEXT,
  submitted_at TIMESTAMPTZ NOT NULL,
  attestation_version TEXT NOT NULL,
  attested_by_user_id TEXT NOT NULL,
  attested_at TIMESTAMPTZ NOT NULL,
  receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256) = 64),
  file_size INTEGER NOT NULL CHECK(file_size > 0 AND file_size <= 10485760),
  mime_type TEXT NOT NULL
    CHECK(mime_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'revoked')),
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id TEXT,
  revocation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(task_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_hamilton_manual_receipt_active_task
  ON hamilton_manual_submission_receipts(task_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_hamilton_manual_receipt_profile
  ON hamilton_manual_submission_receipts(profile_id);

CREATE INDEX IF NOT EXISTS idx_hamilton_manual_receipt_document
  ON hamilton_manual_submission_receipts(document_id);

CREATE OR REPLACE FUNCTION protect_hamilton_manual_receipt_document()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM hamilton_manual_submission_receipts
     WHERE document_id = OLD.id
  ) AND (
    NEW.file_bytes IS DISTINCT FROM OLD.file_bytes
    OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
  ) THEN
    RAISE EXCEPTION 'manual submission receipt evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hamilton_manual_receipt_document_immutable ON documents;
CREATE TRIGGER trg_hamilton_manual_receipt_document_immutable
BEFORE UPDATE OF file_bytes, content_hash ON documents
FOR EACH ROW EXECUTE FUNCTION protect_hamilton_manual_receipt_document();

CREATE OR REPLACE FUNCTION protect_hamilton_manual_receipt_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'manual submission receipt bindings are append-only'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'revoked'
    OR NEW.status <> 'revoked'
    OR NEW.revoked_at IS NULL
    OR NEW.revoked_by_user_id IS NULL
    OR NEW.revocation_reason IS NULL
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.task_id IS DISTINCT FROM OLD.task_id
    OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
    OR NEW.document_id IS DISTINCT FROM OLD.document_id
    OR NEW.channel IS DISTINCT FROM OLD.channel
    OR NEW.portal_origin IS DISTINCT FROM OLD.portal_origin
    OR NEW.portal_target_sha256 IS DISTINCT FROM OLD.portal_target_sha256
    OR NEW.task_identity_sha256 IS DISTINCT FROM OLD.task_identity_sha256
    OR NEW.confirmation_reference IS DISTINCT FROM OLD.confirmation_reference
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
    OR NEW.attestation_version IS DISTINCT FROM OLD.attestation_version
    OR NEW.attested_by_user_id IS DISTINCT FROM OLD.attested_by_user_id
    OR NEW.attested_at IS DISTINCT FROM OLD.attested_at
    OR NEW.receipt_sha256 IS DISTINCT FROM OLD.receipt_sha256
    OR NEW.file_size IS DISTINCT FROM OLD.file_size
    OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'manual submission receipt bindings are append-only'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hamilton_manual_receipt_binding_append_only
  ON hamilton_manual_submission_receipts;
CREATE TRIGGER trg_hamilton_manual_receipt_binding_append_only
BEFORE UPDATE OR DELETE ON hamilton_manual_submission_receipts
FOR EACH ROW EXECUTE FUNCTION protect_hamilton_manual_receipt_binding();

CREATE OR REPLACE FUNCTION protect_hamilton_manual_receipt_task_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM hamilton_manual_submission_receipts
     WHERE task_id = OLD.id AND status = 'active'
  ) AND (
    NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
    OR NEW.opportunity_id IS DISTINCT FROM OLD.opportunity_id
    OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.current_step IS DISTINCT FROM OLD.current_step
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
    OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
    OR NEW.portal_url IS DISTINCT FROM OLD.portal_url
    OR NEW.application_url IS DISTINCT FROM OLD.application_url
    OR NEW.portal_id IS DISTINCT FROM OLD.portal_id
    OR NEW.application_id IS DISTINCT FROM OLD.application_id
    OR NEW.university_application_id IS DISTINCT FROM OLD.university_application_id
    OR NEW.automation_type IS DISTINCT FROM OLD.automation_type
    OR NEW.output_document_id IS DISTINCT FROM OLD.output_document_id
    OR NEW.output_pdf_document_id IS DISTINCT FROM OLD.output_pdf_document_id
    OR NEW.output_docx_document_id IS DISTINCT FROM OLD.output_docx_document_id
    OR NEW.output_proposal_document_id IS DISTINCT FROM OLD.output_proposal_document_id
    OR NEW.auto_submit_enabled IS DISTINCT FROM OLD.auto_submit_enabled
    OR NEW.allow_auto_submit IS DISTINCT FROM OLD.allow_auto_submit
  ) THEN
    RAISE EXCEPTION 'active manual submission receipt locks task identity'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hamilton_manual_receipt_task_identity ON application_tasks;
CREATE TRIGGER trg_hamilton_manual_receipt_task_identity
BEFORE UPDATE OF user_id, profile_id, opportunity_id, grant_id,
  status, current_step, submitted_at, completed_at,
  portal_url, application_url, portal_id, application_id,
  university_application_id, automation_type, output_document_id,
  output_pdf_document_id, output_docx_document_id,
  output_proposal_document_id, auto_submit_enabled, allow_auto_submit
  ON application_tasks
FOR EACH ROW EXECUTE FUNCTION protect_hamilton_manual_receipt_task_identity();
