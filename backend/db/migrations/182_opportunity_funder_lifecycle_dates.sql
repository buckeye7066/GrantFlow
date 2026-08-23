-- 182: SQLite twin of postgres 0187 — funder-aware lifecycle fields on
-- funding_opportunities (expected_decision_date, decision_review_days,
-- reporting_requirements). SQLite has no ADD COLUMN IF NOT EXISTS, so each is
-- guarded by the migration runner's duplicate-column tolerance; reporting_
-- requirements holds JSON text (parsed by the derivation service).
ALTER TABLE funding_opportunities ADD COLUMN expected_decision_date TEXT;
ALTER TABLE funding_opportunities ADD COLUMN decision_review_days INTEGER;
ALTER TABLE funding_opportunities ADD COLUMN reporting_requirements TEXT;
