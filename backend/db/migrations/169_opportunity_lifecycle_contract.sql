-- Slice 1–3: additive canonical opportunity lifecycle contract.
--
-- schema.sql remains the fresh-database baseline; this numbered migration is
-- the rollout authority for existing SQLite databases. The marker lets the
-- migration runner tolerate a column already added by an interrupted deploy.
-- @sqlite-continue-on-idempotent-errors

ALTER TABLE funding_opportunities ADD COLUMN purpose TEXT;
ALTER TABLE funding_opportunities ADD COLUMN eligibility_requirements TEXT;
ALTER TABLE funding_opportunities ADD COLUMN estimated_award REAL;
ALTER TABLE funding_opportunities ADD COLUMN open_date DATE;
ALTER TABLE funding_opportunities ADD COLUMN recurrence TEXT;
ALTER TABLE funding_opportunities ADD COLUMN required_documents TEXT DEFAULT '[]';
ALTER TABLE funding_opportunities ADD COLUMN application_method TEXT;
ALTER TABLE funding_opportunities ADD COLUMN first_published_at DATETIME;
ALTER TABLE funding_opportunities ADD COLUMN current_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK(current_status IN ('open','closing_soon','closed','forecasted','rolling','paused','archived','unknown'));
ALTER TABLE funding_opportunities ADD COLUMN data_quality_score REAL
  CHECK(data_quality_score IS NULL OR (data_quality_score >= 0 AND data_quality_score <= 1));
ALTER TABLE funding_opportunities ADD COLUMN data_quality_flags TEXT DEFAULT '[]';
ALTER TABLE funding_opportunities ADD COLUMN missing_fields TEXT DEFAULT '[]';

CREATE TABLE IF NOT EXISTS opportunity_change_history (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES funding_opportunities(id) ON DELETE CASCADE,
  changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  changed_by TEXT,
  change_type TEXT NOT NULL CHECK(change_type IN ('created','updated','status','verification')),
  source TEXT,
  changed_fields TEXT NOT NULL DEFAULT '[]',
  before_values TEXT,
  after_values TEXT
);

CREATE INDEX IF NOT EXISTS idx_opportunity_change_history_opportunity
  ON opportunity_change_history(opportunity_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_current_status
  ON funding_opportunities(current_status);
CREATE INDEX IF NOT EXISTS idx_funding_opportunities_open_date
  ON funding_opportunities(open_date);

UPDATE funding_opportunities
SET current_status = CASE
  WHEN LOWER(COALESCE(status, '')) = 'expired' THEN 'closed'
  WHEN LOWER(COALESCE(status, '')) = 'paused' THEN 'paused'
  WHEN LOWER(COALESCE(deadline_status, '')) IN ('expired','closed','retired') THEN 'closed'
  WHEN deadline IS NOT NULL AND DATE(deadline) < DATE('now') THEN 'closed'
  WHEN open_date IS NOT NULL AND DATE(open_date) > DATE('now') THEN 'forecasted'
  WHEN LOWER(COALESCE(deadline_type, '')) IN ('rolling','ongoing') THEN 'rolling'
  WHEN deadline IS NOT NULL AND DATE(deadline) <= DATE('now', '+14 days') THEN 'closing_soon'
  WHEN COALESCE(is_active, 1) = 1 THEN 'open'
  ELSE 'unknown'
END
WHERE current_status IS NULL OR current_status = 'unknown';
