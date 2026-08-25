-- 0189_prior_cycle_application_claims.sql
--
-- Postgres counterpart of sqlite 184_prior_cycle_application_claims.sql.
-- See that file for the full rationale. Same semantics, Postgres idioms:
-- RAISE EXCEPTION in PL/pgSQL trigger functions instead of RAISE(ABORT).

CREATE TABLE IF NOT EXISTS prior_cycle_application_claims (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  identity_key TEXT NOT NULL,
  cycle_label TEXT,
  opportunity_id TEXT,
  task_id TEXT,
  origin TEXT NOT NULL CHECK(origin IN ('grantflow_verified', 'owner_attested')),
  submitted_at TIMESTAMPTZ,
  confirmation_reference TEXT,
  attested_by_user_id TEXT,
  attested_at TIMESTAMPTZ,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'retracted')),
  retracted_at TIMESTAMPTZ,
  retraction_reason TEXT,
  retracted_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_prior_cycle_claim_active
  ON prior_cycle_application_claims(profile_id, identity_key, COALESCE(cycle_label, ''))
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_prior_cycle_claim_lookup
  ON prior_cycle_application_claims(profile_id, identity_key, status);

CREATE OR REPLACE FUNCTION prior_cycle_claims_no_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'prior cycle application claims are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prior_cycle_claims_no_delete ON prior_cycle_application_claims;
CREATE TRIGGER trg_prior_cycle_claims_no_delete
BEFORE DELETE ON prior_cycle_application_claims
FOR EACH ROW EXECUTE FUNCTION prior_cycle_claims_no_delete();

CREATE OR REPLACE FUNCTION prior_cycle_claims_retract_only()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT (
    OLD.status = 'active'
    AND NEW.status = 'retracted'
    AND OLD.retracted_at IS NULL
    AND NEW.retracted_at IS NOT NULL
    AND NULLIF(TRIM(NEW.retraction_reason), '') IS NOT NULL
    AND NULLIF(TRIM(NEW.retracted_by_user_id), '') IS NOT NULL
    AND NEW.id IS NOT DISTINCT FROM OLD.id
    AND NEW.profile_id IS NOT DISTINCT FROM OLD.profile_id
    AND NEW.identity_key IS NOT DISTINCT FROM OLD.identity_key
    AND NEW.origin IS NOT DISTINCT FROM OLD.origin
  ) THEN
    RAISE EXCEPTION 'prior cycle application claims may only be retracted';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prior_cycle_claims_retract_only ON prior_cycle_application_claims;
CREATE TRIGGER trg_prior_cycle_claims_retract_only
BEFORE UPDATE ON prior_cycle_application_claims
FOR EACH ROW EXECUTE FUNCTION prior_cycle_claims_retract_only();
