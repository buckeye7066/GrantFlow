-- 0074_sam_anya_onboarding_audit (Postgres)
--
-- Mirrors backend/db/migrations/078_sam_anya_onboarding_audit.sql for
-- Postgres. Uses JSONB and TIMESTAMPTZ. All idempotent.

CREATE TABLE IF NOT EXISTS anya_onboarding_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT,
  profile_id TEXT,
  branch TEXT,
  event_type TEXT NOT NULL,
  question_id TEXT,
  field_key TEXT,
  status TEXT,
  confidence DOUBLE PRECISION,
  details_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anya_onboarding_events_session ON anya_onboarding_events(session_id);
CREATE INDEX IF NOT EXISTS idx_anya_onboarding_events_user ON anya_onboarding_events(user_id);
CREATE INDEX IF NOT EXISTS idx_anya_onboarding_events_branch_created ON anya_onboarding_events(branch, created_at);
CREATE INDEX IF NOT EXISTS idx_anya_onboarding_events_event_type ON anya_onboarding_events(event_type);

CREATE TABLE IF NOT EXISTS anya_onboarding_audit_runs (
  id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ok',
  flow_version TEXT,
  branches_checked_json JSONB,
  coverage_json JSONB,
  findings_json JSONB,
  recommendations_json JSONB,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anya_audit_runs_completed ON anya_onboarding_audit_runs(completed_at);

CREATE TABLE IF NOT EXISTS anya_onboarding_audit_findings (
  id TEXT PRIMARY KEY,
  audit_run_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  branch TEXT,
  question_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  evidence_json JSONB,
  recommended_fix TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_audit_run FOREIGN KEY (audit_run_id)
    REFERENCES anya_onboarding_audit_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_anya_audit_findings_run ON anya_onboarding_audit_findings(audit_run_id);
CREATE INDEX IF NOT EXISTS idx_anya_audit_findings_status ON anya_onboarding_audit_findings(status);
CREATE INDEX IF NOT EXISTS idx_anya_audit_findings_severity ON anya_onboarding_audit_findings(severity);
