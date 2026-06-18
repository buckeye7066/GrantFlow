-- SQLite parity with backend/db/postgres/migrations/0096_agent_telemetry_missing_tables.sql
-- sam_findings, yana_john_queue, yana_larry_queue.

CREATE TABLE IF NOT EXISTS sam_findings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  sam_run_id TEXT,
  severity TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  event_type TEXT,
  title TEXT,
  description TEXT,
  file_path TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sam_findings_created  ON sam_findings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sam_findings_severity ON sam_findings(severity);
CREATE INDEX IF NOT EXISTS idx_sam_findings_status   ON sam_findings(status);
CREATE INDEX IF NOT EXISTS idx_sam_findings_run      ON sam_findings(sam_run_id);

CREATE TABLE IF NOT EXISTS yana_john_queue (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  lead_candidate_id TEXT,
  organization_id TEXT,
  profile_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  payload_json TEXT NOT NULL DEFAULT '{}',
  processed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_yana_john_queue_created ON yana_john_queue(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_yana_john_queue_status  ON yana_john_queue(status);
CREATE INDEX IF NOT EXISTS idx_yana_john_queue_lead    ON yana_john_queue(lead_candidate_id);

CREATE TABLE IF NOT EXISTS yana_larry_queue (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  lead_candidate_id TEXT,
  organization_id TEXT,
  profile_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  payload_json TEXT NOT NULL DEFAULT '{}',
  processed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_yana_larry_queue_created ON yana_larry_queue(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_yana_larry_queue_status  ON yana_larry_queue(status);
CREATE INDEX IF NOT EXISTS idx_yana_larry_queue_lead    ON yana_larry_queue(lead_candidate_id);
