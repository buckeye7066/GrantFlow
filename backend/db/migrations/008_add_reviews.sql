CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  reviewer_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('accept','reject','correct','escalate')),
  prior_value TEXT,
  new_value TEXT,
  reason_code TEXT NOT NULL,
  evidence_url TEXT NOT NULL,
  confidence REAL,
  metadata TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reviews_item_id ON reviews(item_id);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewer_user_id ON reviews(reviewer_user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_created_at ON reviews(created_at);
