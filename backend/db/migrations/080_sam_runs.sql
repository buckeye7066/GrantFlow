-- 080_sam_runs.sql
--
-- Persistent run history for Sam, GrantFlow's production-readiness agent.
-- Sam ORCHESTRATES existing Anya autonomous tooling (code crawl, function
-- tests, button tests, mission audit, codeGuard) and the project's release
-- gates. Each run records its mode, what was checked, the findings, the
-- repair plan, any safe fixes applied, and the resulting health score so
-- admins can audit Sam end-to-end.
--
-- This table is additive — it never replaces `audit_logs` (cross-cutting)
-- or `anya_runs` (per-tool invocation history). Sam writes a row here for
-- the orchestrating run and continues to use the existing tools so
-- per-tool history remains in `anya_runs` / `audit_logs`.
--
-- Idempotent: every CREATE uses IF NOT EXISTS so re-applying is safe.

CREATE TABLE IF NOT EXISTS sam_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  mode TEXT NOT NULL DEFAULT 'observe'
    CHECK(mode IN ('observe','advise','repair-safe','gatekeeper')),
  trigger TEXT NOT NULL DEFAULT 'manual'
    CHECK(trigger IN ('manual','scheduled','startup','admin-ui','api')),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK(status IN ('running','completed','failed','cancelled')),
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  health_score REAL,
  production_ready INTEGER,
  summary_json TEXT DEFAULT '{}',
  findings_json TEXT DEFAULT '[]',
  repair_plan_json TEXT DEFAULT '[]',
  applied_fixes_json TEXT DEFAULT '[]',
  error TEXT,
  created_by_user_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_sam_runs_started_at ON sam_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sam_runs_status     ON sam_runs(status);
CREATE INDEX IF NOT EXISTS idx_sam_runs_mode       ON sam_runs(mode);
CREATE INDEX IF NOT EXISTS idx_sam_runs_user       ON sam_runs(created_by_user_id);
