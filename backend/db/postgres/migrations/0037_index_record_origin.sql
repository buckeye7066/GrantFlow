-- Migration 0037: Add index on record_origin for query performance
--
-- Every read-side query now filters: record_origin NOT IN ('synthetic','manual')
-- Without an index, this adds a full-scan predicate on every match/discovery query.

CREATE INDEX IF NOT EXISTS idx_fo_record_origin_active
  ON funding_opportunities(record_origin, is_active);
