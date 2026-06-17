-- 087_yana_automation_tasks.sql
-- @sqlite-continue-on-idempotent-errors
--
-- Adds the columns the new "Automate with Yana" select-many flow needs
-- to application_tasks. The migration runner sees the marker above and
-- runs each statement individually, tolerating "duplicate column name"
-- errors so re-running this migration is a no-op.
--
-- Status values are validated at the application layer
-- (applicationTaskStore.TASK_STATUSES + automation extension), so we
-- intentionally do not tighten the CHECK constraint here. Loosening
-- a CHECK requires a full table rebuild in SQLite and would break
-- in-flight sessions on existing dev databases.

ALTER TABLE application_tasks ADD COLUMN automation_type TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE application_tasks ADD COLUMN selected_from_stage TEXT;
ALTER TABLE application_tasks ADD COLUMN current_pipeline_stage TEXT;
ALTER TABLE application_tasks ADD COLUMN agent_persona_version TEXT NOT NULL DEFAULT 'yana-mba-2026';
ALTER TABLE application_tasks ADD COLUMN portal_url TEXT;
ALTER TABLE application_tasks ADD COLUMN application_url TEXT;
ALTER TABLE application_tasks ADD COLUMN university_application_id TEXT;
ALTER TABLE application_tasks ADD COLUMN output_document_id TEXT;
ALTER TABLE application_tasks ADD COLUMN output_pdf_document_id TEXT;
ALTER TABLE application_tasks ADD COLUMN output_docx_document_id TEXT;
ALTER TABLE application_tasks ADD COLUMN mailing_instructions_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE application_tasks ADD COLUMN audit_summary_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE application_tasks ADD COLUMN allow_auto_submit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE application_tasks ADD COLUMN started_at DATETIME;
ALTER TABLE application_tasks ADD COLUMN completed_at DATETIME;

CREATE INDEX IF NOT EXISTS idx_application_tasks_automation_type ON application_tasks(automation_type);
CREATE INDEX IF NOT EXISTS idx_application_tasks_selected_stage  ON application_tasks(selected_from_stage);
