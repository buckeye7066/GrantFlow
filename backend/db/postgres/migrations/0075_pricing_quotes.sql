-- 0075_pricing_quotes (Postgres)
--
-- Mirrors backend/db/migrations/079_pricing_quotes.sql. JSONB + TIMESTAMPTZ.

CREATE TABLE IF NOT EXISTS pricing_quotes (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  profile_id TEXT NOT NULL,
  intake_session_id TEXT,
  pricing_catalog_version TEXT NOT NULL,
  client_category TEXT NOT NULL,
  category_confidence TEXT,
  recommended_package_name TEXT,
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  payment_terms_json JSONB,
  admin_review_required SMALLINT NOT NULL DEFAULT 1,
  quote_status TEXT NOT NULL DEFAULT 'internal_recommendation',
  reasons_json JSONB,
  missing_inputs_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pricing_quotes_profile ON pricing_quotes(profile_id);
CREATE INDEX IF NOT EXISTS idx_pricing_quotes_status_created ON pricing_quotes(quote_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pricing_quotes_admin_review ON pricing_quotes(admin_review_required, created_at DESC);

CREATE TABLE IF NOT EXISTS pricing_quote_line_items (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL,
  service_key TEXT NOT NULL,
  service_name TEXT NOT NULL,
  client_category TEXT NOT NULL,
  base_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  quantity NUMERIC(12,2) NOT NULL DEFAULT 1,
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  reason TEXT,
  confidence NUMERIC(4,3),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_pricing_line_items_quote FOREIGN KEY (quote_id)
    REFERENCES pricing_quotes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pricing_quote_line_items_quote ON pricing_quote_line_items(quote_id);

CREATE TABLE IF NOT EXISTS pricing_quote_discounts (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL,
  discount_key TEXT NOT NULL,
  label TEXT,
  discount_type TEXT NOT NULL DEFAULT 'percent',
  discount_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  reason TEXT,
  requires_admin_approval SMALLINT NOT NULL DEFAULT 1,
  approved SMALLINT NOT NULL DEFAULT 0,
  approved_by_user_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_pricing_discounts_quote FOREIGN KEY (quote_id)
    REFERENCES pricing_quotes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pricing_quote_discounts_quote ON pricing_quote_discounts(quote_id);

CREATE TABLE IF NOT EXISTS pricing_discount_rules (
  id TEXT PRIMARY KEY,
  discount_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  enabled SMALLINT NOT NULL DEFAULT 0,
  discount_type TEXT NOT NULL DEFAULT 'percent',
  discount_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  max_amount NUMERIC(12,2),
  applies_to_services_json JSONB,
  requires_admin_approval SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pricing_discount_rules_enabled ON pricing_discount_rules(enabled);
