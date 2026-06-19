-- 0105_laptop_connector.sql  (Postgres variant of sqlite 108_laptop_connector)
--
-- See backend/db/migrations/108_laptop_connector.sql for the full rationale.
-- Laptop Connector: stages locally-scanned file content as REVIEWABLE
-- candidates (lead/funding/profile_field) behind an admin check-off gate.
-- No raw file bytes are stored — only extracted snippets + provenance.

CREATE TABLE IF NOT EXISTS laptop_ingest_runs (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  host TEXT,
  connector_version TEXT,
  root_paths_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  files_scanned INTEGER NOT NULL DEFAULT 0,
  files_skipped INTEGER NOT NULL DEFAULT 0,
  files_ingested INTEGER NOT NULL DEFAULT 0,
  candidates_created INTEGER NOT NULL DEFAULT 0,
  error_text TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}',
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_laptop_ingest_runs_status ON laptop_ingest_runs(status);
CREATE INDEX IF NOT EXISTS idx_laptop_ingest_runs_started ON laptop_ingest_runs(started_at);

CREATE TABLE IF NOT EXISTS laptop_source_documents (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  run_id TEXT,
  file_path TEXT NOT NULL,
  file_name TEXT,
  file_type TEXT,
  file_hash TEXT,
  byte_size INTEGER,
  modified_at TIMESTAMP,
  char_count INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  analyzed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_laptop_source_documents_run ON laptop_source_documents(run_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_laptop_source_documents_hash
  ON laptop_source_documents(file_hash)
  WHERE file_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS laptop_review_items (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  run_id TEXT,
  document_id TEXT,
  candidate_type TEXT NOT NULL
    CHECK (candidate_type IN ('lead', 'funding', 'profile_field')),
  target_profile_id TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'dismissed', 'applied', 'error')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  acted_at TIMESTAMP,
  action_result TEXT
);
CREATE INDEX IF NOT EXISTS idx_laptop_review_items_status ON laptop_review_items(status);
CREATE INDEX IF NOT EXISTS idx_laptop_review_items_type ON laptop_review_items(candidate_type);
CREATE INDEX IF NOT EXISTS idx_laptop_review_items_run ON laptop_review_items(run_id);
CREATE INDEX IF NOT EXISTS idx_laptop_review_items_profile ON laptop_review_items(target_profile_id);
