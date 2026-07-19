-- Round 24/25/26: FORWARD repair migration for phone-duplicate accounts.
--
-- Runs AFTER 137 (which captures the dup->canonical identity into phone_dedupe_map
-- BEFORE nulling the duplicates' primary_phone, so this repair is not a no-op even
-- though the identifying phone is gone by the time we run -- Codex r26 #1). This
-- migration ALSO re-applies the credential-owned phone fix + unique index at the end
-- so it repairs already-stamped DBs whose 137 ran the old age-based de-dup.
--
-- CORE INVARIANT: after this runs, NO row may have user_id and profile_id /
-- stripe_customer_id pointing at different accounts. Each duplicate is moved as an
-- ALL-OR-NOTHING unit:
--   * MERGEABLE dup (canonical + dup do NOT both own a 1-per-user resource -- profile
--     / stripe_customer / user_preferences): MOVE every owned row to the canonical
--     (the profile moves too, so every ownership FK stays aligned); REVOKE (delete)
--     security-sensitive session/authorization/payment rows rather than transfer
--     them; COLLAPSE truly-redundant rows first so a legacy unique index can never
--     abort the migration (Codex r26 #2).
--   * UNMERGEABLE dup: move NOTHING (stays fully self-consistent), lose only phone
--     login, and record the conflict in phone_dedupe_conflicts for manual owner
--     reconciliation.
--
-- Two-owner-FK tables (user_id + profile_id / stripe_customer_id) are ALL handled so
-- none is left split (Codex r26 #3 + the by-construction invariant test). The full
-- two-owner inventory (20 profile + 1 stripe) and its handling:
--   MOVED  : profiles, saved_grants, user_preferences, stripe_customers, user_providers,
--            user_credentials, service_purchases, student_portals, application_portal_links,
--            application_tasks, pricing_quotes, anya_sessions, anya_runs, anya_tool_usage,
--            anya_onboarding_events, agent_activity_events, hamilton_runs,
--            hamilton_autopilot_runs, hamilton_blockers, hamilton_resolved_fields,
--            user_organizations.
--   REVOKED: user_sessions, hamilton_authorizations, hamilton_saved_sessions,
--            hamilton_payment_authorizations, hamilton_attestation_authorizations.
--
-- Idempotent + re-runnable (moves no-op once done; conflict/map inserts guarded).
-- Fresh install (no dups) is a safe no-op.
CREATE TABLE IF NOT EXISTS phone_dedupe_conflicts (
  dup_user_id TEXT NOT NULL,
  canonical_user_id TEXT NOT NULL,
  phone TEXT,
  reason TEXT,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (dup_user_id, canonical_user_id)
);

CREATE TABLE IF NOT EXISTS phone_dedupe_map (
  dup_user_id TEXT NOT NULL,
  canonical_user_id TEXT NOT NULL,
  phone TEXT,
  PRIMARY KEY (dup_user_id, canonical_user_id)
);
-- Belt-and-suspenders live capture (idempotent): catch any dup still holding its phone
-- (e.g. an already-stamped DB whose old 137 did not capture the map).
INSERT INTO phone_dedupe_map (dup_user_id, canonical_user_id, phone)
SELECT d.id, uc.user_id, d.primary_phone
FROM users d
JOIN user_credentials uc ON uc.type = 'phone_otp' AND uc.identifier = d.primary_phone
WHERE d.primary_phone IS NOT NULL AND uc.user_id <> d.id
ON CONFLICT (dup_user_id, canonical_user_id) DO NOTHING;

DROP TABLE IF EXISTS _merge;
CREATE TEMP TABLE _merge AS
SELECT m.dup_user_id AS dup_id, m.canonical_user_id AS canonical_id, m.phone AS phone,
  CASE WHEN
        NOT (EXISTS (SELECT 1 FROM profiles         WHERE user_id = m.canonical_user_id) AND EXISTS (SELECT 1 FROM profiles         WHERE user_id = m.dup_user_id))
    AND NOT (EXISTS (SELECT 1 FROM stripe_customers WHERE user_id = m.canonical_user_id) AND EXISTS (SELECT 1 FROM stripe_customers WHERE user_id = m.dup_user_id))
    AND NOT (EXISTS (SELECT 1 FROM user_preferences WHERE user_id = m.canonical_user_id) AND EXISTS (SELECT 1 FROM user_preferences WHERE user_id = m.dup_user_id))
  THEN 1 ELSE 0 END AS mergeable
FROM phone_dedupe_map m
WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = m.dup_user_id)
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = m.canonical_user_id);

INSERT INTO phone_dedupe_conflicts (dup_user_id, canonical_user_id, phone, reason)
SELECT dup_id, canonical_id, phone, 'both_own_1_per_user_resource'
FROM _merge WHERE mergeable = 0
ON CONFLICT (dup_user_id, canonical_user_id) DO NOTHING;

-- COLLISION-COLLAPSE (mergeable dups) so a blind UPDATE never aborts on a legacy unique.
DELETE FROM saved_grants
WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1) AND profile_id IS NULL
  AND EXISTS (SELECT 1 FROM saved_grants sc WHERE sc.user_id = (SELECT canonical_id FROM _merge WHERE dup_id = saved_grants.user_id) AND sc.profile_id IS NULL AND sc.opportunity_id = saved_grants.opportunity_id);
DELETE FROM saved_grants
WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1) AND profile_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM saved_grants sc WHERE sc.user_id = (SELECT canonical_id FROM _merge WHERE dup_id = saved_grants.user_id) AND sc.profile_id = saved_grants.profile_id AND sc.opportunity_id = saved_grants.opportunity_id);
DELETE FROM user_organizations
WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1)
  AND EXISTS (SELECT 1 FROM user_organizations oc WHERE oc.user_id = (SELECT canonical_id FROM _merge WHERE dup_id = user_organizations.user_id) AND oc.organization_id = user_organizations.organization_id);

-- MOVE every owned row of each mergeable dup to its canonical.
UPDATE profiles SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = profiles.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE saved_grants SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = saved_grants.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE user_preferences SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = user_preferences.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE stripe_customers SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = stripe_customers.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE user_providers SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = user_providers.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE user_credentials SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = user_credentials.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE service_purchases SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = service_purchases.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE student_portals SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = student_portals.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE application_portal_links SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = application_portal_links.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE application_tasks SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = application_tasks.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE pricing_quotes SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = pricing_quotes.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE anya_sessions SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = anya_sessions.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE anya_runs SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = anya_runs.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE anya_tool_usage SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = anya_tool_usage.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE anya_onboarding_events SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = anya_onboarding_events.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE agent_activity_events SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = agent_activity_events.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE hamilton_runs SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = hamilton_runs.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE hamilton_autopilot_runs SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = hamilton_autopilot_runs.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE hamilton_blockers SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = hamilton_blockers.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE hamilton_resolved_fields SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = hamilton_resolved_fields.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
UPDATE user_organizations SET user_id = (SELECT canonical_id FROM _merge WHERE dup_id = user_organizations.user_id) WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);

-- REVOKE (never transfer) security-sensitive session/authorization/payment state.
DELETE FROM user_sessions WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
DELETE FROM hamilton_authorizations WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
DELETE FROM hamilton_saved_sessions WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
DELETE FROM hamilton_payment_authorizations WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);
DELETE FROM hamilton_attestation_authorizations WHERE user_id IN (SELECT dup_id FROM _merge WHERE mergeable = 1);

DROP TABLE IF EXISTS _merge;

-- Keep the phone on the credential-owned user (idempotent; also repairs an
-- already-stamped DB whose 137 ran the old age-based de-dup). Step 1: null the phone
-- on every user that is NOT the canonical owner of its phone.
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
