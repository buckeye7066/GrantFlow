-- 086_yana_browser_sessions.sql
--
-- Yana real-browser-automation layer (Playwright). This migration adds
-- one table that tracks supervised browser sessions per application
-- task. Browser automation is gated behind YANA_ENABLE_BROWSER_AUTOMATION
-- and is never used to bypass CAPTCHA / 2FA / SSO / consent gates.
--
-- Storage:
--   - storage_state_path  → file on disk under YANA_BROWSER_STORAGE_DIR
--                           (Playwright storage state — cookies + tokens
--                           the user produced via supervised login).
--                           Never any plain passwords.
--   - last_screenshot_path / pre_submit_snapshot_path → screenshot files
--                           used for the audit trail.
--
-- Profile scoping is enforced everywhere in code; the indexes below are
-- there for query performance only.

CREATE TABLE IF NOT EXISTS yana_browser_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  task_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  user_id TEXT,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN (
    'not_started',
    'launching_browser',
    'waiting_for_user_login',
    'waiting_for_2fa',
    'waiting_for_captcha',
    'inspecting_form',
    'mapping_fields',
    'filling_fields',
    'missing_info_required',
    'waiting_for_user_review',
    'ready_for_submit',
    'submitted',
    'blocked',
    'failed',
    'cancelled'
  )),
  portal_url TEXT,
  login_url TEXT,
  application_url TEXT,
  current_url TEXT,
  page_title TEXT,
  storage_state_path TEXT,
  headless INTEGER NOT NULL DEFAULT 0,
  field_map_json TEXT NOT NULL DEFAULT '{}',
  filled_fields_json TEXT NOT NULL DEFAULT '{}',
  missing_fields_json TEXT NOT NULL DEFAULT '[]',
  required_actions_json TEXT NOT NULL DEFAULT '[]',
  pre_submit_snapshot_path TEXT,
  last_screenshot_path TEXT,
  confirmation_reference TEXT,
  approved_to_submit INTEGER NOT NULL DEFAULT 0,
  last_activity_at DATETIME,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_yana_browser_sessions_task    ON yana_browser_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_yana_browser_sessions_profile ON yana_browser_sessions(profile_id);
CREATE INDEX IF NOT EXISTS idx_yana_browser_sessions_user    ON yana_browser_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_yana_browser_sessions_status  ON yana_browser_sessions(status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_yana_browser_sessions_task_active
  ON yana_browser_sessions(task_id)
  WHERE status NOT IN ('submitted','cancelled','failed');
