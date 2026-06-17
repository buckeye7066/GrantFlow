-- Postgres migration 0081: Yana — student-university portal layer + application tasks.
-- Mirror of SQLite migration 085. Idempotent.

CREATE TABLE IF NOT EXISTS student_portals (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id TEXT,
  school_id TEXT,
  school_normalized TEXT,
  school_display_name TEXT,
  portal_type TEXT NOT NULL CHECK(portal_type IN (
    'financial_aid','scholarship','admissions','student_account','bursar',
    'department','graduate_school','program_specific','external_application','manual_or_offline'
  )),
  portal_name TEXT,
  portal_url TEXT,
  login_url TEXT,
  application_url TEXT,
  sso_required BOOLEAN NOT NULL DEFAULT FALSE,
  credentials_required BOOLEAN NOT NULL DEFAULT FALSE,
  credentials_status TEXT NOT NULL DEFAULT 'unknown' CHECK(credentials_status IN (
    'unknown','needed','stored_reference','user_session_required','unavailable'
  )),
  last_checked_at TIMESTAMPTZ,
  last_check_status TEXT,
  source TEXT NOT NULL DEFAULT 'inferred' CHECK(source IN (
    'profile','knownSchools','crawler','user_entered','inferred'
  )),
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK(confidence >= 0 AND confidence <= 1),
  reason TEXT,
  metadata_json JSONB DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_student_portals_profile_id ON student_portals(profile_id);
CREATE INDEX IF NOT EXISTS idx_student_portals_user_id    ON student_portals(user_id);
CREATE INDEX IF NOT EXISTS idx_student_portals_school     ON student_portals(school_normalized);
CREATE INDEX IF NOT EXISTS idx_student_portals_type       ON student_portals(portal_type);
CREATE INDEX IF NOT EXISTS idx_student_portals_active     ON student_portals(active);
CREATE UNIQUE INDEX IF NOT EXISTS ux_student_portals_profile_school_type
  ON student_portals(profile_id, COALESCE(school_normalized,''), portal_type);

CREATE TABLE IF NOT EXISTS application_portal_links (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id TEXT,
  opportunity_id TEXT,
  grant_id TEXT,
  portal_id TEXT REFERENCES student_portals(id) ON DELETE SET NULL,
  school_id TEXT,
  portal_type TEXT NOT NULL,
  action_type TEXT,
  application_url TEXT,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  reasons_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_requirements_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  can_yana_attempt BOOLEAN NOT NULL DEFAULT FALSE,
  requires_user_login BOOLEAN NOT NULL DEFAULT FALSE,
  requires_admin_review BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_portal_links_profile      ON application_portal_links(profile_id);
CREATE INDEX IF NOT EXISTS idx_app_portal_links_opp          ON application_portal_links(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_app_portal_links_grant        ON application_portal_links(grant_id);
CREATE INDEX IF NOT EXISTS idx_app_portal_links_portal       ON application_portal_links(portal_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_app_portal_links_profile_opp
  ON application_portal_links(profile_id, COALESCE(opportunity_id,''), COALESCE(grant_id,''));

CREATE TABLE IF NOT EXISTS application_tasks (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  user_id TEXT,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  opportunity_id TEXT,
  grant_id TEXT,
  portal_id TEXT REFERENCES student_portals(id) ON DELETE SET NULL,
  application_id TEXT,
  assigned_agent TEXT NOT NULL DEFAULT 'yana',
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
    'queued','ready','waiting_for_user','waiting_for_admin','blocked_login_required',
    'blocked_missing_info','blocked_2fa','blocked_captcha','blocked_terms_or_policy',
    'in_progress','draft_completed','submitted','failed','cancelled'
  )),
  current_step TEXT,
  missing_fields_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_documents_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_user_actions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_agent_message TEXT,
  auto_submit_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  submitted_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_application_tasks_profile  ON application_tasks(profile_id);
CREATE INDEX IF NOT EXISTS idx_application_tasks_user     ON application_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_application_tasks_opp      ON application_tasks(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_application_tasks_grant    ON application_tasks(grant_id);
CREATE INDEX IF NOT EXISTS idx_application_tasks_status   ON application_tasks(status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_application_tasks_profile_subject
  ON application_tasks(profile_id, COALESCE(opportunity_id,''), COALESCE(grant_id,''));

CREATE TABLE IF NOT EXISTS application_task_events (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  task_id TEXT NOT NULL REFERENCES application_tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  status TEXT,
  step TEXT,
  message TEXT,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id TEXT,
  actor_role TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_application_task_events_task ON application_task_events(task_id);
CREATE INDEX IF NOT EXISTS idx_application_task_events_type ON application_task_events(event_type);
CREATE INDEX IF NOT EXISTS idx_application_task_events_created ON application_task_events(created_at);

CREATE TABLE IF NOT EXISTS application_missing_info (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  task_id TEXT NOT NULL REFERENCES application_tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('field','document','login','consent','signature','attestation','admin_review','other')),
  key TEXT NOT NULL,
  label TEXT,
  description TEXT,
  required BOOLEAN NOT NULL DEFAULT TRUE,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  resolved_value_json JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_application_missing_info_task ON application_missing_info(task_id);
CREATE INDEX IF NOT EXISTS idx_application_missing_info_kind ON application_missing_info(kind);
CREATE INDEX IF NOT EXISTS idx_application_missing_info_resolved ON application_missing_info(resolved);
CREATE UNIQUE INDEX IF NOT EXISTS ux_application_missing_info_task_kind_key
  ON application_missing_info(task_id, kind, key);

CREATE TABLE IF NOT EXISTS yana_runs (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  task_id TEXT,
  profile_id TEXT,
  user_id TEXT,
  mode TEXT NOT NULL DEFAULT 'observe',
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  application_tasks_processed INTEGER DEFAULT 0,
  fields_filled INTEGER DEFAULT 0,
  missing_info_detected INTEGER DEFAULT 0,
  drafts_completed INTEGER DEFAULT 0,
  submissions_completed INTEGER DEFAULT 0,
  blocked_safety INTEGER DEFAULT 0,
  notifications_emitted INTEGER DEFAULT 0,
  urls_fetched INTEGER DEFAULT 0,
  leads_found INTEGER DEFAULT 0,
  summary_json JSONB DEFAULT '{}'::jsonb,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_yana_runs_task     ON yana_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_yana_runs_profile  ON yana_runs(profile_id);
CREATE INDEX IF NOT EXISTS idx_yana_runs_started  ON yana_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_yana_runs_status   ON yana_runs(status);
