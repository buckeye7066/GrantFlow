-- Round 24/25/26/27: FORWARD repair migration (Postgres twin of sqlite 138_repair_phone_dedupe_repoint.sql).
--
-- Runs AFTER 137 (which captures the dup->canonical identity into phone_dedupe_map
-- BEFORE nulling the duplicates' primary_phone). Re-applies the credential-owned phone
-- fix + index itself so it also repairs already-stamped DBs. Idempotent + fresh no-op.
--
-- CORE INVARIANT: NO row may have user_id and profile_id / stripe_customer_id pointing
-- at different accounts. Duplicates are reconciled PER CANONICAL PHONE GROUP (canonical
-- + ALL its dups together), all-or-nothing:
--   * MERGEABLE group (across the WHOLE group at most ONE member owns each 1-per-user
--     resource -- profile / stripe_customer / user_preferences): MOVE every dup's owned
--     rows to the canonical; REVOKE security-sensitive session/auth/payment/credential
--     rows; COLLAPSE group-wide duplicate rows on any legacy unique BEFORE the move so a
--     dup-vs-dup collision can never abort the migration (Codex r27 #1).
--   * UNMERGEABLE group: move NOTHING; record every dup in phone_dedupe_conflicts.
--
-- Two-owner tables are enumerated from the FULL migrated schema and each is classified
-- MOVE / REVOKE / EXEMPT (audit); a by-construction invariant test introspects the live
-- schema and fails on any unclassified two-owner table (Codex r27 #3).
--
-- Pre-map (52caf99-137-stamped) DBs whose dup phone was nulled before the map existed
-- are reconstructed from a durable trace (the dup profile's basic_information phone);
-- what cannot be reconstructed is recorded as an operator-visible conflict, never a
-- silent no-op (Codex r27 #2).
CREATE TABLE IF NOT EXISTS phone_dedupe_conflicts (
  dup_user_id TEXT NOT NULL, canonical_user_id TEXT NOT NULL, phone TEXT, reason TEXT,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (dup_user_id, canonical_user_id)
);
CREATE TABLE IF NOT EXISTS phone_dedupe_map (
  dup_user_id TEXT NOT NULL, canonical_user_id TEXT NOT NULL, phone TEXT,
  PRIMARY KEY (dup_user_id, canonical_user_id)
);
-- Belt-and-suspenders live capture (idempotent): any dup still holding its phone.
INSERT INTO phone_dedupe_map (dup_user_id, canonical_user_id, phone)
SELECT d.id, uc.user_id, d.primary_phone
FROM users d JOIN user_credentials uc ON uc.type = 'phone_otp' AND uc.identifier = d.primary_phone
WHERE d.primary_phone IS NOT NULL AND uc.user_id <> d.id
ON CONFLICT (dup_user_id, canonical_user_id) DO NOTHING;

-- Pre-map reconstruction (Postgres): a nulled dup whose profile still records the phone.
INSERT INTO phone_dedupe_map (dup_user_id, canonical_user_id, phone)
SELECT DISTINCT p.user_id, uc.user_id, uc.identifier
FROM profiles p
JOIN profile_sections ps ON ps.profile_id = p.id AND ps.section_key = 'basic_information'
JOIN user_credentials uc ON uc.type = 'phone_otp' AND (ps.data::jsonb->>'phone') = uc.identifier
WHERE p.user_id IS NOT NULL AND uc.user_id <> p.user_id
  AND (SELECT primary_phone FROM users WHERE id = p.user_id) IS NULL
ON CONFLICT (dup_user_id, canonical_user_id) DO NOTHING;

DROP TABLE IF EXISTS _members;
CREATE TEMP TABLE _members AS
  SELECT DISTINCT canonical_user_id AS canonical_id, canonical_user_id AS member_id FROM phone_dedupe_map
  UNION
  SELECT canonical_user_id, dup_user_id FROM phone_dedupe_map;

-- PER-GROUP mergeability: across the WHOLE group at most ONE member owns each 1-per-user resource.
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
WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = m.dup_user_id)
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = m.canonical_user_id);

INSERT INTO phone_dedupe_conflicts (dup_user_id, canonical_user_id, phone, reason)
SELECT dup_id, canonical_id, phone, 'group_over_owns_1_per_user_resource'
FROM _merge WHERE mergeable = 0
ON CONFLICT (dup_user_id, canonical_user_id) DO NOTHING;

-- GROUP-WIDE COLLISION-COLLAPSE (incl. dup-vs-dup) so a move never aborts on a legacy unique.
DELETE FROM saved_grants
WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1) AND saved_grants.profile_id IS NULL
  AND EXISTS (
    SELECT 1 FROM saved_grants keep
    JOIN _members km ON km.member_id = keep.user_id AND km.canonical_id = (SELECT canonical_id FROM _merge WHERE dup_id = saved_grants.user_id)
    WHERE keep.profile_id IS NULL AND keep.opportunity_id = saved_grants.opportunity_id
      AND keep.id <> saved_grants.id AND (keep.user_id = (SELECT canonical_id FROM _merge WHERE dup_id = saved_grants.user_id) OR keep.user_id < saved_grants.user_id)
  );
DELETE FROM saved_grants
WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1) AND saved_grants.profile_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM saved_grants keep
    JOIN _members km ON km.member_id = keep.user_id AND km.canonical_id = (SELECT canonical_id FROM _merge WHERE dup_id = saved_grants.user_id)
    WHERE keep.profile_id = saved_grants.profile_id AND keep.opportunity_id = saved_grants.opportunity_id
      AND keep.id <> saved_grants.id AND (keep.user_id = (SELECT canonical_id FROM _merge WHERE dup_id = saved_grants.user_id) OR keep.user_id < saved_grants.user_id)
  );
DELETE FROM user_organizations
WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1)
  AND EXISTS (
    SELECT 1 FROM user_organizations keep
    JOIN _members km ON km.member_id = keep.user_id AND km.canonical_id = (SELECT canonical_id FROM _merge WHERE dup_id = user_organizations.user_id)
    WHERE keep.organization_id = user_organizations.organization_id AND keep.user_id <> user_organizations.user_id
      AND (keep.user_id = (SELECT canonical_id FROM _merge WHERE dup_id = user_organizations.user_id) OR keep.user_id < user_organizations.user_id)
  );

-- MOVE every owned row of each mergeable dup to its canonical.
UPDATE profiles SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = profiles.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE user_preferences SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = user_preferences.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE stripe_customers SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = stripe_customers.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE user_providers SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = user_providers.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE user_credentials SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = user_credentials.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE saved_grants SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = saved_grants.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE anya_sessions SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = anya_sessions.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE anya_runs SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = anya_runs.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE anya_tool_usage SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = anya_tool_usage.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE anya_onboarding_events SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = anya_onboarding_events.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE anya_match_suggestions SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = anya_match_suggestions.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE service_purchases SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = service_purchases.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE pricing_quotes SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = pricing_quotes.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE profile_pricing SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = profile_pricing.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE service_agreements SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = service_agreements.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE admin_pricing_notifications SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = admin_pricing_notifications.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE onboarding_sessions SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = onboarding_sessions.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE grant_applications SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = grant_applications.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE student_portals SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = student_portals.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE application_portal_links SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = application_portal_links.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE application_tasks SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = application_tasks.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE hamilton_runs SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = hamilton_runs.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE hamilton_autopilot_runs SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = hamilton_autopilot_runs.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE hamilton_blockers SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = hamilton_blockers.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE hamilton_resolved_fields SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = hamilton_resolved_fields.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE yana_runs SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = yana_runs.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE yana_autopilot_runs SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = yana_autopilot_runs.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE yana_blockers SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = yana_blockers.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE yana_resolved_fields SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = yana_resolved_fields.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE user_organizations SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = user_organizations.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);

-- REVOKE (never transfer) security-sensitive session/authorization/payment/credential state.
DELETE FROM user_sessions WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
DELETE FROM hamilton_authorizations WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
DELETE FROM hamilton_saved_sessions WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
DELETE FROM hamilton_payment_authorizations WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
DELETE FROM hamilton_attestation_authorizations WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
DELETE FROM hamilton_portal_credentials WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
DELETE FROM hamilton_session_capture_requests WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
DELETE FROM yana_authorizations WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
DELETE FROM yana_saved_sessions WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
DELETE FROM yana_payment_authorizations WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
DELETE FROM yana_attestation_authorizations WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
DELETE FROM payment_access_events WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);

DROP TABLE IF EXISTS _members;
DROP TABLE IF EXISTS _group;
DROP TABLE IF EXISTS _merge;

-- Keep the phone on the credential-owned user (idempotent; also repairs a stamped DB).
UPDATE users
SET primary_phone = NULL
WHERE primary_phone IS NOT NULL
  AND id <> COALESCE(
    (SELECT uc.user_id FROM user_credentials uc WHERE uc.type = 'phone_otp' AND uc.identifier = users.primary_phone LIMIT 1),
    (SELECT u2.id FROM users u2 WHERE u2.primary_phone = users.primary_phone ORDER BY u2.created_at ASC, u2.id ASC LIMIT 1)
  );
UPDATE users
SET primary_phone = (SELECT uc.identifier FROM user_credentials uc WHERE uc.type = 'phone_otp' AND uc.user_id = users.id LIMIT 1)
WHERE primary_phone IS NULL
  AND EXISTS (SELECT 1 FROM user_credentials uc2 WHERE uc2.type = 'phone_otp' AND uc2.user_id = users.id)
  AND NOT EXISTS (
    SELECT 1 FROM users u3
    WHERE u3.id <> users.id AND u3.primary_phone IS NOT NULL
      AND u3.primary_phone = (SELECT uc3.identifier FROM user_credentials uc3 WHERE uc3.type = 'phone_otp' AND uc3.user_id = users.id LIMIT 1)
  );
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_primary_phone ON users (primary_phone) WHERE primary_phone IS NOT NULL;
