-- 0165_grant_transactions.sql — postgres twin of sqlite 161 (funder-behavior graph).
-- See backend/db/migrations/161_grant_transactions.sql for the full rationale.
CREATE TABLE IF NOT EXISTS grant_transactions (
  id TEXT PRIMARY KEY,
  funder_ein TEXT NOT NULL,
  funder_name TEXT,
  recipient_name TEXT NOT NULL,
  recipient_ein TEXT,
  recipient_city TEXT,
  recipient_state TEXT,
  recipient_country TEXT,
  amount NUMERIC,
  purpose TEXT,
  tax_year INTEGER,
  form_type TEXT,
  source_object_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grant_tx_funder ON grant_transactions(funder_ein);
CREATE INDEX IF NOT EXISTS idx_grant_tx_state ON grant_transactions(recipient_state);
CREATE INDEX IF NOT EXISTS idx_grant_tx_object ON grant_transactions(source_object_id);

CREATE TABLE IF NOT EXISTS funder_990_ingest_state (
  funder_ein TEXT PRIMARY KEY,
  attempted_at TIMESTAMPTZ,
  attempts INTEGER DEFAULT 0,
  env_attempts INTEGER DEFAULT 0,
  last_reason TEXT,
  ingested_object_id TEXT,
  tax_year INTEGER,
  transactions_found INTEGER,
  updated_at TIMESTAMPTZ DEFAULT now()
);
