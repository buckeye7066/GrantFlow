-- 090_rename_yana_to_hamilton.sql
-- @sqlite-continue-on-idempotent-errors
--
-- The application-autopilot agent was renamed from "Yana" to
-- "Hamilton" because the existing Yana name belongs to the lead/
-- client-discovery agent.
--
-- This migration handles BOTH:
--   1. Dev databases that already ran migrations 088 / 089 (and so have
--      legacy yana_* tables): an ALTER TABLE ... RENAME TO renames them
--      to hamilton_*.
--   2. Fresh databases that have never seen the yana_* tables: the
--      CREATE TABLE IF NOT EXISTS hamilton_* statements below create
--      the canonical Hamilton schema directly.
--
-- The migration runner tolerates errors thanks to
-- @sqlite-continue-on-idempotent-errors — every ALTER fails harmlessly
-- when the target table already exists or the source table doesn't.

ALTER TABLE yana_authorizations            RENAME TO hamilton_authorizations;
ALTER TABLE yana_portal_providers          RENAME TO hamilton_portal_providers;
ALTER TABLE yana_autopilot_runs            RENAME TO hamilton_autopilot_runs;
ALTER TABLE yana_blockers                  RENAME TO hamilton_blockers;
ALTER TABLE yana_blocker_resolutions       RENAME TO hamilton_blocker_resolutions;
ALTER TABLE yana_saved_sessions            RENAME TO hamilton_saved_sessions;
ALTER TABLE yana_payment_authorizations    RENAME TO hamilton_payment_authorizations;
ALTER TABLE yana_attestation_authorizations RENAME TO hamilton_attestation_authorizations;
ALTER TABLE yana_portal_policies           RENAME TO hamilton_portal_policies;
ALTER TABLE yana_resolved_fields           RENAME TO hamilton_resolved_fields;
-- yana_runs was historically the autopilot's per-run log (written by
-- the agent formerly known as Yana, now Hamilton). The aggregator
-- previously read urls_fetched / leads_found from this table for
-- compatibility reasons; those columns were never populated by the
-- autopilot, so renaming it to hamilton_runs has no functional
-- impact on lead-discovery telemetry.
ALTER TABLE yana_runs                      RENAME TO hamilton_runs;

-- Canonical hamilton_* tables for fresh databases.
CREATE TABLE IF NOT EXISTS hamilton_authorizations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
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
  accepted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME,
  revoked_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hamilton_auth_user        ON hamilton_authorizations(user_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_auth_profile     ON hamilton_authorizations(profile_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_auth_scope       ON hamilton_authorizations(scope);
CREATE INDEX IF NOT EXISTS idx_hamilton_auth_type        ON hamilton_authorizations(authorization_type);
CREATE INDEX IF NOT EXISTS idx_hamilton_auth_funding     ON hamilton_authorizations(funding_source_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_auth_task        ON hamilton_authorizations(task_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_auth_active      ON hamilton_authorizations(profile_id, authorization_type, revoked_at);

CREATE TABLE IF NOT EXISTS hamilton_portal_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT,
  portal_url TEXT,
  integration_modes TEXT NOT NULL DEFAULT 'pilot_manual_import',
  live_supported INTEGER NOT NULL DEFAULT 0,
  automation_supported INTEGER NOT NULL DEFAULT 0,
  authentication_strategy TEXT,
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

CREATE TABLE IF NOT EXISTS hamilton_autopilot_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  task_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  user_id TEXT,
  authorization_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
    'queued','preflight','running','blocked','completed','submitted','failed','cancelled'
  )),
  blocker_kind TEXT,
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
CREATE INDEX IF NOT EXISTS idx_hamilton_autopilot_task     ON hamilton_autopilot_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_autopilot_profile  ON hamilton_autopilot_runs(profile_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_autopilot_status   ON hamilton_autopilot_runs(status);

CREATE TABLE IF NOT EXISTS hamilton_blockers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
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
  admin_required INTEGER NOT NULL DEFAULT 0,
  user_required INTEGER NOT NULL DEFAULT 1,
  deadline_at DATETIME,
  detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolution_strategy TEXT,
  resolved_at DATETIME,
  resolved_by_user_id TEXT,
  unresolved_reason TEXT,
  user_notification_id TEXT,
  admin_notification_ids TEXT,
  requires_user_action INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hamilton_blockers_task     ON hamilton_blockers(task_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_blockers_profile  ON hamilton_blockers(profile_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_blockers_type     ON hamilton_blockers(blocker_type);
CREATE INDEX IF NOT EXISTS idx_hamilton_blockers_open     ON hamilton_blockers(task_id, resolved_at);
CREATE INDEX IF NOT EXISTS idx_hamilton_blockers_admin    ON hamilton_blockers(admin_required, resolved_at);

CREATE TABLE IF NOT EXISTS hamilton_blocker_resolutions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  blocker_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  strategy TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  resolved_by_user_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hamilton_blocker_res_blocker ON hamilton_blocker_resolutions(blocker_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_blocker_res_task    ON hamilton_blocker_resolutions(task_id);

CREATE TABLE IF NOT EXISTS hamilton_saved_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  portal_host TEXT NOT NULL,
  label TEXT,
  storage_state_path TEXT,
  storage_state_ref TEXT,
  authentication_strategy TEXT,
  established_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME,
  expires_at DATETIME,
  status TEXT NOT NULL DEFAULT 'valid' CHECK(status IN ('valid','expired','revoked')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hamilton_sessions_profile ON hamilton_saved_sessions(profile_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_sessions_host    ON hamilton_saved_sessions(portal_host);
CREATE INDEX IF NOT EXISTS idx_hamilton_sessions_status  ON hamilton_saved_sessions(status);

CREATE TABLE IF NOT EXISTS hamilton_payment_authorizations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
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
  approved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME,
  expires_at DATETIME,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hamilton_pay_profile ON hamilton_payment_authorizations(profile_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_pay_active  ON hamilton_payment_authorizations(profile_id, category, revoked_at);

CREATE TABLE IF NOT EXISTS hamilton_attestation_authorizations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  category TEXT NOT NULL,
  pattern TEXT NOT NULL,
  authorization_text TEXT NOT NULL,
  approved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hamilton_attest_profile ON hamilton_attestation_authorizations(profile_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_attest_active  ON hamilton_attestation_authorizations(profile_id, category, revoked_at);

CREATE TABLE IF NOT EXISTS hamilton_portal_policies (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  portal_host TEXT NOT NULL UNIQUE,
  automation_allowed INTEGER NOT NULL DEFAULT 1,
  agent_submission_allowed INTEGER NOT NULL DEFAULT 1,
  scraping_allowed INTEGER NOT NULL DEFAULT 0,
  api_available INTEGER NOT NULL DEFAULT 0,
  manual_only INTEGER NOT NULL DEFAULT 0,
  fallback_path TEXT,
  source_of_policy TEXT,
  last_checked_at DATETIME,
  notes TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hamilton_policy_host ON hamilton_portal_policies(portal_host);

CREATE TABLE IF NOT EXISTS hamilton_resolved_fields (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  profile_id TEXT NOT NULL,
  user_id TEXT,
  field_key TEXT NOT NULL,
  field_value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  resolved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hamilton_resolved_profile ON hamilton_resolved_fields(profile_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_resolved_key     ON hamilton_resolved_fields(profile_id, field_key);

-- Cleanup pass: on fresh DBs `schema.sql` already created the canonical
-- hamilton_* tables, so the ALTER TABLE ... RENAME statements above were
-- swallowed harmlessly — but the empty yana_* sources (created by
-- migrations 088 / 089) are now orphans. Drop them so the runtime
-- doesn't carry two copies of the same schema. On dev DBs that DID
-- complete the rename, these DROPs are no-ops because the yana_* tables
-- have already been renamed away.
DROP TABLE IF EXISTS yana_authorizations;
DROP TABLE IF EXISTS yana_portal_providers;
DROP TABLE IF EXISTS yana_autopilot_runs;
DROP TABLE IF EXISTS yana_blockers;
DROP TABLE IF EXISTS yana_blocker_resolutions;
DROP TABLE IF EXISTS yana_saved_sessions;
DROP TABLE IF EXISTS yana_payment_authorizations;
DROP TABLE IF EXISTS yana_attestation_authorizations;
DROP TABLE IF EXISTS yana_portal_policies;
DROP TABLE IF EXISTS yana_resolved_fields;
DROP TABLE IF EXISTS yana_runs;
