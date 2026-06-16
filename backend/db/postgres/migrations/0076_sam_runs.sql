-- 0076_sam_runs.sql
--
-- Postgres counterpart to 080_sam_runs.sql for Sam, GrantFlow's
-- production-readiness agent. See that file for design notes.
-- Idempotent: IF NOT EXISTS on every object.

CREATE TABLE IF NOT EXISTS sam_runs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  mode TEXT NOT NULL DEFAULT 'observe'
    CHECK(mode IN ('observe','advise','repair-safe','gatekeeper')),
  trigger TEXT NOT NULL DEFAULT 'manual'
    CHECK(trigger IN ('manual','scheduled','startup','admin-ui','api')),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK(status IN ('running','completed','failed','cancelled')),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  health_score DOUBLE PRECISION,
  production_ready BOOLEAN,
  summary_json JSONB DEFAULT '{}'::jsonb,
  findings_json JSONB DEFAULT '[]'::jsonb,
  repair_plan_json JSONB DEFAULT '[]'::jsonb,
  applied_fixes_json JSONB DEFAULT '[]'::jsonb,
  error TEXT,
  created_by_user_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_sam_runs_started_at ON sam_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sam_runs_status     ON sam_runs(status);
CREATE INDEX IF NOT EXISTS idx_sam_runs_mode       ON sam_runs(mode);
CREATE INDEX IF NOT EXISTS idx_sam_runs_user       ON sam_runs(created_by_user_id);
