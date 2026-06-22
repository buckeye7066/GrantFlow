-- @sqlite-continue-on-idempotent-errors
-- Login announcements (SQLite). Postgres parity:
--   backend/db/postgres/migrations/0124_login_announcements.sql
--
-- One-time, dismissible messages shown to users on login (e.g. "how to merge
-- your portals and what that means"). audience is 'all' (broadcast) or a specific
-- profile_id (shown to users who can access that profile). The owner (and Anya
-- on the owner's behalf via owner.create_announcement) creates them.
-- Per-user dismissal in announcement_dismissals so each shows once.

CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_by TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,                 -- markdown
  audience TEXT NOT NULL DEFAULT 'all', -- 'all' OR a profile_id
  type TEXT NOT NULL DEFAULT 'info',  -- info | feature | warning
  active INTEGER NOT NULL DEFAULT 1,
  starts_at DATETIME,
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(active);
CREATE INDEX IF NOT EXISTS idx_announcements_audience ON announcements(audience);

CREATE TABLE IF NOT EXISTS announcement_dismissals (
  user_id TEXT NOT NULL,
  announcement_id TEXT NOT NULL,
  dismissed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, announcement_id)
);
