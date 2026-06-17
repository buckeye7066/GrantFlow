-- 0083_yana_automation_tasks.sql (Postgres mirror of SQLite 087)
--
-- See backend/db/migrations/087_yana_automation_tasks.sql for design.
-- Postgres supports IF NOT EXISTS on ADD COLUMN, so this is naturally
-- idempotent.

ALTER TABLE application_tasks ADD COLUMN IF NOT EXISTS automation_type TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE application_tasks ADD COLUMN IF NOT EXISTS selected_from_stage TEXT;
ALTER TABLE application_tasks ADD COLUMN IF NOT EXISTS current_pipeline_stage TEXT;
ALTER TABLE application_tasks ADD COLUMN IF NOT EXISTS agent_persona_version TEXT NOT NULL DEFAULT 'yana-mba-2026';
ALTER TABLE application_tasks ADD COLUMN IF NOT EXISTS portal_url TEXT;
ALTER TABLE application_tasks ADD COLUMN IF NOT EXISTS application_url TEXT;
ALTER TABLE application_tasks ADD COLUMN IF NOT EXISTS university_application_id TEXT;
ALTER TABLE application_tasks ADD COLUMN IF NOT EXISTS output_document_id TEXT;
ALTER TABLE application_tasks ADD COLUMN IF NOT EXISTS output_pdf_document_id TEXT;
ALTER TABLE application_tasks ADD COLUMN IF NOT EXISTS output_docx_document_id TEXT;
ALTER TABLE application_tasks ADD COLUMN IF NOT EXISTS mailing_instructions_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE application_tasks ADD COLUMN IF NOT EXISTS audit_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE application_tasks ADD COLUMN IF NOT EXISTS allow_auto_submit BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE application_tasks ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE application_tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_application_tasks_automation_type ON application_tasks(automation_type);
CREATE INDEX IF NOT EXISTS idx_application_tasks_selected_stage  ON application_tasks(selected_from_stage);
