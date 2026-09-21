-- PostgreSQL parity for SQLite migration 049 and the runtime notification writer.
-- Keep text JSON and integer read flags compatible with existing API queries.
-- Additive and idempotent: preserve tables already created by notificationService.

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,        -- 'deadline_approaching', 'grant_saved', etc.
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT,                 -- JSON blob with context (opportunity_id, days_remaining, etc.)
  read INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);

CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read);
