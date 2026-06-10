-- @sqlite-continue-on-idempotent-errors
-- Migration 077: persist the reality-gate verdict alongside link health.
--
-- Why: the audit (RC-8) found that assessReality() runs at insert time and
-- assessOpportunityTrust() re-derives the same outcome at every render. The
-- two implementations have already drifted twice. Persist the insert-side
-- verdict so:
--   * Display readers can prefer the stored verdict (cheap, drift-proof).
--   * Per-user toggles (allowLoans/allowExpired) still re-derive on top.
--   * The mission dashboard can answer "why was this hidden?" without
--     replaying assessReality().
--
-- Columns:
--   reality_status   TEXT   - 'allowed' | 'rejected' | 'downgraded' | NULL
--   reality_reasons  TEXT   - JSON array of policy reason codes
--   final_url        TEXT   - URL after redirects (proven landing page)
--   http_status      INTEGER- HTTP status code from last live probe
--
-- Idempotent: ALTER TABLE ADD COLUMN guards via try/catch in the runner;
-- fresh DBs use schema.sql.
ALTER TABLE funding_opportunities ADD COLUMN reality_status TEXT;
ALTER TABLE funding_opportunities ADD COLUMN reality_reasons TEXT;
ALTER TABLE funding_opportunities ADD COLUMN final_url TEXT;
ALTER TABLE funding_opportunities ADD COLUMN http_status INTEGER;

CREATE INDEX IF NOT EXISTS idx_funding_opportunities_reality_status
  ON funding_opportunities(reality_status);
