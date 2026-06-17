-- Migration 085: Yana — student-university portal layer + application tasks.
--
-- Adds the canonical, normalized portal model used by Yana (the
-- application-completion agent) to:
--   1. record student portals declared on a profile (financial aid,
--      scholarship, admissions, bursar, department, ...),
--   2. link individual funding opportunities to the correct portal,
--   3. track per-application tasks Yana works on, and
--   4. record per-task missing info + an audit log of every Yana action.
--
-- Existing prior art:
--   - profile_sections.data JSON ("school_portal_imports", "university_applications")
--     stores informal university/portal info but has no normalized record-level
--     fields for `portal_type`, `credentials_status`, `confidence`, etc.
--   - portal_check_results stores ad-hoc per-profile check runs.
--   - applications / application_sections / application_checklist_items
--     (apply engine) handle the application body itself.
--
-- This migration ADDS the missing record-level layer; it does NOT touch
-- profile_sections, portal_check_results, or the apply-engine tables. All
-- statements are idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF
-- NOT EXISTS) so re-running this migration on an upgraded DB is safe.

-- ── student_portals ────────────────────────────────────────────────────
-- One row per (profile, portal). Source-of-truth for portal records that
-- back the Pipeline-page "Linked portal" badges and the StudentPortalsCard
-- expanded view.
CREATE TABLE IF NOT EXISTS student_portals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id TEXT,
  school_id TEXT,
  school_normalized TEXT,
  school_display_name TEXT,
  portal_type TEXT NOT NULL CHECK(portal_type IN (
    'financial_aid',
    'scholarship',
    'admissions',
    'student_account',
    'bursar',
    'department',
    'graduate_school',
    'program_specific',
    'external_application',
    'manual_or_offline'
  )),
  portal_name TEXT,
  portal_url TEXT,
  login_url TEXT,
  application_url TEXT,
  sso_required INTEGER NOT NULL DEFAULT 0,
  credentials_required INTEGER NOT NULL DEFAULT 0,
  credentials_status TEXT NOT NULL DEFAULT 'unknown' CHECK(credentials_status IN (
    'unknown', 'needed', 'stored_reference', 'user_session_required', 'unavailable'
  )),
  last_checked_at DATETIME,
  last_check_status TEXT,
  source TEXT NOT NULL DEFAULT 'inferred' CHECK(source IN (
    'profile', 'knownSchools', 'crawler', 'user_entered', 'inferred'
  )),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence >= 0 AND confidence <= 1),
  reason TEXT,
  metadata_json TEXT DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_student_portals_profile_id ON student_portals(profile_id);
CREATE INDEX IF NOT EXISTS idx_student_portals_user_id    ON student_portals(user_id);
CREATE INDEX IF NOT EXISTS idx_student_portals_school     ON student_portals(school_normalized);
CREATE INDEX IF NOT EXISTS idx_student_portals_type       ON student_portals(portal_type);
CREATE INDEX IF NOT EXISTS idx_student_portals_active     ON student_portals(active);
-- One canonical (profile, school, type) row; same school can have many portal types.
CREATE UNIQUE INDEX IF NOT EXISTS ux_student_portals_profile_school_type
  ON student_portals(profile_id, COALESCE(school_normalized,''), portal_type);

-- ── application_portal_links ───────────────────────────────────────────
-- Each row links a discovered funding opportunity (grant) to the most
-- appropriate student_portals row, with confidence + reasons. One link
-- per (profile, opportunity); a duplicate insert returns the existing
-- row (see studentFundingPortalLinker.upsertLink).
CREATE TABLE IF NOT EXISTS application_portal_links (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id TEXT,
  opportunity_id TEXT,
  grant_id TEXT,
  portal_id TEXT REFERENCES student_portals(id) ON DELETE SET NULL,
  school_id TEXT,
  portal_type TEXT NOT NULL,
  action_type TEXT,                 -- e.g. apply | follow_up | upload_document | login
  application_url TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  missing_requirements_json TEXT NOT NULL DEFAULT '[]',
  can_yana_attempt INTEGER NOT NULL DEFAULT 0,
  requires_user_login INTEGER NOT NULL DEFAULT 0,
  requires_admin_review INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_app_portal_links_profile      ON application_portal_links(profile_id);
CREATE INDEX IF NOT EXISTS idx_app_portal_links_opp          ON application_portal_links(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_app_portal_links_grant        ON application_portal_links(grant_id);
CREATE INDEX IF NOT EXISTS idx_app_portal_links_portal       ON application_portal_links(portal_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_app_portal_links_profile_opp
  ON application_portal_links(profile_id, COALESCE(opportunity_id,''), COALESCE(grant_id,''));

-- ── application_tasks ──────────────────────────────────────────────────
-- One Yana task per (profile, opportunity-or-grant). Tracks status, current
-- step, and a JSON snapshot of missing fields/documents/user actions. The
-- application_id (apply-engine row) is optional — Yana only creates one
-- when the portal is portal/email and an actual draft is needed.
CREATE TABLE IF NOT EXISTS application_tasks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  opportunity_id TEXT,
  grant_id TEXT,
  portal_id TEXT REFERENCES student_portals(id) ON DELETE SET NULL,
  application_id TEXT,
  assigned_agent TEXT NOT NULL DEFAULT 'yana',
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
    'queued',
    'ready',
    'waiting_for_user',
    'waiting_for_admin',
    'blocked_login_required',
    'blocked_missing_info',
    'blocked_2fa',
    'blocked_captcha',
    'blocked_terms_or_policy',
    'in_progress',
    'draft_completed',
    'submitted',
    'failed',
    'cancelled'
  )),
  current_step TEXT,
  missing_fields_json TEXT NOT NULL DEFAULT '[]',
  missing_documents_json TEXT NOT NULL DEFAULT '[]',
  required_user_actions_json TEXT NOT NULL DEFAULT '[]',
  last_agent_message TEXT,
  auto_submit_enabled INTEGER NOT NULL DEFAULT 0,
  submitted_at DATETIME,
  cancelled_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_application_tasks_profile  ON application_tasks(profile_id);
CREATE INDEX IF NOT EXISTS idx_application_tasks_user     ON application_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_application_tasks_opp      ON application_tasks(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_application_tasks_grant    ON application_tasks(grant_id);
CREATE INDEX IF NOT EXISTS idx_application_tasks_status   ON application_tasks(status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_application_tasks_profile_subject
  ON application_tasks(profile_id, COALESCE(opportunity_id,''), COALESCE(grant_id,''));

-- ── application_task_events ────────────────────────────────────────────
-- Append-only audit log of every Yana action (start, fill, missing, alert,
-- submit, cancel, error, ...). The frontend reads these for the timeline.
CREATE TABLE IF NOT EXISTS application_task_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  task_id TEXT NOT NULL REFERENCES application_tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  status TEXT,
  step TEXT,
  message TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  actor_user_id TEXT,
  actor_role TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_application_task_events_task ON application_task_events(task_id);
CREATE INDEX IF NOT EXISTS idx_application_task_events_type ON application_task_events(event_type);
CREATE INDEX IF NOT EXISTS idx_application_task_events_created ON application_task_events(created_at);

-- ── application_missing_info ───────────────────────────────────────────
-- Normalized row per missing field/document/user-action. Lets the frontend
-- render structured "Provide missing info" forms without parsing JSON.
CREATE TABLE IF NOT EXISTS application_missing_info (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  task_id TEXT NOT NULL REFERENCES application_tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('field', 'document', 'login', 'consent', 'signature', 'attestation', 'admin_review', 'other')),
  key TEXT NOT NULL,
  label TEXT,
  description TEXT,
  required INTEGER NOT NULL DEFAULT 1,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_at DATETIME,
  resolved_by TEXT,
  resolved_value_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_application_missing_info_task ON application_missing_info(task_id);
CREATE INDEX IF NOT EXISTS idx_application_missing_info_kind ON application_missing_info(kind);
CREATE INDEX IF NOT EXISTS idx_application_missing_info_resolved ON application_missing_info(resolved);
CREATE UNIQUE INDEX IF NOT EXISTS ux_application_missing_info_task_kind_key
  ON application_missing_info(task_id, kind, key);

-- ── yana_runs ──────────────────────────────────────────────────────────
-- Per-invocation run record so the agent telemetry aggregator can report
-- Yana activity. Defensive — agentTelemetryAggregator already gracefully
-- skips this table when missing, so adding it is non-breaking.
CREATE TABLE IF NOT EXISTS yana_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  task_id TEXT,
  profile_id TEXT,
  user_id TEXT,
  mode TEXT NOT NULL DEFAULT 'observe',
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running',
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  application_tasks_processed INTEGER DEFAULT 0,
  fields_filled INTEGER DEFAULT 0,
  missing_info_detected INTEGER DEFAULT 0,
  drafts_completed INTEGER DEFAULT 0,
  submissions_completed INTEGER DEFAULT 0,
  blocked_safety INTEGER DEFAULT 0,
  notifications_emitted INTEGER DEFAULT 0,
  -- Compatibility columns the existing client-discovery aggregator reads.
  urls_fetched INTEGER DEFAULT 0,
  leads_found INTEGER DEFAULT 0,
  summary_json TEXT DEFAULT '{}',
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_yana_runs_task     ON yana_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_yana_runs_profile  ON yana_runs(profile_id);
CREATE INDEX IF NOT EXISTS idx_yana_runs_started  ON yana_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_yana_runs_status   ON yana_runs(status);
