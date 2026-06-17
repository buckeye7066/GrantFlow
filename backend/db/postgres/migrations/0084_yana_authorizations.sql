-- 0084_yana_authorizations.sql (Postgres mirror of SQLite 088)
-- See backend/db/migrations/088_yana_authorizations.sql for design.

CREATE TABLE IF NOT EXISTS yana_authorizations (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('profile','task','funding_source')),
  authorization_type TEXT NOT NULL,
  funding_source_id TEXT,
  task_id TEXT,
  authorization_text TEXT NOT NULL,
  authorization_version TEXT NOT NULL DEFAULT 'yana-autopilot-v1',
  options_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  accepted_at TIMESTAMPTZ DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_yana_auth_user        ON yana_authorizations(user_id);
CREATE INDEX IF NOT EXISTS idx_yana_auth_profile     ON yana_authorizations(profile_id);
CREATE INDEX IF NOT EXISTS idx_yana_auth_scope       ON yana_authorizations(scope);
CREATE INDEX IF NOT EXISTS idx_yana_auth_type        ON yana_authorizations(authorization_type);
CREATE INDEX IF NOT EXISTS idx_yana_auth_funding     ON yana_authorizations(funding_source_id);
CREATE INDEX IF NOT EXISTS idx_yana_auth_task        ON yana_authorizations(task_id);
CREATE INDEX IF NOT EXISTS idx_yana_auth_active      ON yana_authorizations(profile_id, authorization_type, revoked_at);

CREATE TABLE IF NOT EXISTS yana_portal_providers (
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

CREATE TABLE IF NOT EXISTS yana_autopilot_runs (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  task_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  user_id TEXT,
  authorization_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
    'queued','preflight','running','blocked','completed','submitted','failed','cancelled'
  )),
  blocker_kind TEXT,
  blocker_detail TEXT,
  preflight_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  confirmation_reference TEXT,
  confirmation_screenshot_path TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_yana_autopilot_task     ON yana_autopilot_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_yana_autopilot_profile  ON yana_autopilot_runs(profile_id);
CREATE INDEX IF NOT EXISTS idx_yana_autopilot_status   ON yana_autopilot_runs(status);
