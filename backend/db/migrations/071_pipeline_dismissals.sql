-- Pipeline dismissals (sticky deletes).
--
-- When a user deletes a funding source from a profile's pipeline, we record
-- a tombstone so the matcher / Process All / re-crawl loop cannot resurrect
-- the same opportunity for that profile. Without this, the auto-add path
-- (opportunityMatcher.saveToProfilePipeline) re-inserts the row the very
-- next time it runs because the "already in pipeline" idempotency check
-- only looks at the live grants table.
--
-- Match keys (any of these can hit):
--   1. fingerprint    canonical (title|funder|deadline|url) sha256
--   2. opportunity_id when the source row in funding_opportunities still exists
--   3. (title, source_url) lower(trim) fallback for legacy / synthetic sources
--
-- Manual re-add (POST /api/grants/from-opportunity) clears the matching
-- tombstone for that profile so users can deliberately bring a source back.

CREATE TABLE IF NOT EXISTS pipeline_dismissals (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  fingerprint TEXT,
  opportunity_id TEXT,
  source_url TEXT,
  title TEXT,
  reason TEXT,
  dismissed_by TEXT,
  dismissed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pipeline_dismissals_profile
  ON pipeline_dismissals(profile_id);

CREATE INDEX IF NOT EXISTS idx_pipeline_dismissals_fingerprint
  ON pipeline_dismissals(profile_id, fingerprint);

CREATE INDEX IF NOT EXISTS idx_pipeline_dismissals_opp
  ON pipeline_dismissals(profile_id, opportunity_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_dismissals_unique_fp
  ON pipeline_dismissals(profile_id, fingerprint)
  WHERE fingerprint IS NOT NULL;
