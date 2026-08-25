-- 184_prior_cycle_application_claims.sql
--
-- Cross-cycle duplicate-application guard (gap #2 of the 2026-08-24 review).
--
-- WHAT THIS SOLVES
-- `ux_application_tasks_profile_subject` already prevents two live tasks for
-- the same (profile, opportunity-or-grant) INSIDE GrantFlow. It does not model
-- either of the two cases that actually cause funder-side disqualification:
--
--   1. RECURRING AWARDS. A program that runs annually is frequently re-crawled
--      as a NEW funding_opportunities row each cycle (new external_id / new
--      apply_url). The unique index sees a different subject and happily mints
--      a second task, so the same profile can submit to the same program twice.
--
--   2. OUTSIDE SUBMISSIONS. The applicant applied directly on the funder's
--      portal before GrantFlow ever saw the opportunity. GrantFlow has no
--      record and cannot warn.
--
-- Both are answered by identity, not by row id: `identity_key` is
-- canonicalOpportunityKey()'s program identity, which is deliberately stable
-- across cycles for the same program+sponsor (see crawler-os/contract.js —
-- titleIdentityKey sorts tokens so re-worded parentheticals collapse).
--
-- HONESTY POSTURE (matches submissionProofPredicate.js)
-- A claim is an ASSERTION, not proof. `origin` records where the assertion came
-- from and is never upgraded silently:
--   'grantflow_verified' — mirrored from a task with VERIFIED_EXTERNAL proof
--   'owner_attested'     — a human said "I already applied to this"
-- A guard blocks on either, but the UI must show which one it is. An attested
-- claim must never be presented as a verified submission.
--
-- Append-only, mirroring application_outcome_evidence: a mistaken claim is
-- RETRACTED, never deleted, so the original assertion stays auditable.

CREATE TABLE IF NOT EXISTS prior_cycle_application_claims (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,

  -- canonicalOpportunityKey() identity of the PROGRAM, stable across cycles.
  identity_key TEXT NOT NULL,

  -- Free-text cycle label as the funder states it ('2025-2026', 'Spring 2026').
  -- NULL means "unknown cycle" and is treated as the most conservative case:
  -- it matches any cycle, because we cannot prove it was a different one.
  cycle_label TEXT,

  -- Provenance of the row that produced this claim, when there was one.
  opportunity_id TEXT,
  task_id TEXT,

  origin TEXT NOT NULL CHECK(origin IN ('grantflow_verified', 'owner_attested')),
  submitted_at DATETIME,

  -- Only populated for grantflow_verified rows; mirrors the proof reference
  -- already assessed by submissionProofPredicate.js. NEVER populated from an
  -- attestation.
  confirmation_reference TEXT,

  attested_by_user_id TEXT,
  attested_at DATETIME,
  note TEXT,

  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'retracted')),
  retracted_at DATETIME,
  retraction_reason TEXT,
  retracted_by_user_id TEXT,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One ACTIVE claim per (profile, program identity, cycle). COALESCE keeps the
-- unknown-cycle row distinct from labeled cycles rather than colliding with
-- every one of them.
CREATE UNIQUE INDEX IF NOT EXISTS ux_prior_cycle_claim_active
  ON prior_cycle_application_claims(profile_id, identity_key, COALESCE(cycle_label, ''))
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_prior_cycle_claim_lookup
  ON prior_cycle_application_claims(profile_id, identity_key, status);

CREATE TRIGGER IF NOT EXISTS trg_prior_cycle_claims_no_delete
BEFORE DELETE ON prior_cycle_application_claims
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'prior cycle application claims are append-only');
END;

-- The only permitted update is a one-way retraction with a reason and an
-- actor. Identity, origin, and profile are immutable after insert.
CREATE TRIGGER IF NOT EXISTS trg_prior_cycle_claims_retract_only
BEFORE UPDATE ON prior_cycle_application_claims
FOR EACH ROW
WHEN NOT (
  OLD.status = 'active'
  AND NEW.status = 'retracted'
  AND OLD.retracted_at IS NULL
  AND NEW.retracted_at IS NOT NULL
  AND NULLIF(TRIM(NEW.retraction_reason), '') IS NOT NULL
  AND NULLIF(TRIM(NEW.retracted_by_user_id), '') IS NOT NULL
  AND NEW.id IS OLD.id
  AND NEW.profile_id IS OLD.profile_id
  AND NEW.identity_key IS OLD.identity_key
  AND NEW.origin IS OLD.origin
)
BEGIN
  SELECT RAISE(ABORT, 'prior cycle application claims may only be retracted');
END;
