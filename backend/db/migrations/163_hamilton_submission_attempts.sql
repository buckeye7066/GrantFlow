-- One durable external-submission attempt owns Hamilton's irreversible portal
-- action.  Runs/retries converge on idempotency_key; fence_token + lease keep a
-- stale worker from clicking or persisting receipt evidence.
CREATE TABLE IF NOT EXISTS hamilton_submission_attempts (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  task_references_json TEXT NOT NULL DEFAULT '[]',
  task_scopes_json TEXT NOT NULL DEFAULT '{}',
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
  authorization_ids_json TEXT NOT NULL DEFAULT '[]',
  consent_snapshot_hash TEXT NOT NULL,
  answer_snapshot_hash TEXT NOT NULL,
  answer_provenance_json TEXT NOT NULL DEFAULT '{}',
  document_ids_json TEXT NOT NULL DEFAULT '[]',
  submission_adapter_json TEXT NOT NULL DEFAULT '{}',
  action_type TEXT NOT NULL DEFAULT 'external_application_submit',
  requested_payload_hash TEXT NOT NULL,
  policy_version TEXT NOT NULL DEFAULT 'portfolio-irreversible-action-v1',
  implementation_version TEXT NOT NULL DEFAULT 'hamilton-external-submit-v2',
  attempt_number INTEGER NOT NULL DEFAULT 1,
  fence_generation INTEGER NOT NULL DEFAULT 1,
  evidence_required_json TEXT NOT NULL DEFAULT '{}',
  reconciliation_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'prepared',
  human_action_kind TEXT,
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  lease_owner TEXT,
  fence_token TEXT,
  lease_expires_at DATETIME,
  submit_dispatched_at DATETIME,
  reconciliation_required_at DATETIME,
  reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
  next_reconcile_at DATETIME,
  reconciliation_last_error TEXT,
  manual_review_required_at DATETIME,
  external_received_at DATETIME,
  external_validated_at DATETIME,
  proof_json TEXT NOT NULL DEFAULT '{}',
  cancelled_reason TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  details_json TEXT NOT NULL DEFAULT '{}',
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hamilton_submit_audit_attempt
  ON hamilton_submission_audit_events(attempt_id, event_sequence);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hamilton_submit_audit_sequence
  ON hamilton_submission_audit_events(attempt_id, event_sequence);

CREATE TABLE IF NOT EXISTS hamilton_submission_outbox (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at DATETIME,
  next_attempt_at DATETIME,
  last_error TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME,
  UNIQUE(attempt_id, event_type)
);
CREATE INDEX IF NOT EXISTS idx_hamilton_submit_outbox_pending
  ON hamilton_submission_outbox(status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS hamilton_submission_task_projections (
  attempt_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  notification_id TEXT,
  projected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (attempt_id, task_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hamilton_submit_projection_event
  ON hamilton_submission_task_projections(event_id);

-- A real portal is not live-enabled by a caller-supplied fixture pack. The
-- adapter must point at a separately persisted sandbox/training execution
-- artifact whose hashes, reviewer, and expiry match the frozen definition.
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
  validated_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hamilton_adapter_validation_host
  ON hamilton_submission_adapter_validations(portal_host, adapter_id, adapter_version);
