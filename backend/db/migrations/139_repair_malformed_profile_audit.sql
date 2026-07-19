-- Round 32: FORWARD migration — apply the round-31 BROADENED malformed-profile audit to DBs
-- that already stamped an INTERMEDIATE 138 (the r30 LIKE-gated behavior), because the boot
-- runner selects migrations by FILENAME only (files.filter(f => !applied.has(f))), so the
-- in-place r30/r31 edits to 138 NEVER re-run on an already-138-stamped DB — a NULL-phone,
-- no-map user with a malformed basic_information whose corrupt text lacked the literal word
-- 'phone' (e.g. phone under a 'contact' key / numeric-only / uppercase 'PHONE') would stay
-- silently unflagged there.
--
-- Honors the r24 discipline: NEVER edit an applied migration to change data behavior — add a
-- forward one. This performs ONLY the broadened malformed-profile conflict insert (no text
-- heuristic, no LIKE; validity-guarded via json_valid so the INSERT never aborts on a
-- malformed row). IDEMPOTENT + safe after 138: the sentinel canonical id makes
-- ON CONFLICT (dup_user_id, canonical_user_id) DO NOTHING a no-double-flag guard, so a row
-- 138 already flagged is untouched and a fresh install (138 then 139) is a safe no-op. The
-- Postgres twin (0143) uses identical logic (pg_temp.pdedupe_is_json instead of json_valid).
CREATE TABLE IF NOT EXISTS phone_dedupe_conflicts (
  dup_user_id TEXT NOT NULL, canonical_user_id TEXT NOT NULL, phone TEXT, reason TEXT,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (dup_user_id, canonical_user_id)
);
CREATE TABLE IF NOT EXISTS phone_dedupe_map (
  dup_user_id TEXT NOT NULL, canonical_user_id TEXT NOT NULL, phone TEXT,
  PRIMARY KEY (dup_user_id, canonical_user_id)
);
INSERT INTO phone_dedupe_conflicts (dup_user_id, canonical_user_id, phone, reason)
SELECT DISTINCT p.user_id, '(unknown-malformed-profile)', NULL, 'pre-map-malformed-profile, manual review'
FROM profiles p
JOIN profile_sections ps ON ps.profile_id = p.id AND ps.section_key = 'basic_information'
WHERE p.user_id IS NOT NULL
  AND json_valid(ps.data) = 0
  AND (SELECT primary_phone FROM users WHERE id = p.user_id) IS NULL
  AND NOT EXISTS (SELECT 1 FROM phone_dedupe_map m WHERE m.dup_user_id = p.user_id)
ON CONFLICT (dup_user_id, canonical_user_id) DO NOTHING;
