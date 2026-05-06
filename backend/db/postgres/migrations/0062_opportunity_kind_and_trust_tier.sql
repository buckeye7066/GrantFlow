-- 0062_opportunity_kind_and_trust_tier.sql
-- See backend/db/migrations/068_opportunity_kind_and_trust_tier.sql for the
-- full design notes. Postgres mirror.

ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS opportunity_kind TEXT;

ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS source_trust_tier TEXT;

CREATE INDEX IF NOT EXISTS idx_funding_opportunities_opportunity_kind
  ON funding_opportunities(opportunity_kind);

CREATE INDEX IF NOT EXISTS idx_funding_opportunities_source_trust_tier
  ON funding_opportunities(source_trust_tier);
