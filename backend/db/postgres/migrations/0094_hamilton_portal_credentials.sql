-- Per-profile saved portal LOGINS that Hamilton uses to authenticate.
-- Password is encrypted at rest (AES-256-GCM via runtimeSecrets); plaintext is
-- never stored and never returned to a client. See
-- backend/services/hamilton/hamiltonPortalCredentialService.js.
CREATE TABLE IF NOT EXISTS hamilton_portal_credentials (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  portal_host TEXT NOT NULL,
  label TEXT,
  login_url TEXT,
  username TEXT,
  password_ciphertext TEXT,
  password_iv TEXT,
  password_tag TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_hamilton_portal_cred_profile_host
  ON hamilton_portal_credentials(profile_id, portal_host);
CREATE INDEX IF NOT EXISTS idx_hamilton_portal_cred_profile
  ON hamilton_portal_credentials(profile_id);
