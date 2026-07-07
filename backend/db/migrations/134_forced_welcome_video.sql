-- Migration 134: forced welcome video gate (SQLite; Postgres twin is 0138).
--
-- media_assets: durable opaque media blobs (the 26MB welcome clip lives here),
-- streamed by GET /api/media/:id with HTTP Range support. Durable-blob
-- precedent: documents.file_bytes, profiles.avatar_data (Railway's disk is
-- ephemeral, so media must live in the DB).
--
-- forced_welcome_videos: a one-time gate. An UNCONSUMED row (consumed_at IS
-- NULL) whose match_email = the user's primary_email OR match_profile_id = one
-- of the user's linked profiles forces the video ahead of every onboarding
-- branch on next login. Consume is monotonic, so it never replays.

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  media_key TEXT UNIQUE,
  mime_type TEXT,
  bytes BLOB,
  size_bytes INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS forced_welcome_videos (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  media_asset_id TEXT REFERENCES media_assets(id) ON DELETE CASCADE,
  match_email TEXT,
  match_profile_id TEXT,
  label TEXT,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  consumed_at TEXT DEFAULT NULL,
  consumed_by_user_id TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_forced_welcome_videos_email
  ON forced_welcome_videos(consumed_at, match_email);
CREATE INDEX IF NOT EXISTS idx_forced_welcome_videos_profile
  ON forced_welcome_videos(consumed_at, match_profile_id);
