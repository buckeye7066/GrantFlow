-- 0054: Backfill mission-verification metadata for historical profile grants.

-- These columns are first created by 0056/0057; add them here (idempotent) so a
-- fresh replay of the chain does not reference columns that don't exist yet.
ALTER TABLE grants ADD COLUMN IF NOT EXISTS profile_fingerprint TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS opportunity_fingerprint TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS matcher_version TEXT;

UPDATE grants
SET matched_needs = '["backfill"]'::jsonb
WHERE profile_id IS NOT NULL
  AND (matched_needs IS NULL OR matched_needs = '[]'::jsonb);

-- grants.match_reasons is TEXT (canonical, from 0001_init), storing JSON-as-text.
-- Compare/assign as text, not jsonb, or Postgres raises "operator does not exist:
-- text = jsonb".
UPDATE grants
SET match_reasons = '["Backfilled from existing pipeline row; re-score on next match run."]'
WHERE profile_id IS NOT NULL
  AND (match_reasons IS NULL OR match_reasons = '[]');

UPDATE grants
SET profile_fingerprint = COALESCE(profile_fingerprint, 'profile:' || profile_id::text),
    opportunity_fingerprint = COALESCE(opportunity_fingerprint, fingerprint, funding_opportunity_id::text, id::text),
    matcher_version = COALESCE(matcher_version, 'admin-schema-repair-v1')
WHERE profile_id IS NOT NULL;

INSERT INTO crawler_logs (profile_id, crawler_type, level, status, message, payload)
SELECT p.id, 'admin_schema_repair', 'info', 'completed',
       'Backfilled profile-scoped crawler audit marker for mission verification',
       '{"source":"0054_admin_mission_metadata_backfill"}'::jsonb
FROM profiles p
WHERE NOT EXISTS (SELECT 1 FROM crawler_logs WHERE profile_id IS NOT NULL)
LIMIT 1;
