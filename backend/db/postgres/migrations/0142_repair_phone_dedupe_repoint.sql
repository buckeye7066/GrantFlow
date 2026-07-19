-- Round 24: FORWARD repair migration (Postgres twin of sqlite 138_repair_phone_dedupe_repoint.sql).
-- 137/0141 were corrected in place in round 23, but the migration runner records
-- applied migrations by FILENAME and never re-runs a stamped file
-- (migrate.js: pending = files.filter(f => !applied.has(f))). So a DB that already
-- ran the round-22 age-based 137/0141 would NEVER get the credential-owned repair —
-- the stranded-credential 500 would persist there. THIS new forward migration
-- performs the repair, and additionally REPOINTS the duplicate users' account-level
-- ownership onto the canonical credential-owner so no data is stranded.
--
-- Idempotent + re-runnable. On a fresh install (corrected 137 already ran, no dups)
-- this is a safe no-op.
--
-- REPOINTED tables (rows OWNED by the user; keyed by user_id): profiles,
-- saved_grants, user_organizations, user_preferences, user_credentials,
-- user_providers, stripe_customers, service_purchases, student_portals,
-- application_portal_links, application_tasks, pricing_quotes, anya_sessions,
-- anya_runs, anya_onboarding_events. (Profile-SCOPED data keyed by profile_id
-- follows the repointed profile automatically.)
-- DELIBERATELY EXCLUDED: transient auth (user_sessions, password_setup_tokens — they
-- expire); pure actor/audit stamps (created_by / *_by_user_id / assigned_to_user_id /
-- reviewed_by / approved_by_user_id / actor_user_id / consumed_by_user_id) and agent
-- activity logs (hamilton_*, *_runs, agent_activity_events, anya_tool_usage) — these
-- record WHO performed an action, not user-owned data, so repointing would falsify
-- history.

-- Canonical map: dup_id -> canonical_id, for every user D that shares a phone with a
-- phone_otp credential owned by a DIFFERENT user C (C = canonical owner).
DROP TABLE IF EXISTS _phone_dedupe_map;
CREATE TEMP TABLE _phone_dedupe_map AS
SELECT d.id AS dup_id, uc.user_id AS canonical_id
FROM users d
JOIN user_credentials uc
  ON uc.type = 'phone_otp' AND uc.identifier = d.primary_phone
WHERE d.primary_phone IS NOT NULL AND uc.user_id <> d.id;

-- ---- Repoint account-level ownership (conflict-guarded where a per-user unique exists) ----
-- profiles: unique(user_id) — move only if the canonical owns no profile yet.
UPDATE profiles SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = profiles.user_id)
WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map)
  AND NOT EXISTS (SELECT 1 FROM profiles pc WHERE pc.user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = profiles.user_id));

-- saved_grants: unique(user_id, profile_id, opportunity_id).
UPDATE saved_grants SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = saved_grants.user_id)
WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map)
  AND NOT EXISTS (
    SELECT 1 FROM saved_grants sc
    WHERE sc.user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = saved_grants.user_id)
      AND COALESCE(sc.profile_id, '') = COALESCE(saved_grants.profile_id, '')
      AND sc.opportunity_id = saved_grants.opportunity_id
  );

-- user_organizations: PK(user_id, organization_id).
UPDATE user_organizations SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = user_organizations.user_id)
WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map)
  AND NOT EXISTS (
    SELECT 1 FROM user_organizations oc
    WHERE oc.user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = user_organizations.user_id)
      AND oc.organization_id = user_organizations.organization_id
  );

-- user_preferences: unique(user_id).
UPDATE user_preferences SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = user_preferences.user_id)
WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map)
  AND NOT EXISTS (SELECT 1 FROM user_preferences pc WHERE pc.user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = user_preferences.user_id));

-- stripe_customers: PK(user_id).
UPDATE stripe_customers SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = stripe_customers.user_id)
WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map)
  AND NOT EXISTS (SELECT 1 FROM stripe_customers sc WHERE sc.user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = stripe_customers.user_id));

-- Plain repoints (user_id has no per-user unique): move every owned row.
UPDATE user_credentials SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = user_credentials.user_id) WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map);
UPDATE user_providers SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = user_providers.user_id) WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map);
UPDATE service_purchases SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = service_purchases.user_id) WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map);
UPDATE student_portals SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = student_portals.user_id) WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map);
UPDATE application_portal_links SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = application_portal_links.user_id) WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map);
UPDATE application_tasks SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = application_tasks.user_id) WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map);
UPDATE pricing_quotes SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = pricing_quotes.user_id) WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map);
UPDATE anya_sessions SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = anya_sessions.user_id) WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map);
UPDATE anya_runs SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = anya_runs.user_id) WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map);
UPDATE anya_onboarding_events SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = anya_onboarding_events.user_id) WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map);

DROP TABLE IF EXISTS _phone_dedupe_map;

-- ---- Keep the phone on the credential-owned user (same repair as corrected 137) ----
-- Step 1: null primary_phone on every user that is NOT the canonical owner of its phone.
UPDATE users
SET primary_phone = NULL
WHERE primary_phone IS NOT NULL
  AND id <> COALESCE(
    (SELECT uc.user_id FROM user_credentials uc WHERE uc.type = 'phone_otp' AND uc.identifier = users.primary_phone LIMIT 1),
    (SELECT u2.id FROM users u2 WHERE u2.primary_phone = users.primary_phone ORDER BY u2.created_at ASC, u2.id ASC LIMIT 1)
  );

-- Step 2: restore the phone on a credential-owned user that lost it (only when free).
UPDATE users
SET primary_phone = (SELECT uc.identifier FROM user_credentials uc WHERE uc.type = 'phone_otp' AND uc.user_id = users.id LIMIT 1)
WHERE primary_phone IS NULL
  AND EXISTS (SELECT 1 FROM user_credentials uc2 WHERE uc2.type = 'phone_otp' AND uc2.user_id = users.id)
  AND NOT EXISTS (
    SELECT 1 FROM users u3
    WHERE u3.id <> users.id
      AND u3.primary_phone IS NOT NULL
      AND u3.primary_phone = (SELECT uc3.identifier FROM user_credentials uc3 WHERE uc3.type = 'phone_otp' AND uc3.user_id = users.id LIMIT 1)
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_primary_phone
  ON users (primary_phone)
  WHERE primary_phone IS NOT NULL;
