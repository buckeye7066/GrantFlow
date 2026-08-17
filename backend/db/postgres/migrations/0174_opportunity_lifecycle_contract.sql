-- Slice 1–3: PostgreSQL twin of SQLite migration 169.

ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS purpose TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS eligibility_requirements TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS estimated_award NUMERIC;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS open_date DATE;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS recurrence TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS required_documents TEXT DEFAULT '[]';
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS application_method TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS first_published_at TIMESTAMPTZ;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS current_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK(current_status IN ('open','closing_soon','closed','forecasted','rolling','paused','archived','unknown'));
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS data_quality_score DOUBLE PRECISION
  CHECK(data_quality_score IS NULL OR (data_quality_score >= 0 AND data_quality_score <= 1));
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS data_quality_flags TEXT DEFAULT '[]';
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS missing_fields TEXT DEFAULT '[]';

CREATE TABLE IF NOT EXISTS opportunity_change_history (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES funding_opportunities(id) ON DELETE CASCADE,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
  WHEN deadline IS NOT NULL AND deadline < CURRENT_DATE THEN 'closed'
  WHEN open_date IS NOT NULL AND open_date > CURRENT_DATE THEN 'forecasted'
  WHEN LOWER(COALESCE(deadline_type, '')) IN ('rolling','ongoing') THEN 'rolling'
  WHEN deadline IS NOT NULL AND deadline <= CURRENT_DATE + INTERVAL '14 days' THEN 'closing_soon'
  WHEN COALESCE(is_active, TRUE) = TRUE THEN 'open'
  ELSE 'unknown'
END
WHERE current_status IS NULL OR current_status = 'unknown';
