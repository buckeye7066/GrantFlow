# GrantFlow service-price configuration and authenticated acceptance

## Changed

Added `backend/scripts/sync-stripe-service-prices.mjs`: dry-run by default, `--apply` configures only GrantFlow service products and prices at the approved June 15 catalog amounts. It validates the complete payable catalog before writes, checks existing Stripe mappings, uses durable lookup keys and idempotency keys, and compares each database row before saving a mapping. It creates no customers, checkouts, subscriptions, invoices, or charges. Hourly prices represent six-minute units; milestone totals remain reference rows.

The charge audit, Stripe verifier, and admin mapping-status route share the payable-row query. Provider errors and unavailable verification no longer produce a successful audit result.

## Verified in this session

- Signed-in production Anya conversation completed without degradation after PR #1794. The answer matched the selected profile and identified unconfirmed eligibility rather than asserting qualification. Profile-specific evidence remains in the private operational record. This proves profile context and a completed answer, not which AI provider served it.
- PR #1795 application-link grounding fix merged through the guarded script and Railway deployment succeeded. A fresh discovery job started after stale-worker cleanup; no successful end-to-end result yet.
- Live read-only Stripe audit: 14 active prices scanned, five existing GrantFlow recurring tier prices, all live mode. All 72 payable service prices lacked mappings; 12 additional milestone totals are intentionally not payable.
- Local configuration/verifier/charge/Sam tests: 45 passed. Real PostgreSQL integration: six passed, including configuration and retry. Full service catalog/Stripe route tests: five passed. The mapping route regression first failed with 84 instead of 72, then passed. Targeted ESLint and pre-push build/checks passed.

## Unknown / remaining

The new configuration script has not yet deployed or applied to production. No payment was charged. Required PR CI, live dry run, configuration, and post-configuration audit remain. Actual Stripe price validation immediately before checkout requires a separate dependency-chain review.

The earlier discovery job failed after deployment interrupted its worker; preserve that evidence in the private operational record. Complete the fresh crawl before another deployment interrupts it.

GrantFlow is not declared production ready. Preserve the owner's full scope: profile-derived and specific-need discovery, real company funders, tiers/addons, Anya ownership/context, Amy learning and repair workflows, Sam source review, Yana leads, John drafting, Robert matching, four-point truth, canonical profile selection, and Hamilton mapping through confirmed submission. The exact-50 requirement was retired. No external grant submission was performed in this session.
