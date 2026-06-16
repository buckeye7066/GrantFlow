-- 078_sam_anya_onboarding_audit
--
-- Tables Sam uses to audit Anya's onboarding conversation:
--   * anya_onboarding_events         — per-question runtime telemetry (no
--                                      raw answer text; only structural
--                                      status + confidence)
--   * anya_onboarding_audit_runs     — one row per `runAudit()` invocation
--   * anya_onboarding_audit_findings — individual findings per run
--
-- All tables are idempotent (CREATE TABLE IF NOT EXISTS) and indexed on
-- the columns the orchestrator reads.

CREATE TABLE IF NOT EXISTS anya_onboarding_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT,
  profile_id TEXT,
  branch TEXT,
  event_type TEXT NOT NULL,         -- onboarding_started | branch_selected | question_asked | answer_received | field_extracted | field_confirmed | field_skipped | profile_created | readiness_score_updated | onboarding_completed
  question_id TEXT,
  field_key TEXT,
  status TEXT,                      -- answered | skipped | i_dont_know | error
  confidence REAL,
  details_json TEXT,                -- structured metadata only; never raw user text
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_anya_onboarding_events_session ON anya_onboarding_events(session_id);
CREATE INDEX IF NOT EXISTS idx_anya_onboarding_events_user ON anya_onboarding_events(user_id);
CREATE INDEX IF NOT EXISTS idx_anya_onboarding_events_branch_created ON anya_onboarding_events(branch, created_at);
CREATE INDEX IF NOT EXISTS idx_anya_onboarding_events_event_type ON anya_onboarding_events(event_type);

CREATE TABLE IF NOT EXISTS anya_onboarding_audit_runs (
  id TEXT PRIMARY KEY,
  started_at DATETIME NOT NULL,
  completed_at DATETIME,
  status TEXT NOT NULL DEFAULT 'ok',          -- ok | failed | aborted
  flow_version TEXT,
  branches_checked_json TEXT,
  coverage_json TEXT,
  findings_json TEXT,
  recommendations_json TEXT,
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_anya_audit_runs_completed ON anya_onboarding_audit_runs(completed_at);

CREATE TABLE IF NOT EXISTS anya_onboarding_audit_findings (
  id TEXT PRIMARY KEY,
  audit_run_id TEXT NOT NULL,
  severity TEXT NOT NULL,                     -- critical | high | medium | low | info
  category TEXT NOT NULL,
  branch TEXT,
  question_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  evidence_json TEXT,
  recommended_fix TEXT,
  status TEXT NOT NULL DEFAULT 'open',        -- open | resolved | ignored | superseded
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (audit_run_id) REFERENCES anya_onboarding_audit_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_anya_audit_findings_run ON anya_onboarding_audit_findings(audit_run_id);
CREATE INDEX IF NOT EXISTS idx_anya_audit_findings_status ON anya_onboarding_audit_findings(status);
CREATE INDEX IF NOT EXISTS idx_anya_audit_findings_severity ON anya_onboarding_audit_findings(severity);
