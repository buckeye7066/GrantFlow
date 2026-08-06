-- PostgreSQL twin of SQLite migration 163.
CREATE TABLE IF NOT EXISTS hamilton_submission_attempts (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  task_references_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  task_scopes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  profile_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  funding_source_id TEXT NOT NULL,
  authorization_target_id TEXT NOT NULL,
  portal_host TEXT NOT NULL,
  target_url TEXT NOT NULL,
  target_locator_ciphertext TEXT NOT NULL,
  target_locator_iv TEXT NOT NULL,
  target_locator_tag TEXT NOT NULL,
  target_locator_sha256 TEXT NOT NULL,
  application_identity TEXT NOT NULL,
  authorization_version TEXT NOT NULL,
  authorization_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  consent_snapshot_hash TEXT NOT NULL,
  answer_snapshot_hash TEXT NOT NULL,
  answer_provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  document_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  submission_adapter_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  action_type TEXT NOT NULL DEFAULT 'external_application_submit',
  requested_payload_hash TEXT NOT NULL,
  policy_version TEXT NOT NULL DEFAULT 'portfolio-irreversible-action-v1',
  implementation_version TEXT NOT NULL DEFAULT 'hamilton-external-submit-v2',
  attempt_number INTEGER NOT NULL DEFAULT 1,
  fence_generation INTEGER NOT NULL DEFAULT 1,
  evidence_required_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  reconciliation_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  state TEXT NOT NULL DEFAULT 'prepared',
  human_action_kind TEXT,
  checkpoint_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  lease_owner TEXT,
  fence_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  submit_dispatched_at TIMESTAMPTZ,
  reconciliation_required_at TIMESTAMPTZ,
  reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
  next_reconcile_at TIMESTAMPTZ,
  reconciliation_last_error TEXT,
  manual_review_required_at TIMESTAMPTZ,
  external_received_at TIMESTAMPTZ,
  external_validated_at TIMESTAMPTZ,
  proof_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  cancelled_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hamilton_submit_attempt_task
  ON hamilton_submission_attempts(task_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_submit_attempt_profile
  ON hamilton_submission_attempts(profile_id, user_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_submit_attempt_state
  ON hamilton_submission_attempts(state);
CREATE INDEX IF NOT EXISTS idx_hamilton_submit_attempt_reconcile_due
  ON hamilton_submission_attempts(state, next_reconcile_at, lease_expires_at);

CREATE TABLE IF NOT EXISTS hamilton_submission_audit_events (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  event_type TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hamilton_submit_audit_attempt
  ON hamilton_submission_audit_events(attempt_id, event_sequence);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hamilton_submit_audit_sequence
  ON hamilton_submission_audit_events(attempt_id, event_sequence);

CREATE TABLE IF NOT EXISTS hamilton_submission_outbox (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  UNIQUE(attempt_id, event_type)
);
CREATE INDEX IF NOT EXISTS idx_hamilton_submit_outbox_pending
  ON hamilton_submission_outbox(status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS hamilton_submission_task_projections (
  attempt_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  notification_id TEXT,
  projected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (attempt_id, task_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hamilton_submit_projection_event
  ON hamilton_submission_task_projections(event_id);

-- Live browser submission remains disabled for real hosts until a separately
-- executed sandbox/training validation artifact binds the reviewed adapter.
CREATE TABLE IF NOT EXISTS hamilton_submission_adapter_validations (
  id TEXT PRIMARY KEY,
  portal_host TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  fixture_contract_sha256 TEXT NOT NULL,
  validation_version TEXT NOT NULL,
  validation_environment TEXT NOT NULL,
  execution_run_id TEXT NOT NULL,
  evidence_manifest_sha256 TEXT NOT NULL,
  reviewer_user_id TEXT NOT NULL,
  validated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hamilton_adapter_validation_host
  ON hamilton_submission_adapter_validations(portal_host, adapter_id, adapter_version);
