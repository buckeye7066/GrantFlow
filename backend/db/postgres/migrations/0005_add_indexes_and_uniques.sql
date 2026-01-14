-- Postgres migration 0005: Add indexes/uniques for common production access patterns
-- Deterministic: CREATE INDEX IF NOT EXISTS, partial uniques where applicable.

-- Opportunities: profile lookups + geography filters + recency
CREATE INDEX IF NOT EXISTS idx_opportunities_profile_id
  ON funding_opportunities(profile_id);

CREATE INDEX IF NOT EXISTS idx_opportunities_is_national_state_updated
  ON funding_opportunities(is_national, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_opportunities_updated_at
  ON funding_opportunities(updated_at DESC);

-- Jobs: status + recency
CREATE INDEX IF NOT EXISTS idx_crawler_jobs_status_created
  ON crawler_jobs(status, created_at DESC);

-- Crawl logs: status + recency
CREATE INDEX IF NOT EXISTS idx_crawl_logs_status_created
  ON crawl_logs(status, created_at DESC);

-- Users: email should be unique when set (supports login correctness)
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_primary_email
  ON users (LOWER(primary_email))
  WHERE primary_email IS NOT NULL AND LENGTH(TRIM(primary_email)) > 0;

