# Validate the actual Stripe price before service checkout

## Changed

An incorrect Stripe mapping could charge a different amount from the approved quote. The shared payment-checkout boundary now requires server-derived unit cents, currency, and service identity; retrieves the actual Stripe Price and product; and refuses incorrect amounts, currencies, service/category/phase ownership, inactive products/prices, recurring or tiered prices, and quantity transformations. Provider lookup failure prevents session creation. Subscription-mode semantics remain separate.

Both service and hourly callers supply these expectations. Hourly prices now pass through the canonical charge resolver, so database catalog drift cannot bypass approved six-minute-unit pricing. Route errors return a structured checkout failure. Failed hourly attempts release the pending-invoice state for retry; their cleanup no longer writes a nonexistent `hourly_invoices.updated_at` column.

## Verified

The shared-boundary regressions failed before implementation (14 failures), then passed. Actual Express routes with a real SQLite catalog and stubbed provider exercise mismatched amount/currency and unavailable verification for both callers, asserting zero session creation and successful retry. Hourly tests assert three units for 18 rounded minutes and reject database catalog drift. The route tests first exposed three hourly cleanup failures, then passed after the column mismatch repair. Together with atomic webhook tests, 35 tests passed. No provider charge was made.

## Unknown

Final independent review, full release CI, deployment, and live operational acceptance remain pending. This repair does not certify the whole application or a real payment lifecycle. Preserve the broader GrantFlow-only production-readiness scope and the retirement of the exact-50 requirement.
