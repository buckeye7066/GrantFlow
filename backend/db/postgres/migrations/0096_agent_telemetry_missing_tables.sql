-- Agent Mission Control: tables the health check and aggregators expect but
-- that had no migration, so system-health reported "Sam 1/2" and "Yana 1/3".
--
--   sam_findings     — Sam's audit findings (severity/status/file_path/...)
--   yana_john_queue  — qualified leads Yana forwards to John
--   yana_larry_queue — leads Yana forwards to Larry
--
-- Mirrored in backend/db/migrations/100_agent_telemetry_missing_tables.sql and
-- backend/db/schema.sql, and applied at boot by ensureAgentSubsystemTables.

CREATE TABLE IF NOT EXISTS sam_findings (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  sam_run_id TEXT,
  severity TEXT,                       -- critical | high | medium | low | info
  status TEXT NOT NULL DEFAULT 'open', -- open | acknowledged | resolved
  event_type TEXT,                     -- gate_failed | check | ...
  title TEXT,
  description TEXT,
  file_path TEXT,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sam_findings_created  ON sam_findings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sam_findings_severity ON sam_findings(severity);
CREATE INDEX IF NOT EXISTS idx_sam_findings_status   ON sam_findings(status);
CREATE INDEX IF NOT EXISTS idx_sam_findings_run      ON sam_findings(sam_run_id);

CREATE TABLE IF NOT EXISTS yana_john_queue (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  lead_candidate_id TEXT,
  organization_id TEXT,
  profile_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | processed | failed | skipped
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_yana_john_queue_created ON yana_john_queue(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_yana_john_queue_status  ON yana_john_queue(status);
CREATE INDEX IF NOT EXISTS idx_yana_john_queue_lead    ON yana_john_queue(lead_candidate_id);

CREATE TABLE IF NOT EXISTS yana_larry_queue (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  lead_candidate_id TEXT,
  organization_id TEXT,
  profile_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_yana_larry_queue_created ON yana_larry_queue(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_yana_larry_queue_status  ON yana_larry_queue(status);
CREATE INDEX IF NOT EXISTS idx_yana_larry_queue_lead    ON yana_larry_queue(lead_candidate_id);
