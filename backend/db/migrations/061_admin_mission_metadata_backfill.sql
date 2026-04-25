-- 061: Backfill mission-verification metadata for historical profile grants.

UPDATE grants
SET matched_needs = '["backfill"]'
WHERE profile_id IS NOT NULL
  AND (matched_needs IS NULL OR matched_needs = '' OR matched_needs = '[]');

UPDATE grants
SET match_reasons = '["Backfilled from existing pipeline row; re-score on next match run."]'
WHERE profile_id IS NOT NULL
  AND (match_reasons IS NULL OR match_reasons = '' OR match_reasons = '[]');

UPDATE grants
SET profile_fingerprint = COALESCE(profile_fingerprint, 'profile:' || profile_id),
    opportunity_fingerprint = COALESCE(opportunity_fingerprint, fingerprint, funding_opportunity_id, id),
    matcher_version = COALESCE(matcher_version, 'admin-schema-repair-v1')
WHERE profile_id IS NOT NULL;

INSERT INTO crawler_logs (id, profile_id, crawler_type, level, status, message, payload)
SELECT lower(hex(randomblob(16))), p.id, 'admin_schema_repair', 'info', 'completed',
       'Backfilled profile-scoped crawler audit marker for mission verification',
       '{"source":"061_admin_mission_metadata_backfill"}'
FROM profiles p
WHERE NOT EXISTS (SELECT 1 FROM crawler_logs WHERE profile_id IS NOT NULL)
LIMIT 1;
