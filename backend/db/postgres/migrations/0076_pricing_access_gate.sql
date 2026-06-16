-- 0076_pricing_access_gate (Postgres)
--
-- Mirrors backend/db/migrations/080_pricing_access_gate.sql.

CREATE TABLE IF NOT EXISTS profile_pricing (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  user_id TEXT,
  quote_id TEXT,
  pricing_catalog_version TEXT NOT NULL,
  client_category TEXT NOT NULL,
  category_confidence TEXT,
  recommended_package_name TEXT,
  primary_service_key TEXT,
  subtotal_cents BIGINT NOT NULL DEFAULT 0,
  discount_total_cents BIGINT NOT NULL DEFAULT 0,
  total_cents BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  payment_required SMALLINT NOT NULL DEFAULT 1,
  agreement_required SMALLINT NOT NULL DEFAULT 1,
  access_status TEXT NOT NULL DEFAULT 'pending_pricing',
  admin_review_required SMALLINT NOT NULL DEFAULT 1,
  discount_eligible SMALLINT NOT NULL DEFAULT 0,
  discount_summary_json JSONB,
  reasons_json JSONB,
  missing_inputs_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_profile_pricing_profile ON profile_pricing(profile_id);
CREATE INDEX IF NOT EXISTS idx_profile_pricing_user ON profile_pricing(user_id);
CREATE INDEX IF NOT EXISTS idx_profile_pricing_access ON profile_pricing(access_status);

CREATE TABLE IF NOT EXISTS service_agreements (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  profile_id TEXT NOT NULL,
  quote_id TEXT,
  agreement_version TEXT NOT NULL,
  accepted SMALLINT NOT NULL DEFAULT 0,
  accepted_at TIMESTAMPTZ,
  accepted_ip TEXT,
  accepted_user_agent TEXT,
  agreement_text_snapshot TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_agreements_profile ON service_agreements(profile_id);
CREATE INDEX IF NOT EXISTS idx_service_agreements_user ON service_agreements(user_id);
CREATE INDEX IF NOT EXISTS idx_service_agreements_quote ON service_agreements(quote_id);

CREATE TABLE IF NOT EXISTS payment_access_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  profile_id TEXT,
  quote_id TEXT,
  event_type TEXT NOT NULL,
  details_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_profile_created ON payment_access_events(profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_events_user_created ON payment_access_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_events_type_created ON payment_access_events(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_pricing_notifications (
  id TEXT PRIMARY KEY,
  admin_email TEXT NOT NULL,
  user_id TEXT,
  profile_id TEXT,
  quote_id TEXT,
  notification_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  payload_json JSONB,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_notifications_email_status ON admin_pricing_notifications(admin_email, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_notifications_quote ON admin_pricing_notifications(quote_id);
CREATE INDEX IF NOT EXISTS idx_admin_notifications_profile ON admin_pricing_notifications(profile_id);
