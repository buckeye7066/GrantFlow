-- Repair environments where the saved_grants migration was marked applied but
-- the table is absent.
CREATE TABLE IF NOT EXISTS saved_grants (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opportunity_id TEXT NOT NULL,
  saved_at TIMESTAMPTZ DEFAULT now(),
  notes TEXT DEFAULT NULL,
  UNIQUE(user_id, opportunity_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_grants_user_id ON saved_grants(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_grants_opportunity_id ON saved_grants(opportunity_id);
