-- Round 32: FORWARD migration (Postgres twin of sqlite 149_repair_malformed_profile_audit.sql).
-- Applies the round-31 BROADENED malformed-profile audit to DBs that already stamped an
-- INTERMEDIATE 0152 (the r30 LIKE-gated behavior), because the boot runner selects migrations
-- by FILENAME only, so the in-place r30/r31 edits to 0152 NEVER re-run on an already-0152-
-- stamped DB — a NULL-phone, no-map user with a malformed basic_information whose corrupt text
-- lacked the literal word 'phone' (phone under a 'contact' key / numeric-only / uppercase
-- 'PHONE', which PG's case-SENSITIVE LIKE also missed) would stay silently unflagged there.
--
-- Honors the r24 discipline: NEVER edit an applied migration to change data behavior — add a
-- forward one. Performs ONLY the broadened malformed-profile conflict insert (no text
-- heuristic, no LIKE; validity-guarded so the INSERT never aborts on a malformed row).
-- IDEMPOTENT + safe after 0152: the sentinel canonical id makes ON CONFLICT DO NOTHING a
-- no-double-flag guard, so a row 0152 already flagged is untouched and a fresh install (0152
-- then 0153) is a safe no-op. Identical logic to sqlite 149 (pg_temp.pdedupe_is_json vs json_valid).
CREATE TABLE IF NOT EXISTS phone_dedupe_conflicts (
  dup_user_id TEXT NOT NULL, canonical_user_id TEXT NOT NULL, phone TEXT, reason TEXT,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (dup_user_id, canonical_user_id)
);
CREATE TABLE IF NOT EXISTS phone_dedupe_map (
  dup_user_id TEXT NOT NULL, canonical_user_id TEXT NOT NULL, phone TEXT,
  PRIMARY KEY (dup_user_id, canonical_user_id)
);
-- SAFE JSON validity helper: true iff the text parses as JSON. pg_temp functions are
-- session-scoped, so this migration (a separate session from 0152) defines its own.
CREATE OR REPLACE FUNCTION pg_temp.pdedupe_is_json(t text) RETURNS boolean AS $pdedupe$
BEGIN
  PERFORM t::jsonb;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$pdedupe$ LANGUAGE plpgsql IMMUTABLE;

INSERT INTO phone_dedupe_conflicts (dup_user_id, canonical_user_id, phone, reason)
SELECT DISTINCT p.user_id, '(unknown-malformed-profile)', NULL, 'pre-map-malformed-profile, manual review'
FROM profiles p
JOIN profile_sections ps ON ps.profile_id = p.id AND ps.section_key = 'basic_information'
WHERE p.user_id IS NOT NULL
  AND pg_temp.pdedupe_is_json(ps.data) = false
  AND (SELECT primary_phone FROM users WHERE id = p.user_id) IS NULL
  AND NOT EXISTS (SELECT 1 FROM phone_dedupe_map m WHERE m.dup_user_id = p.user_id)
ON CONFLICT (dup_user_id, canonical_user_id) DO NOTHING;
