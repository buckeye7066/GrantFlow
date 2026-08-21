-- Twin of SQLite migration 177. See that file for rationale.
ALTER TABLE hamilton_portal_credentials ADD COLUMN IF NOT EXISTS handover_status TEXT;
ALTER TABLE hamilton_portal_credentials ADD COLUMN IF NOT EXISTS handover_plan_json TEXT;
ALTER TABLE hamilton_portal_credentials ADD COLUMN IF NOT EXISTS handover_blocker TEXT;
ALTER TABLE hamilton_portal_credentials ADD COLUMN IF NOT EXISTS handover_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hamilton_portal_credentials ADD COLUMN IF NOT EXISTS handover_next_retry_at TIMESTAMPTZ;
ALTER TABLE hamilton_portal_credentials ADD COLUMN IF NOT EXISTS handover_completed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_hamilton_portal_cred_handover
  ON hamilton_portal_credentials (handover_status);
