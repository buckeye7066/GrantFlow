-- SQLite migration 006: Anya operational audit tables

CREATE TABLE IF NOT EXISTS anya_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed')),
  mode TEXT NOT NULL DEFAULT 'copilot' CHECK(mode IN ('copilot', 'admin_ops', 'code_advisor')),
  kind TEXT NOT NULL CHECK(kind IN ('assistant_message', 'tool_invoke')),
  session_id TEXT REFERENCES anya_sessions(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  tool_name TEXT,
  request_json TEXT DEFAULT '{}',
  response_json TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_anya_runs_session ON anya_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_anya_runs_user ON anya_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_anya_runs_status ON anya_runs(status);

CREATE TABLE IF NOT EXISTS anya_run_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  run_id TEXT NOT NULL REFERENCES anya_runs(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('debug', 'info', 'warn', 'error')),
  message TEXT NOT NULL,
  meta_json TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_anya_run_logs_run ON anya_run_logs(run_id);

