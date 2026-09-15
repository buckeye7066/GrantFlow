-- Widen the capability_key CHECK to the full capability vocabulary (2026-09-15).
--
-- `billing_addon_entitlements` and `billing_entitlement_events` each enumerated
-- the THREE original capabilities in SQL. The vocabulary grew to ten, so
-- `ADDON_CATALOG` advertised ten purchasable capabilities while the database
-- rejected seven of them: `grantBillingAddon` failed with
--   CHECK constraint failed: capability_key IN ('enable_document_ai', ...)
-- which is a paid upsell that cannot be sold.
--
-- The enumeration is DUPLICATED vocabulary — the authority is
-- `shared/tierCatalog.js CAPABILITY_KEYS`, and `assertCapabilityKey` in
-- entitlementService already refuses an unknown key at the application edge.
-- It is kept as defense-in-depth rather than dropped, but it is now pinned by a
-- DRIFT TRIPWIRE (`backend/tests/capabilityKeySchemaDrift.test.js`) so the next
-- flag cannot be added without this list moving with it. That test is the guard
-- the first version of this constraint lacked.
--
-- SQLite cannot ALTER a CHECK constraint, so both tables are rebuilt. Indexes
-- are recreated verbatim from 1002.

PRAGMA foreign_keys=OFF;

CREATE TABLE IF NOT EXISTS billing_addon_entitlements__new (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  capability_key TEXT NOT NULL CHECK(capability_key IN (
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
  )),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked', 'expired')),
  source TEXT NOT NULL DEFAULT 'admin' CHECK(source IN ('admin', 'stripe', 'service_purchase', 'promotion', 'migration')),
  source_reference TEXT,
  starts_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME CHECK(expires_at IS NULL OR expires_at > starts_at),
  granted_by TEXT,
  revoked_at DATETIME,
  revoked_by TEXT,
  reason TEXT,
  metadata TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO billing_addon_entitlements__new
  SELECT id, profile_id, capability_key, status, source, source_reference,
         starts_at, expires_at, granted_by, revoked_at, revoked_by, reason,
         metadata, created_at, updated_at
  FROM billing_addon_entitlements;

DROP TABLE billing_addon_entitlements;
ALTER TABLE billing_addon_entitlements__new RENAME TO billing_addon_entitlements;

CREATE INDEX IF NOT EXISTS idx_billing_addon_profile_capability
  ON billing_addon_entitlements(profile_id, capability_key, status);
CREATE INDEX IF NOT EXISTS idx_billing_addon_active_window
  ON billing_addon_entitlements(profile_id, status, starts_at, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_addon_source_reference
  ON billing_addon_entitlements(profile_id, capability_key, source, source_reference)
  WHERE source_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_entitlement_events__new (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  entitlement_id TEXT REFERENCES billing_addon_entitlements(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('granted', 'revoked', 'expired')),
  capability_key TEXT NOT NULL CHECK(capability_key IN (
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
  )),
  actor TEXT,
  details TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO billing_entitlement_events__new
  SELECT id, profile_id, entitlement_id, event_type, capability_key, actor,
         details, created_at
  FROM billing_entitlement_events;

DROP TABLE billing_entitlement_events;
ALTER TABLE billing_entitlement_events__new RENAME TO billing_entitlement_events;

CREATE INDEX IF NOT EXISTS idx_billing_entitlement_events_profile
  ON billing_entitlement_events(profile_id, created_at);

PRAGMA foreign_keys=ON;
