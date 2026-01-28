-- Service catalog + Stripe purchase tracking (seeded from Payment Sheet extract at runtime).

CREATE TABLE IF NOT EXISTS service_catalog_items (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  pricing_model TEXT NOT NULL, -- one_time | milestone | hourly
  is_active BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_prices (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  service_id TEXT NOT NULL REFERENCES service_catalog_items(id) ON DELETE CASCADE,
  client_category TEXT NOT NULL, -- individual|small|mid|large
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  milestone_phase TEXT, -- kickoff|draft|submission (nullable)
  stripe_price_id TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(service_id, client_category, currency, milestone_phase)
);

CREATE TABLE IF NOT EXISTS service_terms (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  version TEXT NOT NULL UNIQUE,
  policy_snippet TEXT NOT NULL,
  full_text TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_purchases (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT,
  profile_id TEXT,
  organization_id TEXT,
  service_id TEXT NOT NULL REFERENCES service_catalog_items(id),
  client_category TEXT NOT NULL,
  pricing_model TEXT NOT NULL,
  status TEXT NOT NULL,
  agreed_terms_version TEXT,
  agreed_at DATETIME,
  stripe_customer_id TEXT,
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS milestone_payments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  purchase_id TEXT NOT NULL REFERENCES service_purchases(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL,
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  paid_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(purchase_id, phase)
);

CREATE TABLE IF NOT EXISTS hourly_time_entries (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  purchase_id TEXT NOT NULL REFERENCES service_purchases(id) ON DELETE CASCADE,
  minutes INTEGER NOT NULL,
  rounded_minutes INTEGER NOT NULL,
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hourly_invoices (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  purchase_id TEXT NOT NULL REFERENCES service_purchases(id) ON DELETE CASCADE,
  total_rounded_minutes INTEGER NOT NULL,
  units INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL,
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  paid_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT,
  processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stripe_customers (
  user_id TEXT PRIMARY KEY,
  stripe_customer_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_service_prices_service ON service_prices(service_id);
CREATE INDEX IF NOT EXISTS idx_service_purchases_user ON service_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_milestone_purchase ON milestone_payments(purchase_id);
CREATE INDEX IF NOT EXISTS idx_hourly_time_purchase ON hourly_time_entries(purchase_id);
CREATE INDEX IF NOT EXISTS idx_hourly_invoice_purchase ON hourly_invoices(purchase_id);

