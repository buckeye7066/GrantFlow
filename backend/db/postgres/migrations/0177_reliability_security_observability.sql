-- Slice 10: make cross-instance API rate limiting a migrated, inspectable
-- schema contract. Request middleware must never create this table ad hoc.

CREATE TABLE IF NOT EXISTS api_rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  window_started_ms BIGINT NOT NULL,
  expires_ms BIGINT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0 CHECK (hit_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_api_rate_limit_buckets_expiry
  ON api_rate_limit_buckets(expires_ms);
