-- Postgres migration 0003: Ingestion support (from sqlite migration 001-add-ingestion-support.sql)
-- Deterministic + strict: no runtime schema auto-migration; run via `npm run migrate`.

-- Add raw payload column for external source debugging / traceability
ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS raw_source_payload TEXT;

-- Deduplication: (source, source_id) should be unique when both are present.
-- Partial unique index allows NULLs and avoids enforcing uniqueness on incomplete rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunities_source_source_id
  ON funding_opportunities(source, source_id)
  WHERE source IS NOT NULL AND source_id IS NOT NULL;

-- Track ingestion runs (history + diagnostics)
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  source TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  status TEXT CHECK(status IN ('running', 'completed', 'failed')) DEFAULT 'running',
  records_fetched INTEGER DEFAULT 0,
  records_inserted INTEGER DEFAULT 0,
  records_updated INTEGER DEFAULT 0,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_ingestion_runs_source_started
  ON ingestion_runs(source, started_at DESC);

