-- SQLite parity with backend/db/postgres/migrations/0108_hamilton_session_capture_requests.sql
--
-- Hamilton "Capture login session" request queue.
--
-- The backend runs in the cloud and cannot open the user's browser, so the
-- in-app "Capture login session" button records an INTENT here (bound to a
-- specific user + profile + portal host + login URL). The owner's local
-- laptop-connector polls these pending requests, opens a real browser to the
-- login URL so the human can complete username/password + 2FA, captures the
-- resulting Playwright storageState, and uploads it to /sessions/import — which
-- verifies the request's profile matches and then marks the request completed.
--
-- Profile-scoped on purpose: a request is always tied to ONE profile, so a
-- captured session can never be filed under the wrong profile (the safeguard
-- for two users on the same portal host, e.g. two MTSU students).

CREATE TABLE IF NOT EXISTS hamilton_session_capture_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  profile_id TEXT NOT NULL,
  portal_host TEXT NOT NULL,
  login_url TEXT,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending|launched|completed|cancelled|expired
  session_id TEXT,                          -- hamilton_saved_sessions.id once captured
  requested_by_email TEXT,
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  expires_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_hamilton_capreq_profile ON hamilton_session_capture_requests(profile_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_capreq_status ON hamilton_session_capture_requests(status);
CREATE INDEX IF NOT EXISTS idx_hamilton_capreq_status_created ON hamilton_session_capture_requests(status, created_at);
