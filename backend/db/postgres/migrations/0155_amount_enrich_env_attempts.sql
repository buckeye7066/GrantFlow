-- ENVIRONMENT-failure attempt tracking for amount enrichment.
-- Twin of sqlite migration 151_amount_enrich_env_attempts.sql — see it for the
-- full rationale. A separate counter for consecutive environment failures
-- (WAF 403 / 401 / 429 on OUR egress) makes the blockage VISIBLE
-- (`unanswered_blocked` in the amount-answer census) without consuming the
-- row's one-shot burn mark or normal retry budget; reset on any
-- non-environment outcome.
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS amount_enrich_env_attempts INTEGER DEFAULT 0;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS amount_enrich_env_attempts INTEGER DEFAULT 0;
