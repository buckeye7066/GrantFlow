-- 0086_rename_yana_to_hamilton.sql
--
-- Postgres mirror of migration 090. Handles BOTH:
--   1. Dev databases that already ran the legacy yana_* migrations.
--   2. Fresh databases that have never seen yana_* tables.

ALTER TABLE IF EXISTS yana_authorizations             RENAME TO hamilton_authorizations;
ALTER TABLE IF EXISTS yana_portal_providers           RENAME TO hamilton_portal_providers;
ALTER TABLE IF EXISTS yana_autopilot_runs             RENAME TO hamilton_autopilot_runs;
ALTER TABLE IF EXISTS yana_blockers                   RENAME TO hamilton_blockers;
ALTER TABLE IF EXISTS yana_blocker_resolutions        RENAME TO hamilton_blocker_resolutions;
ALTER TABLE IF EXISTS yana_saved_sessions             RENAME TO hamilton_saved_sessions;
ALTER TABLE IF EXISTS yana_payment_authorizations     RENAME TO hamilton_payment_authorizations;
ALTER TABLE IF EXISTS yana_attestation_authorizations RENAME TO hamilton_attestation_authorizations;
ALTER TABLE IF EXISTS yana_portal_policies            RENAME TO hamilton_portal_policies;
ALTER TABLE IF EXISTS yana_resolved_fields            RENAME TO hamilton_resolved_fields;
-- yana_runs is historically Hamilton's autopilot run log; rename it.
ALTER TABLE IF EXISTS yana_runs                       RENAME TO hamilton_runs;

-- Canonical hamilton_* tables for fresh databases.
CREATE TABLE IF NOT EXISTS hamilton_authorizations (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('profile','task','funding_source')),
  authorization_type TEXT NOT NULL,
  funding_source_id TEXT,
  task_id TEXT,
  authorization_text TEXT NOT NULL,
  authorization_version TEXT NOT NULL DEFAULT 'hamilton-autopilot-v1',
  options_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  accepted_at TIMESTAMPTZ DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hamilton_auth_user        ON hamilton_authorizations(user_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_auth_profile     ON hamilton_authorizations(profile_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_auth_active      ON hamilton_authorizations(profile_id, authorization_type, revoked_at);

CREATE TABLE IF NOT EXISTS hamilton_portal_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT,
  portal_url TEXT,
  integration_modes TEXT NOT NULL DEFAULT 'pilot_manual_import',
  live_supported BOOLEAN NOT NULL DEFAULT FALSE,
  automation_supported BOOLEAN NOT NULL DEFAULT FALSE,
  authentication_strategy TEXT,
  session_reuse_supported BOOLEAN NOT NULL DEFAULT FALSE,
  credential_reference_supported BOOLEAN NOT NULL DEFAULT FALSE,
  captcha_likely BOOLEAN NOT NULL DEFAULT FALSE,
  two_factor_likely BOOLEAN NOT NULL DEFAULT FALSE,
  tos_notes TEXT,
  adapter_name TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hamilton_autopilot_runs (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  task_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  user_id TEXT,
  authorization_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  blocker_kind TEXT,
  blocker_detail TEXT,
  preflight_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  confirmation_reference TEXT,
  confirmation_screenshot_path TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hamilton_autopilot_task     ON hamilton_autopilot_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_autopilot_profile  ON hamilton_autopilot_runs(profile_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_autopilot_status   ON hamilton_autopilot_runs(status);

CREATE TABLE IF NOT EXISTS hamilton_blockers (
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
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hamilton_blockers_task     ON hamilton_blockers(task_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_blockers_open     ON hamilton_blockers(task_id, resolved_at);
CREATE INDEX IF NOT EXISTS idx_hamilton_blockers_admin    ON hamilton_blockers(admin_required, resolved_at);

CREATE TABLE IF NOT EXISTS hamilton_blocker_resolutions (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  blocker_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempted_at TIMESTAMPTZ DEFAULT now(),
  strategy TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  resolved_by_user_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hamilton_saved_sessions (
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
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hamilton_payment_authorizations (
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
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hamilton_attestation_authorizations (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  category TEXT NOT NULL,
  pattern TEXT NOT NULL,
  authorization_text TEXT NOT NULL,
  approved_at TIMESTAMPTZ DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hamilton_portal_policies (
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
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hamilton_resolved_fields (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  profile_id TEXT NOT NULL,
  user_id TEXT,
  field_key TEXT NOT NULL,
  field_value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  resolved_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
