CREATE TABLE IF NOT EXISTS auth_refresh_token_history (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
  replaced_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  reuse_detected_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_auth_refresh_history_session
  ON auth_refresh_token_history(session_id);

CREATE INDEX IF NOT EXISTS idx_auth_refresh_history_expires
  ON auth_refresh_token_history(expires_at);
