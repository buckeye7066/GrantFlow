-- 108_laptop_connector.sql
--
-- "Laptop Connector" — bring files from the admin's local machine into
-- GrantFlow as REVIEWABLE candidates, never as silent writes.
--
-- Architecture (why these tables exist):
--   The GrantFlow backend runs on Railway with an ephemeral filesystem and
--   cannot read the admin's laptop. A small local CLI (tools/laptop-connector)
--   scans allowlisted folders, extracts text locally, and POSTs the extracted
--   text + provenance here. The backend's AI turns that text into three kinds
--   of candidate:
--     - lead          → a potential GrantFlow client org   (routes to Yana)
--     - funding       → a potential funding source/funder   (routes to Robert)
--     - profile_field → a value to fill a missing profile field (routes to the
--                       guarded PUT /api/profiles/:id/sections/:key)
--
--   EVERYTHING lands in `laptop_review_items` as status='pending'. The admin
--   checks off what to add. Accept forwards into the canonical pipeline; it
--   never bypasses validation. This is the privacy + accuracy gate the owner
--   asked for: parsed content is staged, reviewed, then committed.
--
--   Raw file bytes are NEVER stored here — only extracted text snippets used as
--   evidence, plus the file path/hash for provenance.

CREATE TABLE IF NOT EXISTS laptop_ingest_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  host TEXT,                              -- machine name that produced the run
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
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_laptop_ingest_runs_status ON laptop_ingest_runs(status);
CREATE INDEX IF NOT EXISTS idx_laptop_ingest_runs_started ON laptop_ingest_runs(started_at);

-- Provenance for every file the connector successfully ingested. No bytes,
-- just enough to trace a candidate back to its origin and to dedupe re-scans.
CREATE TABLE IF NOT EXISTS laptop_source_documents (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  run_id TEXT,
  file_path TEXT NOT NULL,
  file_name TEXT,
  file_type TEXT,                         -- pdf | docx | text
  file_hash TEXT,                         -- sha256 of the file bytes (dedupe)
  byte_size INTEGER,
  modified_at DATETIME,
  char_count INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  analyzed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_laptop_source_documents_run ON laptop_source_documents(run_id);
-- Dedupe: a given file content (by hash) only needs analysis once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_laptop_source_documents_hash
  ON laptop_source_documents(file_hash)
  WHERE file_hash IS NOT NULL;

-- The check-off inbox. One row per proposed change, awaiting the admin.
CREATE TABLE IF NOT EXISTS laptop_review_items (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  run_id TEXT,
  document_id TEXT,
  candidate_type TEXT NOT NULL
    CHECK (candidate_type IN ('lead', 'funding', 'profile_field')),
  target_profile_id TEXT,                 -- for profile_field; optional match for lead
  title TEXT NOT NULL,                    -- short human label for the inbox row
  summary TEXT,                           -- one-line "what this would do"
  payload_json TEXT NOT NULL DEFAULT '{}',-- structured candidate (see service)
  provenance_json TEXT NOT NULL DEFAULT '{}', -- { file_path, file_name, snippet }
  confidence REAL NOT NULL DEFAULT 0,     -- 0..1 model confidence
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'dismissed', 'applied', 'error')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  acted_at DATETIME,
  action_result TEXT                      -- target id on accept, reason on dismiss
);
CREATE INDEX IF NOT EXISTS idx_laptop_review_items_status ON laptop_review_items(status);
CREATE INDEX IF NOT EXISTS idx_laptop_review_items_type ON laptop_review_items(candidate_type);
CREATE INDEX IF NOT EXISTS idx_laptop_review_items_run ON laptop_review_items(run_id);
CREATE INDEX IF NOT EXISTS idx_laptop_review_items_profile ON laptop_review_items(target_profile_id);
