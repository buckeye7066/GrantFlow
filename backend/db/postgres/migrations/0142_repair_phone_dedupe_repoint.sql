-- Round 24/25/26/27/28/29: FORWARD repair migration (Postgres twin of sqlite 138_repair_phone_dedupe_repoint.sql).
--
-- Runs AFTER 137 (which captures the dup->canonical identity into phone_dedupe_map
-- BEFORE nulling the duplicates' primary_phone). Re-applies the credential-owned phone
-- fix + index itself so it also repairs stamped DBs. Idempotent + fresh no-op.
--
-- CORE INVARIANT: NO row may have user_id and profile_id / stripe_customer_id pointing
-- at different accounts. Duplicates are reconciled PER CANONICAL PHONE GROUP, all-or-
-- nothing (MERGEABLE group -> MOVE user data + REVOKE security session/auth/payment/
-- credential state + COLLAPSE group-wide unique collisions before the move; UNMERGEABLE
-- group -> move NOTHING, record every dup).
--
-- Two-owner tables enumerated from the FULL migrated schema, each classified
-- MOVE / REVOKE / EXEMPT; existence-guarded on Postgres (renamed-away yana_* skipped).
--
-- PROVEN MAP ONLY: entries come from 137's pre-null capture or 138's live-capture of a
-- dup that STILL holds its phone. A coincidental profile-phone match is NEVER
-- auto-merged; such candidates are recorded as operator conflicts and moved by NOTHING.
--
-- SAFE JSON (round 29): profile_sections.data is unconstrained TEXT; a single malformed
-- row must never abort the migration. The detect read is guarded (json_valid on SQLite,
-- a NULL-on-invalid extractor on Postgres) so bad rows yield NULL/no-match, not an error.
CREATE TABLE IF NOT EXISTS phone_dedupe_conflicts (
  dup_user_id TEXT NOT NULL, canonical_user_id TEXT NOT NULL, phone TEXT, reason TEXT,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (dup_user_id, canonical_user_id)
);
CREATE TABLE IF NOT EXISTS phone_dedupe_map (
  dup_user_id TEXT NOT NULL, canonical_user_id TEXT NOT NULL, phone TEXT,
  PRIMARY KEY (dup_user_id, canonical_user_id)
);
-- Belt-and-suspenders live capture (idempotent, PROVEN): a dup still holding its phone.
INSERT INTO phone_dedupe_map (dup_user_id, canonical_user_id, phone)
SELECT d.id, uc.user_id, d.primary_phone
FROM users d JOIN user_credentials uc ON uc.type = 'phone_otp' AND uc.identifier = d.primary_phone
WHERE d.primary_phone IS NOT NULL AND uc.user_id <> d.id
ON CONFLICT (dup_user_id, canonical_user_id) DO NOTHING;

-- SAFE JSON helper (round 29): returns NULL instead of raising on malformed profile data.
CREATE OR REPLACE FUNCTION pg_temp.pdedupe_json_phone(t text) RETURNS text AS $pdedupe$
BEGIN
  RETURN (t::jsonb ->> 'phone');
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$pdedupe$ LANGUAGE plpgsql IMMUTABLE;

-- SAFE JSON validity helper (round 30): true iff the text parses as JSON. Used to tell a
-- MALFORMED profile row (surface for review) apart from a valid row with no phone key.
CREATE OR REPLACE FUNCTION pg_temp.pdedupe_is_json(t text) RETURNS boolean AS $pdedupe$
BEGIN
  PERFORM t::jsonb;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$pdedupe$ LANGUAGE plpgsql IMMUTABLE;

-- Pre-map candidate DETECTION (record-only, never merged; SAFE JSON): a profile-owning
-- user with no phone whose profile phone matches a DIFFERENT user's phone_otp credential.
-- Fail closed -> operator review. A malformed profile_sections.data row yields NULL (no match).
INSERT INTO phone_dedupe_conflicts (dup_user_id, canonical_user_id, phone, reason)
SELECT DISTINCT p.user_id, uc.user_id, uc.identifier, 'pre-map-unverified, manual review'
FROM profiles p
JOIN profile_sections ps ON ps.profile_id = p.id AND ps.section_key = 'basic_information'
JOIN user_credentials uc ON uc.type = 'phone_otp' AND pg_temp.pdedupe_json_phone(ps.data) = uc.identifier
WHERE p.user_id IS NOT NULL AND uc.user_id <> p.user_id
  AND (SELECT primary_phone FROM users WHERE id = p.user_id) IS NULL
  AND NOT EXISTS (SELECT 1 FROM phone_dedupe_map m WHERE m.dup_user_id = p.user_id)
ON CONFLICT (dup_user_id, canonical_user_id) DO NOTHING;

-- MALFORMED-PROFILE audit (round 30/31): FAIL-OPEN AND FLAGGED. Round-29 SAFE JSON turns an
-- unparseable basic_information into NULL, so the phone-equality detect above SILENTLY SKIPS
-- it — a nulled-phone potential-duplicate whose ONLY remaining phone evidence is a corrupt
-- profile row would be lost with no operator signal. Flag the CORRUPT EVIDENCE ITSELF: you
-- cannot reliably pattern-match structure inside JSON already declared malformed (the phone
-- may sit under any key / be numeric-only / use any case), so round 31 records EVERY malformed
-- basic_information on a NULL-phone, no-proven-map user (no text heuristic, no LIKE — which
-- also removes the SQLite/Postgres LIKE case-parity mismatch). Detect-only; nothing moved, no
-- auto-merge. Sentinel canonical id: the match is UNKNOWN (the JSON is unreadable).
INSERT INTO phone_dedupe_conflicts (dup_user_id, canonical_user_id, phone, reason)
SELECT DISTINCT p.user_id, '(unknown-malformed-profile)', NULL, 'pre-map-malformed-profile, manual review'
FROM profiles p
JOIN profile_sections ps ON ps.profile_id = p.id AND ps.section_key = 'basic_information'
WHERE p.user_id IS NOT NULL
  AND pg_temp.pdedupe_is_json(ps.data) = false
  AND (SELECT primary_phone FROM users WHERE id = p.user_id) IS NULL
  AND NOT EXISTS (SELECT 1 FROM phone_dedupe_map m WHERE m.dup_user_id = p.user_id)
ON CONFLICT (dup_user_id, canonical_user_id) DO NOTHING;

DROP TABLE IF EXISTS _members;
CREATE TEMP TABLE _members AS
  SELECT DISTINCT canonical_user_id AS canonical_id, canonical_user_id AS member_id FROM phone_dedupe_map
  UNION
  SELECT canonical_user_id, dup_user_id FROM phone_dedupe_map;

DROP TABLE IF EXISTS _group;
CREATE TEMP TABLE _group AS
SELECT g.canonical_id,
  CASE WHEN
        (SELECT COUNT(*) FROM _members mm JOIN profiles         r ON r.user_id = mm.member_id WHERE mm.canonical_id = g.canonical_id) <= 1
    AND (SELECT COUNT(*) FROM _members mm JOIN stripe_customers r ON r.user_id = mm.member_id WHERE mm.canonical_id = g.canonical_id) <= 1
    AND (SELECT COUNT(*) FROM _members mm JOIN user_preferences r ON r.user_id = mm.member_id WHERE mm.canonical_id = g.canonical_id) <= 1
  THEN 1 ELSE 0 END AS mergeable
FROM (SELECT DISTINCT canonical_id FROM _members) g;

DROP TABLE IF EXISTS _merge;
CREATE TEMP TABLE _merge AS
SELECT m.dup_user_id AS dup_id, m.canonical_user_id AS canonical_id, m.phone AS phone, grp.mergeable AS mergeable
FROM phone_dedupe_map m JOIN _group grp ON grp.canonical_id = m.canonical_user_id
WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = m.dup_user_id) AND EXISTS (SELECT 1 FROM users u WHERE u.id = m.canonical_user_id);

INSERT INTO phone_dedupe_conflicts (dup_user_id, canonical_user_id, phone, reason)
SELECT dup_id, canonical_id, phone, 'group_over_owns_1_per_user_resource'
FROM _merge WHERE mergeable = 0
ON CONFLICT (dup_user_id, canonical_user_id) DO NOTHING;

-- GROUP-WIDE COLLISION-COLLAPSE (incl. dup-vs-dup) so a move never aborts on a legacy unique.
DELETE FROM saved_grants
WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1) AND saved_grants.profile_id IS NULL
  AND EXISTS (SELECT 1 FROM saved_grants keep JOIN _members km ON km.member_id = keep.user_id AND km.canonical_id = (SELECT canonical_id FROM _merge WHERE dup_id = saved_grants.user_id)
    WHERE keep.profile_id IS NULL AND keep.opportunity_id = saved_grants.opportunity_id AND keep.id <> saved_grants.id AND (keep.user_id = (SELECT canonical_id FROM _merge WHERE dup_id = saved_grants.user_id) OR keep.user_id < saved_grants.user_id));
DELETE FROM saved_grants
WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1) AND saved_grants.profile_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM saved_grants keep JOIN _members km ON km.member_id = keep.user_id AND km.canonical_id = (SELECT canonical_id FROM _merge WHERE dup_id = saved_grants.user_id)
    WHERE keep.profile_id = saved_grants.profile_id AND keep.opportunity_id = saved_grants.opportunity_id AND keep.id <> saved_grants.id AND (keep.user_id = (SELECT canonical_id FROM _merge WHERE dup_id = saved_grants.user_id) OR keep.user_id < saved_grants.user_id));
DELETE FROM user_organizations
WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1)
  AND EXISTS (SELECT 1 FROM user_organizations keep JOIN _members km ON km.member_id = keep.user_id AND km.canonical_id = (SELECT canonical_id FROM _merge WHERE dup_id = user_organizations.user_id)
    WHERE keep.organization_id = user_organizations.organization_id AND keep.user_id <> user_organizations.user_id AND (keep.user_id = (SELECT canonical_id FROM _merge WHERE dup_id = user_organizations.user_id) OR keep.user_id < user_organizations.user_id));

-- MOVE (existence-guarded) then REVOKE — to_regclass skips a renamed-away/absent table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles', 'user_preferences', 'stripe_customers', 'user_providers', 'user_credentials', 'saved_grants', 'anya_sessions', 'anya_runs', 'anya_tool_usage', 'anya_onboarding_events', 'anya_match_suggestions', 'service_purchases', 'pricing_quotes', 'profile_pricing', 'service_agreements', 'admin_pricing_notifications', 'onboarding_sessions', 'grant_applications', 'student_portals', 'application_portal_links', 'application_tasks', 'hamilton_runs', 'hamilton_autopilot_runs', 'hamilton_blockers', 'hamilton_resolved_fields', 'user_organizations'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('UPDATE %I SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = %I.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1)', t, t);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['user_sessions', 'hamilton_authorizations', 'hamilton_saved_sessions', 'hamilton_payment_authorizations', 'hamilton_attestation_authorizations', 'hamilton_portal_credentials', 'hamilton_session_capture_requests', 'payment_access_events'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('DELETE FROM %I WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1)', t);
    END IF;
  END LOOP;
END $$;

DROP TABLE IF EXISTS _members;
DROP TABLE IF EXISTS _group;
DROP TABLE IF EXISTS _merge;

-- Keep the phone on the credential-owned user (idempotent; also repairs a stamped DB).
UPDATE users SET primary_phone = NULL
WHERE primary_phone IS NOT NULL
  AND id <> COALESCE(
    (SELECT uc.user_id FROM user_credentials uc WHERE uc.type = 'phone_otp' AND uc.identifier = users.primary_phone LIMIT 1),
    (SELECT u2.id FROM users u2 WHERE u2.primary_phone = users.primary_phone ORDER BY u2.created_at ASC, u2.id ASC LIMIT 1)
  );
UPDATE users SET primary_phone = (SELECT uc.identifier FROM user_credentials uc WHERE uc.type = 'phone_otp' AND uc.user_id = users.id LIMIT 1)
WHERE primary_phone IS NULL
  AND EXISTS (SELECT 1 FROM user_credentials uc2 WHERE uc2.type = 'phone_otp' AND uc2.user_id = users.id)
  AND NOT EXISTS (SELECT 1 FROM users u3 WHERE u3.id <> users.id AND u3.primary_phone IS NOT NULL
    AND u3.primary_phone = (SELECT uc3.identifier FROM user_credentials uc3 WHERE uc3.type = 'phone_otp' AND uc3.user_id = users.id LIMIT 1));
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_primary_phone ON users (primary_phone) WHERE primary_phone IS NOT NULL;
