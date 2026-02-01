BEGIN;

-- Add password-based authentication support.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE TABLE IF NOT EXISTS password_setup_tokens (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  request_ip TEXT NULL,
  user_agent TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_token_hash ON password_setup_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_user_id ON password_setup_tokens(user_id);

COMMIT;
