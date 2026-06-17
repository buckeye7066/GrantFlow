-- 088_yana_authorizations.sql
-- @sqlite-continue-on-idempotent-errors
--
-- Yana Autopilot authorization model. Persists the user's standing
-- consent to let Yana run unattended: complete forms, upload docs,
-- generate narratives, save drafts, submit applications, reuse
-- saved sessions, etc.
--
-- One row per (user_id, profile_id, scope, authorization_type,
-- funding-source-target). Revocation is a status transition
-- (revoked_at IS NOT NULL), never a delete — the audit trail must
-- show every authorization that ever existed.

CREATE TABLE IF NOT EXISTS yana_authorizations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('profile','task','funding_source')),
  authorization_type TEXT NOT NULL,
  -- Optional targeting for scope='funding_source' or scope='task'.
  funding_source_id TEXT,
  task_id TEXT,
  -- Exact text shown to the user on the authorization screen.
  authorization_text TEXT NOT NULL,
  -- Authorization version, e.g. "yana-autopilot-v1".
  authorization_version TEXT NOT NULL DEFAULT 'yana-autopilot-v1',
  -- The selected option payload (which checkboxes were ticked, etc.).
  options_json TEXT NOT NULL DEFAULT '{}',
  -- Free-form metadata: ip, user_agent, ...
  metadata_json TEXT NOT NULL DEFAULT '{}',
  accepted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME,
  revoked_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_yana_auth_user        ON yana_authorizations(user_id);
CREATE INDEX IF NOT EXISTS idx_yana_auth_profile     ON yana_authorizations(profile_id);
CREATE INDEX IF NOT EXISTS idx_yana_auth_scope       ON yana_authorizations(scope);
CREATE INDEX IF NOT EXISTS idx_yana_auth_type        ON yana_authorizations(authorization_type);
CREATE INDEX IF NOT EXISTS idx_yana_auth_funding     ON yana_authorizations(funding_source_id);
CREATE INDEX IF NOT EXISTS idx_yana_auth_task        ON yana_authorizations(task_id);
CREATE INDEX IF NOT EXISTS idx_yana_auth_active      ON yana_authorizations(profile_id, authorization_type, revoked_at);

-- Provider automation extension. The schoolPortalImportService had a
-- pilot/manual-only assumption baked in; we now record explicit
-- automation capabilities per provider so adapters can pick the right
-- strategy without hard-coding.
CREATE TABLE IF NOT EXISTS yana_portal_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT,
  portal_url TEXT,
  -- Comma-separated set drawn from:
  --   pilot_manual_import, browser_autopilot, browser_session_reuse,
  --   secure_credential_reference, api_integration
  integration_modes TEXT NOT NULL DEFAULT 'pilot_manual_import',
  live_supported INTEGER NOT NULL DEFAULT 0,
  automation_supported INTEGER NOT NULL DEFAULT 0,
  authentication_strategy TEXT,            -- e.g. 'shibboleth', 'oauth', 'sso', 'username_password', 'magic_link'
  session_reuse_supported INTEGER NOT NULL DEFAULT 0,
  credential_reference_supported INTEGER NOT NULL DEFAULT 0,
  captcha_likely INTEGER NOT NULL DEFAULT 0,
  two_factor_likely INTEGER NOT NULL DEFAULT 0,
  tos_notes TEXT,
  adapter_name TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Yana Autopilot run table — one row per attempted unattended run.
-- Stores preflight result, blockers, confirmation, and a pointer back
-- to the application_tasks row.
CREATE TABLE IF NOT EXISTS yana_autopilot_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  task_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  user_id TEXT,
  authorization_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
    'queued','preflight','running','blocked','completed','submitted','failed','cancelled'
  )),
  blocker_kind TEXT,                -- 'login','2fa','captcha','payment','signature','attestation','missing_info','tos','antibot','low_confidence', NULL
  blocker_detail TEXT,
  preflight_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  confirmation_reference TEXT,
  confirmation_screenshot_path TEXT,
  started_at DATETIME,
  finished_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_yana_autopilot_task     ON yana_autopilot_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_yana_autopilot_profile  ON yana_autopilot_runs(profile_id);
CREATE INDEX IF NOT EXISTS idx_yana_autopilot_status   ON yana_autopilot_runs(status);
