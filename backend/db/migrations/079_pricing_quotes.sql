-- 079_pricing_quotes
--
-- Tables that back the GrantFlow pricing engine. All idempotent. The
-- pricing system is the source of truth for what GrantFlow charges; the
-- catalog itself lives in code (versioned by PRICING_CATALOG_VERSION).
--
-- Ethical-billing invariants (Sam's pricing auditor enforces these):
--   * total = subtotal − sum(approved discounts)
--   * no fee is contingent on award outcomes
--   * no fee is computed as a percentage of award

CREATE TABLE IF NOT EXISTS pricing_quotes (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  profile_id TEXT NOT NULL,
  intake_session_id TEXT,
  pricing_catalog_version TEXT NOT NULL,
  client_category TEXT NOT NULL,
  category_confidence TEXT,
  recommended_package_name TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  discount_total REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  payment_terms_json TEXT,
  admin_review_required INTEGER NOT NULL DEFAULT 1,
  quote_status TEXT NOT NULL DEFAULT 'internal_recommendation',
  reasons_json TEXT,
  missing_inputs_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
  base_price REAL NOT NULL DEFAULT 0,
  quantity REAL NOT NULL DEFAULT 1,
  subtotal REAL NOT NULL DEFAULT 0,
  reason TEXT,
  confidence REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (quote_id) REFERENCES pricing_quotes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pricing_quote_line_items_quote ON pricing_quote_line_items(quote_id);

CREATE TABLE IF NOT EXISTS pricing_quote_discounts (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL,
  discount_key TEXT NOT NULL,
  label TEXT,
  discount_type TEXT NOT NULL DEFAULT 'percent',
  discount_value REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  reason TEXT,
  requires_admin_approval INTEGER NOT NULL DEFAULT 1,
  approved INTEGER NOT NULL DEFAULT 0,
  approved_by_user_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (quote_id) REFERENCES pricing_quotes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pricing_quote_discounts_quote ON pricing_quote_discounts(quote_id);

CREATE TABLE IF NOT EXISTS pricing_discount_rules (
  id TEXT PRIMARY KEY,
  discount_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  discount_type TEXT NOT NULL DEFAULT 'percent',
  discount_value REAL NOT NULL DEFAULT 0,
  max_amount REAL,
  applies_to_services_json TEXT,
  requires_admin_approval INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pricing_discount_rules_enabled ON pricing_discount_rules(enabled);
