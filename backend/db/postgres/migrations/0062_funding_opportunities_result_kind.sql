-- 0062: Direct vs. directory/referral classification (Postgres parity for sqlite 068).
-- See backend/db/migrations/068_funding_opportunities_result_kind.sql for rationale.

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
