-- Migration 049: Add notifications table for in-app deadline and system notifications.

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
