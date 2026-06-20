-- Hamilton "Capture login session" request queue (Postgres). SQLite parity:
--   backend/db/migrations/111_hamilton_session_capture_requests.sql
--
-- In-app "Capture login session" records an intent bound to one user + profile
-- + portal host; the owner's local laptop-connector polls pending rows, opens a
-- browser for the human to log in + clear 2FA, captures the Playwright
-- storageState, and uploads it. Profile-scoped so a captured session can never
-- be filed under the wrong profile (two users on the same portal host).

CREATE TABLE IF NOT EXISTS hamilton_session_capture_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  profile_id TEXT NOT NULL,
  portal_host TEXT NOT NULL,
  login_url TEXT,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  session_id TEXT,
  requested_by_email TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_hamilton_capreq_profile ON hamilton_session_capture_requests(profile_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_capreq_status ON hamilton_session_capture_requests(status);
CREATE INDEX IF NOT EXISTS idx_hamilton_capreq_status_created ON hamilton_session_capture_requests(status, created_at);
