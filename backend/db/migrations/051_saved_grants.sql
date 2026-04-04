-- 051_saved_grants.sql
-- Backend-persisted saved/bookmarked grants per user
CREATE TABLE IF NOT EXISTS saved_grants (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opportunity_id TEXT NOT NULL,
  saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, opportunity_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_grants_user_id ON saved_grants(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_grants_opportunity_id ON saved_grants(opportunity_id);
