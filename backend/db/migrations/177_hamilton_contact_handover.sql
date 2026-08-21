-- PHASE 2 of the two-phase Hamilton portal identity policy
-- (backend/config/hamiltonIdentity.js). Under full automation Hamilton
-- REGISTERS a portal account with his own email + phone so the signup
-- verification code reaches somewhere he can read; once the account exists AND
-- an application has actually been submitted through it, the portal profile is
-- edited over to the APPLICANT'S real email/phone with Hamilton kept as the
-- SECONDARY contact so he retains submission access.
--
-- That debt is per-ACCOUNT, not per-task (one portal login serves many
-- applications), so it lives here beside the verification lifecycle it mirrors.
-- handover_status: 'pending' (owed) | 'blocked' (owed, with a stated reason it
-- cannot be prepared) | 'completed'. NULL means nothing is owed.
-- Owner order 2026-08-20.
ALTER TABLE hamilton_portal_credentials ADD COLUMN handover_status TEXT;
ALTER TABLE hamilton_portal_credentials ADD COLUMN handover_plan_json TEXT;
ALTER TABLE hamilton_portal_credentials ADD COLUMN handover_blocker TEXT;
ALTER TABLE hamilton_portal_credentials ADD COLUMN handover_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hamilton_portal_credentials ADD COLUMN handover_next_retry_at DATETIME;
ALTER TABLE hamilton_portal_credentials ADD COLUMN handover_completed_at DATETIME;
CREATE INDEX IF NOT EXISTS idx_hamilton_portal_cred_handover
  ON hamilton_portal_credentials (handover_status);
