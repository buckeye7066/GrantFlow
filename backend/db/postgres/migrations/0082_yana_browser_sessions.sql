-- 0082_yana_browser_sessions.sql (Postgres mirror of SQLite 086)
--
-- See backend/db/migrations/086_yana_browser_sessions.sql for the full
-- design rationale. Postgres uses the same shape with native JSONB +
-- TIMESTAMPTZ + BOOLEAN + a partial unique index on the active row.

CREATE TABLE IF NOT EXISTS yana_browser_sessions (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  task_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  user_id TEXT,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN (
    'not_started','launching_browser','waiting_for_user_login',
    'waiting_for_2fa','waiting_for_captcha','inspecting_form',
    'mapping_fields','filling_fields','missing_info_required',
    'waiting_for_user_review','ready_for_submit','submitted',
    'blocked','failed','cancelled'
  )),
  portal_url TEXT,
  login_url TEXT,
  application_url TEXT,
  current_url TEXT,
  page_title TEXT,
  storage_state_path TEXT,
  headless BOOLEAN NOT NULL DEFAULT FALSE,
  field_map_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  filled_fields_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  missing_fields_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_actions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  pre_submit_snapshot_path TEXT,
  last_screenshot_path TEXT,
  confirmation_reference TEXT,
  approved_to_submit BOOLEAN NOT NULL DEFAULT FALSE,
  last_activity_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_yana_browser_sessions_task    ON yana_browser_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_yana_browser_sessions_profile ON yana_browser_sessions(profile_id);
CREATE INDEX IF NOT EXISTS idx_yana_browser_sessions_user    ON yana_browser_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_yana_browser_sessions_status  ON yana_browser_sessions(status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_yana_browser_sessions_task_active
  ON yana_browser_sessions(task_id)
  WHERE status NOT IN ('submitted','cancelled','failed');
