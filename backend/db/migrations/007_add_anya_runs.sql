-- Migration: Add anya_runs table for operational logging
-- Purpose: Track Anya autonomous operations with run_id, mode, and tool usage

-- Create anya_runs table for tracking autonomous operations
CREATE TABLE IF NOT EXISTS anya_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  
  -- Run context
  run_id TEXT NOT NULL,
  user_id TEXT,
  profile_id TEXT,
  
  -- Anya mode
  mode TEXT CHECK(mode IN ('copilot', 'admin_ops', 'code_advisor')) NOT NULL DEFAULT 'copilot',
  
  -- Operation details
  operation_type TEXT NOT NULL,
  status TEXT CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')) NOT NULL DEFAULT 'queued',
  
  -- Results
  tools_used TEXT, -- JSON array of tool names
  error_message TEXT,
  error_stack TEXT,
  
  -- Metadata
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  duration_ms INTEGER,
  
  -- Audit trail
  requested_by TEXT,
  authorized BOOLEAN DEFAULT FALSE,
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- Index for querying runs by user
CREATE INDEX IF NOT EXISTS idx_anya_runs_user_id ON anya_runs(user_id);

-- Index for querying runs by profile
CREATE INDEX IF NOT EXISTS idx_anya_runs_profile_id ON anya_runs(profile_id);

-- Index for querying runs by status
CREATE INDEX IF NOT EXISTS idx_anya_runs_status ON anya_runs(status, created_at);

-- Index for querying runs by mode
CREATE INDEX IF NOT EXISTS idx_anya_runs_mode ON anya_runs(mode, created_at);

-- Index for querying runs by run_id (for correlation)
CREATE INDEX IF NOT EXISTS idx_anya_runs_run_id ON anya_runs(run_id);
