-- Hamilton auth backup plan: auto-retry login/2FA/captcha-blocked tasks instead
-- of dead-ending them. next_retry_at is when the periodic runner should re-attempt
-- a task sitting in waiting_for_login / waiting_for_2fa / waiting_for_captcha;
-- retry_count drives the exponential backoff. See hamiltonAuthBackupPlan.js.
ALTER TABLE application_tasks ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
ALTER TABLE application_tasks ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_application_tasks_next_retry
  ON application_tasks(next_retry_at)
  WHERE next_retry_at IS NOT NULL;
