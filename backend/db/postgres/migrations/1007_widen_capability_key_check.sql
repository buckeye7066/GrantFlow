-- Postgres twin of 1007_widen_capability_key_check.sql (2026-09-15).
--
-- Same defect: `billing_addon_entitlements` and `billing_entitlement_events`
-- enumerated the THREE original capabilities in a CHECK, while the vocabulary
-- grew to ten — so `ADDON_CATALOG` advertised ten purchasable capabilities and
-- the database rejected seven of them.
--
-- Postgres CAN alter a constraint in place, so unlike the SQLite twin no table
-- is rebuilt. The constraint name is DISCOVERED rather than assumed: 1002
-- declared it inline, so its name is whatever Postgres generated, and a
-- hard-coded `..._capability_key_check` would fail on any database where that
-- differed. Dropping by discovery also makes this migration idempotent.
--
-- The enumeration is DUPLICATED vocabulary; the authority is
-- `shared/tierCatalog.js CAPABILITY_KEYS`, enforced at the application edge by
-- `assertCapabilityKey`. It is kept as defense-in-depth and pinned by
-- `backend/tests/capabilityKeySchemaDrift.test.js` so it cannot silently fall
-- behind the registry again.

DO $$
DECLARE
  target_table TEXT;
  con_name TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['billing_addon_entitlements', 'billing_entitlement_events']
  LOOP
    IF to_regclass(target_table) IS NULL THEN
      CONTINUE;
    END IF;

    -- Drop EVERY check constraint on this table that mentions capability_key,
    -- whatever it happens to be called.
    FOR con_name IN
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = target_table
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) ILIKE '%capability_key%'
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target_table, con_name);
    END LOOP;

    EXECUTE format($fmt$
      ALTER TABLE %I ADD CONSTRAINT %I CHECK (capability_key IN (
        'enable_document_ai',
        'enable_item_funding',
        'enable_matching_intelligence',
        'enable_application_drafting',
        'enable_pipeline_automation',
        'enable_auto_submit',
        'enable_funder_intelligence',
        'enable_outreach',
        'enable_compliance_reporting',
        'enable_bulk_export'
      ))
    $fmt$, target_table, target_table || '_capability_key_check');
  END LOOP;
END $$;
