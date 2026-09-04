-- 185: Link billing_accounts to a real Stripe subscription.
--
-- Before this migration the tier system was assignment-only: the ONLY writer of
-- billing_accounts.tier_id was the admin route (backend/routes/billing.js), and
-- backend/routes/stripeWebhook.js handled exactly one event
-- (checkout.session.completed) for one-time service purchases. Stripe never
-- created a subscription (stripeService only used mode:'payment'), so a paying
-- customer could never unlock enable_item_funding / enable_document_ai /
-- enable_pipeline_automation. Money moved; capability did not.
--
-- These columns let backend/services/billing/subscriptionSync.js be the single
-- authority that turns a verified Stripe subscription into a tier assignment,
-- and make the linkage auditable (who paid, which price, what state, until when).

ALTER TABLE billing_accounts ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE billing_accounts ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE billing_accounts ADD COLUMN stripe_price_id TEXT;
ALTER TABLE billing_accounts ADD COLUMN subscription_status TEXT;
ALTER TABLE billing_accounts ADD COLUMN subscription_current_period_end DATETIME;

CREATE INDEX IF NOT EXISTS idx_billing_accounts_stripe_sub
  ON billing_accounts(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_billing_accounts_stripe_customer
  ON billing_accounts(stripe_customer_id);
