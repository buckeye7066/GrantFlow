-- 161_grant_transactions.sql — THE FUNDER-BEHAVIOR GRAPH (2026-08-05)
--
-- Commercial grant-discovery products (Candid / Foundation Directory) match
-- applicants against what funders ACTUALLY FUNDED — the itemized grant lists
-- in IRS 990-PF Part XV and Form 990 Schedule I — while GrantFlow matched only
-- against scraped opportunity TEXT. The e-file corpus is public and keyless
-- (live-verified 2026-08-05: ProPublica org pages list the e-file object ids;
-- the GivingTuesday 990 data lake serves the raw IRS XML per object id; the
-- Ford Foundation's latest 990-PF carries 4,007 itemized grants, the
-- Cleveland Foundation's 990 Schedule I 1,016).
--
-- One row per itemized grant a funder reported. The funder key is the EIN,
-- which `funding_opportunities.source_id` already carries on
-- source='propublica_990' rows (the crawler-os 990 grantmaker lane).
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_grant_tx_funder ON grant_transactions(funder_ein);
CREATE INDEX IF NOT EXISTS idx_grant_tx_state ON grant_transactions(recipient_state);
CREATE INDEX IF NOT EXISTS idx_grant_tx_object ON grant_transactions(source_object_id);

-- Ingest attempt state per funder EIN — the amount-enrichment burn/retry
-- discipline, table-scoped instead of column-scoped because the unit of work
-- is the FUNDER (one filing answers every catalog row carrying that EIN):
--   * attempted_at is written ONLY once the funder's ANSWER is known
--     (filing parsed — even to zero grants — or a stable no-such-page /
--     no-e-file-XML fact). It is the burn mark; the SQL candidate predicate
--     excludes marked rows so a JS post-LIMIT filter can never wedge the
--     sweep (the #944 class).
--   * a TRANSIENT failure (5xx / network / timeout) spends nothing.
--   * an ENVIRONMENT failure (401/403/429 — a wall against OUR egress, not a
--     fact about the funder) increments env_attempts only.
--   * attempts bounds stable-but-retryable outcomes (XML not yet in the lake,
--     parse errors) so a permanently-odd filing cannot be re-fetched forever.
CREATE TABLE IF NOT EXISTS funder_990_ingest_state (
  funder_ein TEXT PRIMARY KEY,
  attempted_at DATETIME,
  attempts INTEGER DEFAULT 0,
  env_attempts INTEGER DEFAULT 0,
  last_reason TEXT,
  ingested_object_id TEXT,
  tax_year INTEGER,
  transactions_found INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
