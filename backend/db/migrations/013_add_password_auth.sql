-- Add password-based authentication support.
--
-- This migration is SQLite-focused (used for local/dev + unit tests).

ALTER TABLE users ADD COLUMN password_hash TEXT;

CREATE TABLE IF NOT EXISTS password_setup_tokens (
  id TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT NULL,
  request_ip TEXT NULL,
  user_agent TEXT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_token_hash ON password_setup_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_user_id ON password_setup_tokens(user_id);
