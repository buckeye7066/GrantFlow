-- 0062: Direct vs. directory/referral classification (Postgres parity for sqlite 068).
-- See backend/db/migrations/068_funding_opportunities_result_kind.sql for rationale.

-- funding_opportunities is large in prod (90k+ rows). The one-time result_kind
-- backfill below is a full-table UPDATE that exceeded the default
-- statement_timeout and, because the whole migration runs in a single
-- transaction, rolled back its own ADD COLUMNs — leaving is_hidden missing,
-- which breaks the Funding Library read (`WHERE is_hidden = 0 OR is_hidden IS
-- NULL`). Disable the timeout for THIS migration's transaction so the one-time
-- backfill completes; it is stamped afterwards and never re-runs. (SET LOCAL is
-- scoped to the surrounding transaction the migration runner opens.)
SET LOCAL statement_timeout = '0';

ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS result_kind TEXT;
ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT FALSE;

UPDATE funding_opportunities
SET result_kind = CASE
    WHEN type = 'DIRECTORY' THEN 'directory'
    WHEN opportunity_type IN ('directory', 'referral') THEN 'directory'
    WHEN opportunity_type IN ('benefit', 'assistance', 'subsidy', 'voucher', 'rebate', 'service', 'in_kind', 'pro_bono', 'credit') THEN 'benefit'
    WHEN opportunity_type IN ('training', 'program') THEN 'action_step'
    ELSE 'direct'
END
WHERE result_kind IS NULL;

CREATE INDEX IF NOT EXISTS idx_funding_opps_result_kind ON funding_opportunities(result_kind);
CREATE INDEX IF NOT EXISTS idx_funding_opps_is_hidden ON funding_opportunities(is_hidden);
