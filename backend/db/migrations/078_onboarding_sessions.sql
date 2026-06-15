-- 078_onboarding_sessions.sql
-- Persists in-flight Anya conversational onboarding sessions so a visitor can
-- complete the interview, hand over an email, and finally have a profile +
-- credential created with everything they answered.
--
-- Mission: this is the single new-user funnel — every field collected here
-- must round-trip into a canonical profile section so crawlers and the
-- matching engine pick it up (Goals 1-3, 5-7, 10).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS is safe to re-run; partial column
-- additions are guarded by sqlite_master probes elsewhere in the repo.
-- @sqlite-continue-on-idempotent-errors

CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  current_question TEXT,
  answers TEXT NOT NULL DEFAULT '{}',
  profile_patch TEXT NOT NULL DEFAULT '{}',
  email TEXT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  user_agent TEXT,
  ip_hash TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_email
  ON onboarding_sessions (email);

CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_status_updated
  ON onboarding_sessions (status, updated_at);
