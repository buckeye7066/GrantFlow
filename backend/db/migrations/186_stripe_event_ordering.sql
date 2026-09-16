-- Prevent delayed Stripe subscription webhooks from reverting newer billing state.
ALTER TABLE billing_accounts ADD COLUMN stripe_event_created_at DATETIME;
