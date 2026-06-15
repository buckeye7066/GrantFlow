-- 0074_onboarding_sessions.sql
-- Postgres counterpart of 078_onboarding_sessions.sql.
-- Persists in-flight Anya conversational onboarding sessions so a visitor can
-- complete the interview, hand over an email, and finally have a profile +
-- credential created with everything they answered.

CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'in_progress',
  current_question TEXT,
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  profile_patch JSONB NOT NULL DEFAULT '{}'::jsonb,
  email TEXT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  user_agent TEXT,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.constraint_column_usage
    WHERE table_name = 'onboarding_sessions'
      AND constraint_name = 'onboarding_sessions_status_check'
  ) THEN
    ALTER TABLE onboarding_sessions
      ADD CONSTRAINT onboarding_sessions_status_check
      CHECK (status IN ('in_progress', 'completed', 'abandoned'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_email
  ON onboarding_sessions (email);

CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_status_updated
  ON onboarding_sessions (status, updated_at);
