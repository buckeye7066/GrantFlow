-- Round 24/25: FORWARD repair migration for ALREADY-STAMPED databases.
--
-- 137/0141 were corrected in place in round 23, but the migration runner records
-- applied migrations by FILENAME and never re-runs a stamped file
-- (migrate.js: pending = files.filter(f => !applied.has(f))). So a DB that already
-- ran the round-22 age-based 137/0141 would NEVER get the credential-owned repair.
-- THIS forward migration performs it, keeps the phone on the credential-owned user,
-- and reconciles the duplicate users' ownership WITHOUT ever splitting an account.
--
-- CORE INVARIANT (round 25): after this runs, NO row may have user_id and
-- profile_id / stripe_customer_id pointing at different accounts. We therefore move
-- each duplicate as an ALL-OR-NOTHING unit:
--   * MERGEABLE dup (canonical + dup do NOT both own any 1-per-user resource —
--     profile, stripe_customer, user_preferences): move EVERY owned row to the
--     canonical. No collisions are possible (by definition of mergeable), so all
--     user_id / profile_id / stripe_customer_id references stay aligned under
--     canonical.
--   * UNMERGEABLE dup (both own a 1-per-user resource → a real merge is ambiguous):
--     move NOTHING. The duplicate stays FULLY self-consistent (every row still
--     points at it); it only loses phone login (the phone belongs to the canonical
--     via the credential), recoverable via its email/password. The conflict is
--     RECORDED in phone_dedupe_conflicts for manual owner reconciliation.
-- Either way there is never a half-merged / split account.
--
-- Idempotent + re-runnable. Fresh install (no dups) is a safe no-op.
--
-- MOVED for a mergeable dup (user-owned rows): profiles, saved_grants,
-- user_organizations, user_preferences, stripe_customers, user_credentials,
-- user_providers, service_purchases, student_portals, application_portal_links,
-- application_tasks, pricing_quotes, anya_sessions, anya_runs, anya_onboarding_events.
-- Profile-SCOPED rows (keyed by profile_id) follow the moved profile automatically.
-- EXCLUDED (documented): transient auth (user_sessions, password_setup_tokens — they
-- expire) and pure actor/audit stamps + agent-run logs (created_by / *_by_user_id /
-- assigned_to_user_id / reviewed_by / approved_by_user_id / actor_user_id /
-- consumed_by_user_id / hamilton_* / *_runs / agent_activity_events / anya_tool_usage
-- / anya_brain_memory.scope_id) — these record WHO acted, not user-owned data.

-- Record for the owner to manually reconcile genuinely-unmergeable duplicates.
CREATE TABLE IF NOT EXISTS phone_dedupe_conflicts (
  dup_user_id TEXT NOT NULL,
  canonical_user_id TEXT NOT NULL,
  phone TEXT,
  reason TEXT,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (dup_user_id, canonical_user_id)
);

-- Canonical map: dup_id -> canonical_id + a MERGEABLE flag (canonical and dup do NOT
-- both own the same 1-per-user resource). A dup D shares a phone with a phone_otp
-- credential owned by a DIFFERENT user C (= canonical).
DROP TABLE IF EXISTS _phone_dedupe_map;
CREATE TEMP TABLE _phone_dedupe_map AS
SELECT d.id AS dup_id, uc.user_id AS canonical_id,
  CASE WHEN
        NOT (EXISTS (SELECT 1 FROM profiles         WHERE user_id = uc.user_id) AND EXISTS (SELECT 1 FROM profiles         WHERE user_id = d.id))
    AND NOT (EXISTS (SELECT 1 FROM stripe_customers WHERE user_id = uc.user_id) AND EXISTS (SELECT 1 FROM stripe_customers WHERE user_id = d.id))
    AND NOT (EXISTS (SELECT 1 FROM user_preferences WHERE user_id = uc.user_id) AND EXISTS (SELECT 1 FROM user_preferences WHERE user_id = d.id))
  THEN 1 ELSE 0 END AS mergeable
FROM users d
JOIN user_credentials uc
  ON uc.type = 'phone_otp' AND uc.identifier = d.primary_phone
WHERE d.primary_phone IS NOT NULL AND uc.user_id <> d.id;

-- Record the UNMERGEABLE conflicts (those duplicates are left fully intact).
INSERT INTO phone_dedupe_conflicts (dup_user_id, canonical_user_id, phone, reason)
SELECT m.dup_id, m.canonical_id, d.primary_phone, 'both_own_1_per_user_resource'
FROM _phone_dedupe_map m
JOIN users d ON d.id = m.dup_id
WHERE m.mergeable = 0
ON CONFLICT (dup_user_id, canonical_user_id) DO NOTHING;

-- ---- Move EVERY owned row of each MERGEABLE dup to its canonical (no collisions) ----
UPDATE profiles                SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = profiles.user_id)                WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map WHERE mergeable = 1);
UPDATE saved_grants            SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = saved_grants.user_id)            WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map WHERE mergeable = 1);
UPDATE user_preferences        SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = user_preferences.user_id)        WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map WHERE mergeable = 1);
UPDATE stripe_customers        SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = stripe_customers.user_id)        WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map WHERE mergeable = 1);
UPDATE service_purchases       SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = service_purchases.user_id)       WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map WHERE mergeable = 1);
UPDATE user_providers          SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = user_providers.user_id)          WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map WHERE mergeable = 1);
UPDATE student_portals         SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = student_portals.user_id)         WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map WHERE mergeable = 1);
UPDATE application_portal_links SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = application_portal_links.user_id) WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map WHERE mergeable = 1);
UPDATE application_tasks        SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = application_tasks.user_id)        WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map WHERE mergeable = 1);
UPDATE pricing_quotes          SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = pricing_quotes.user_id)          WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map WHERE mergeable = 1);
UPDATE anya_sessions           SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = anya_sessions.user_id)           WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map WHERE mergeable = 1);
UPDATE anya_runs               SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = anya_runs.user_id)               WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map WHERE mergeable = 1);
UPDATE anya_onboarding_events  SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = anya_onboarding_events.user_id)  WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map WHERE mergeable = 1);

-- user_organizations (PK user_id,org): move only memberships the canonical lacks.
UPDATE user_organizations SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = user_organizations.user_id)
WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map WHERE mergeable = 1)
  AND NOT EXISTS (SELECT 1 FROM user_organizations oc WHERE oc.user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = user_organizations.user_id) AND oc.organization_id = user_organizations.organization_id);

-- user_credentials (UNIQUE type,identifier): move the dup's OTHER login methods,
-- skipping any that would collide with a credential the canonical already has.
UPDATE user_credentials SET user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = user_credentials.user_id)
WHERE user_id IN (SELECT dup_id FROM _phone_dedupe_map WHERE mergeable = 1)
  AND NOT EXISTS (SELECT 1 FROM user_credentials cc WHERE cc.type = user_credentials.type AND cc.identifier = user_credentials.identifier AND cc.user_id = (SELECT canonical_id FROM _phone_dedupe_map WHERE dup_id = user_credentials.user_id));

DROP TABLE IF EXISTS _phone_dedupe_map;

-- ---- Keep the phone on the credential-owned user (only the canonical retains it) ----
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
