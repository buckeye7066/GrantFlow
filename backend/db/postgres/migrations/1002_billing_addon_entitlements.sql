CREATE TABLE IF NOT EXISTS billing_addon_entitlements (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  capability_key TEXT NOT NULL CHECK(capability_key IN ('enable_document_ai', 'enable_item_funding', 'enable_pipeline_automation')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked', 'expired')),
  source TEXT NOT NULL DEFAULT 'admin' CHECK(source IN ('admin', 'stripe', 'service_purchase', 'promotion', 'migration')),
  source_reference TEXT,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ CHECK(expires_at IS NULL OR expires_at > starts_at),
  granted_by TEXT,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT,
  reason TEXT,
  metadata TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_addon_profile_capability
  ON billing_addon_entitlements(profile_id, capability_key, status);
CREATE INDEX IF NOT EXISTS idx_billing_addon_active_window
  ON billing_addon_entitlements(profile_id, status, starts_at, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_addon_source_reference
  ON billing_addon_entitlements(profile_id, capability_key, source, source_reference)
  WHERE source_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_entitlement_events (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  entitlement_id TEXT REFERENCES billing_addon_entitlements(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('granted', 'revoked', 'expired')),
  capability_key TEXT NOT NULL CHECK(capability_key IN ('enable_document_ai', 'enable_item_funding', 'enable_pipeline_automation')),
  actor TEXT,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_entitlement_events_profile
  ON billing_entitlement_events(profile_id, created_at);
