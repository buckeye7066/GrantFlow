CREATE TABLE IF NOT EXISTS auth_refresh_token_history (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
  replaced_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  reuse_detected_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_auth_refresh_history_session
  ON auth_refresh_token_history(session_id);

CREATE INDEX IF NOT EXISTS idx_auth_refresh_history_expires
  ON auth_refresh_token_history(expires_at);
