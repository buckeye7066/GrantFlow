-- 0085_yana_hard_stop_resolution.sql (Postgres mirror of SQLite 089)
-- See backend/db/migrations/089_yana_hard_stop_resolution.sql.

CREATE TABLE IF NOT EXISTS yana_blockers (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  task_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  user_id TEXT,
  funding_source_id TEXT,
  blocker_type TEXT NOT NULL,
  blocker_source TEXT,
  blocker_title TEXT,
  blocker_message TEXT,
  blocker_text TEXT,
  severity TEXT NOT NULL DEFAULT 'warning',
  required_action TEXT,
  resolver_route TEXT,
  admin_required BOOLEAN NOT NULL DEFAULT FALSE,
  user_required BOOLEAN NOT NULL DEFAULT TRUE,
  deadline_at TIMESTAMPTZ,
  detected_at TIMESTAMPTZ DEFAULT now(),
  resolution_strategy TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by_user_id TEXT,
  unresolved_reason TEXT,
  user_notification_id TEXT,
  admin_notification_ids TEXT,
  requires_user_action BOOLEAN NOT NULL DEFAULT FALSE,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_yana_blockers_task     ON yana_blockers(task_id);
CREATE INDEX IF NOT EXISTS idx_yana_blockers_profile  ON yana_blockers(profile_id);
CREATE INDEX IF NOT EXISTS idx_yana_blockers_type     ON yana_blockers(blocker_type);
CREATE INDEX IF NOT EXISTS idx_yana_blockers_open     ON yana_blockers(task_id, resolved_at);
CREATE INDEX IF NOT EXISTS idx_yana_blockers_admin    ON yana_blockers(admin_required, resolved_at);

CREATE TABLE IF NOT EXISTS yana_blocker_resolutions (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  blocker_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempted_at TIMESTAMPTZ DEFAULT now(),
  strategy TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved_by_user_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_yana_blocker_res_blocker ON yana_blocker_resolutions(blocker_id);
CREATE INDEX IF NOT EXISTS idx_yana_blocker_res_task    ON yana_blocker_resolutions(task_id);

CREATE TABLE IF NOT EXISTS yana_saved_sessions (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  portal_host TEXT NOT NULL,
  label TEXT,
  storage_state_path TEXT,
  storage_state_ref TEXT,
  authentication_strategy TEXT,
  established_at TIMESTAMPTZ DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'valid' CHECK(status IN ('valid','expired','revoked')),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_yana_sessions_profile ON yana_saved_sessions(profile_id);
CREATE INDEX IF NOT EXISTS idx_yana_sessions_host    ON yana_saved_sessions(portal_host);
CREATE INDEX IF NOT EXISTS idx_yana_sessions_status  ON yana_saved_sessions(status);

CREATE TABLE IF NOT EXISTS yana_payment_authorizations (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  category TEXT NOT NULL,
  max_amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  payment_method_reference TEXT,
  payment_method_label TEXT,
  allowed_portal_hosts TEXT,
  authorization_text TEXT NOT NULL,
  spent_cents INTEGER NOT NULL DEFAULT 0,
  approved_at TIMESTAMPTZ DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_yana_pay_profile ON yana_payment_authorizations(profile_id);
CREATE INDEX IF NOT EXISTS idx_yana_pay_active  ON yana_payment_authorizations(profile_id, category, revoked_at);

CREATE TABLE IF NOT EXISTS yana_attestation_authorizations (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  category TEXT NOT NULL,
  pattern TEXT NOT NULL,
  authorization_text TEXT NOT NULL,
  approved_at TIMESTAMPTZ DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_yana_attest_profile ON yana_attestation_authorizations(profile_id);
CREATE INDEX IF NOT EXISTS idx_yana_attest_active  ON yana_attestation_authorizations(profile_id, category, revoked_at);

CREATE TABLE IF NOT EXISTS yana_portal_policies (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  portal_host TEXT NOT NULL UNIQUE,
  automation_allowed BOOLEAN NOT NULL DEFAULT TRUE,
  agent_submission_allowed BOOLEAN NOT NULL DEFAULT TRUE,
  scraping_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  api_available BOOLEAN NOT NULL DEFAULT FALSE,
  manual_only BOOLEAN NOT NULL DEFAULT FALSE,
  fallback_path TEXT,
  source_of_policy TEXT,
  last_checked_at TIMESTAMPTZ,
  notes TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_yana_policy_host ON yana_portal_policies(portal_host);

CREATE TABLE IF NOT EXISTS yana_resolved_fields (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  profile_id TEXT NOT NULL,
  user_id TEXT,
  field_key TEXT NOT NULL,
  field_value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_yana_resolved_profile ON yana_resolved_fields(profile_id);
CREATE INDEX IF NOT EXISTS idx_yana_resolved_key     ON yana_resolved_fields(profile_id, field_key);
