-- Prevent delayed Stripe subscription webhooks from reverting newer billing state.
ALTER TABLE billing_accounts
  ADD COLUMN IF NOT EXISTS stripe_event_created_at TIMESTAMPTZ;
