# GrantFlow Pricing → Stripe Checkout Hardening

This document explains the contract that the GrantFlow pricing system,
service catalog, and Stripe checkout pipeline must hold. Sam's pricing
audit and the unit suite enforce these rules; if you change pricing logic
without updating the rules below, both will fail.

The active catalog version is **`2026-06-15`** and the canonical extract
lives at `docs/Payment_sheet_Grantflow_2026-06-15_EXTRACT.md`.

## Source of truth

| Concern                    | File                                                    |
| -------------------------- | ------------------------------------------------------- |
| Pricing menu (markdown)    | `docs/Payment_sheet_Grantflow_2026-06-15_EXTRACT.md`    |
| Catalog version constant   | `backend/services/pricing/pricingTypes.js` (`PRICING_CATALOG_VERSION`) |
| Catalog (frozen object)    | `backend/services/pricing/pricingCatalog.js`            |
| Extract parser             | `backend/services/serviceCatalogExtractParser.js`       |
| Catalog seeder + DB upsert | `backend/services/serviceCatalogStore.js`               |
| Slug aliases               | `backend/services/pricing/serviceSlugAliases.js`        |
| Client-category classifier | `backend/services/pricing/clientCategoryClassifier.js`  |
| Charge resolver            | `backend/services/pricing/chargeResolver.js`            |
| Stripe price verifier      | `backend/services/pricing/stripePriceVerifier.js`       |
| Sam Stripe audit           | `backend/services/pricing/samPricingStripeAuditor.js`   |
| Stripe checkout route      | `backend/routes/stripe.js`                              |
| Stripe webhook             | `backend/routes/stripeWebhook.js`                       |
| Admin verification API     | `backend/routes/adminServiceCatalog.js`                 |

The catalog version constant in code (`PRICING_CATALOG_VERSION`) MUST stay
in lock-step with `CANONICAL_EXTRACT_VERSION`. The unit test
`tests/unit/service-catalog-2026-06-15.test.mjs` enforces this.

## Client categories

The system uses **two label conventions** that map 1:1:

| Pricing engine label | Catalog / Stripe code |
| -------------------- | --------------------- |
| `individual`         | `individual`          |
| `small`              | `small`               |
| `mid_size`           | `mid`                 |
| `large`              | `large`               |

`clientCategoryClassifier.classifyClient()` always returns the **catalog
code** (`mid`, not `mid_size`). The frontend MUST not be trusted to
choose the chargeable category — `chargeResolver.resolveChargeForQuote()`
re-runs the classifier server-side whenever a profile is supplied.

### Classifier rules

* `individual / family / student / medical_assistance` → `individual`.
* Org profile with explicit `annual_budget`:
  * `< $250,000` → `small`
  * `$250,000 – $2,000,000` → `mid`
  * `> $2,000,000` → `large`
* Org profile with **unknown** annual budget:
  * Defaults to `small`
  * `confidence = 'estimated_needs_admin_review'`
  * `admin_review_required = true`
  * `missing_fields` includes `'annual_budget'`

## Service slugs

Twelve canonical slugs (all bare — no inline price-range qualifiers):

```
quick-eligibility-scan
comprehensive-funding-dossier
application-strategy-session
micro-grant-application
standard-foundation-application
complex-federal-application
transfer-scholarship-pack
editing-and-redraft-service
budget-and-logic-model-development
compliance-reporting-and-management
grant-calendar-setup-and-management
hourly-consultation-and-advisory
```

Legacy slugs from the 2025-11-13 menu are mapped via
`serviceSlugAliases.LEGACY_SLUG_TO_CANONICAL`. The catalog seeder
(`seedServiceCatalogFromExtract`) renames legacy rows to the canonical
slug or deactivates them when both already exist; existing
`service_purchases.service_id` references are preserved.

## Charge invariants

For every Stripe checkout, `resolveChargeForQuote` enforces:

1. The slug resolves to **one** `service_catalog_items` row (canonical or
   legacy alias).
2. `client_category` is one of `individual / small / mid / large`.
3. `service_prices` row exists for the
   `(service_id, client_category, currency, milestone_phase)` combination.
4. `service_prices.amount_cents` equals the 2026 catalog amount for that
   service+category+phase. Drift is reported as `DB_PRICE_CATALOG_DRIFT`.
5. The quote line item amount equals `service_prices.amount_cents`
   unless an **approved** discount is present.
6. Discounts only reduce the final charge once approved or when
   `PRICING_AUTO_DISCOUNTS_ENABLED=true`.
7. Stripe checkout uses `service_prices.stripe_price_id` for the
   resolved row.
8. Missing Stripe Price ID → `STRIPE_PRICE_MISSING` (block checkout).
9. Stripe-side `unit_amount` mismatch → `STRIPE_PRICE_AMOUNT_MISMATCH`.
10. **Never** create a checkout with a stale or mismatched Price ID.
11. For one-time prices, an approved discount that lowers the total
    requires either a discount-specific Stripe Price ID or a Stripe
    coupon flow. The resolver returns
    `DISCOUNT_REQUIRES_DEDICATED_PRICE_OR_COUPON` rather than silently
    applying the discount to the wrong Stripe Price.

### Milestone math

For milestone services, the resolver returns the **per-phase** amount:

```
kickoff    = round(total_cents * 0.4)
draft      = round(total_cents * 0.4)
submission = total_cents - kickoff - draft
```

Phases must be paid in order: `kickoff → draft → submission`. The Stripe
route (`POST /api/stripe/checkout/service`) refuses any out-of-order
phase with `MILESTONE_ORDER`.

### Hourly math

Hourly rates are stored as **per-6-minute unit cents**:

```
service_prices.amount_cents = round(hourly_rate_cents / 10)
```

Catalog tiers (2026-06-15):

| Tier        | Hourly rate | Unit cents |
| ----------- | ----------- | ---------- |
| individual  | $85         | 850        |
| small       | $85         | 850        |
| mid         | $115        | 1150       |
| large       | $150        | 1500       |

Hourly checkouts apply a 15-minute minimum and bill in 6-minute
increments via `roundBillableMinutes`.

## Stripe checkout metadata

Every Stripe checkout session now ships with a complete metadata block
so the webhook can validate, idempotency keys can vary by amount, and
admin audits can correlate the charge to its catalog version:

```json
{
  "kind": "service_purchase | milestone_payment | hourly_invoice",
  "purchase_id": "<service_purchases.id>",
  "quote_id": "<pricing_quotes.id> | ''",
  "service_slug": "quick-eligibility-scan",
  "service_id": "<service_catalog_items.id>",
  "client_category": "small",
  "pricing_model": "one_time | milestone | hourly",
  "milestone_phase": "kickoff | draft | submission | ''",
  "catalog_version": "2026-06-15",
  "catalog_amount_cents": "12500",
  "approved_discount_cents": "0",
  "final_amount_cents": "12500"
}
```

## Webhook contract

`POST /api/stripe/webhook` only grants paid access when ALL of the
following hold:

1. The `Stripe-Signature` header verifies against
   `STRIPE_WEBHOOK_SECRET`.
2. The event is `checkout.session.completed`.
3. Metadata has `kind` ∈ `service_purchase | milestone_payment |
   hourly_invoice`.
4. `purchase_id` matches an existing `service_purchases` row.
5. When `quote_id` is present, the quote's `profile_id` matches the
   purchase's `profile_id` (no cross-profile grant).
6. The DB UPDATE matches `> 0` rows.

When all checks pass, `grantPaidAccess()` flips
`profile_pricing.access_status → active_paid`, marks the linked quote
as `paid`, and writes a `payment_access_events` row of type
`payment_succeeded`. Sam's audit
(`samPricingStripeAuditor.auditStripePricingChain`) cross-checks these
and surfaces:

* `paid_webhook_did_not_grant_access` — purchase paid but profile_pricing
  still pending.
* `unpaid_user_full_access` — profile_pricing `active_paid` without a
  paid purchase or admin waiver.

## Admin endpoints

* `GET /api/admin/service-catalog/stripe-price-verification` — verifies
  every active `service_prices` row against Stripe (or the deterministic
  mock when `STRIPE_MOCK=true`).
* `GET /api/admin/service-catalog/charge-resolution` — runs the charge
  resolver for every (service, category, phase) tuple in the catalog and
  surfaces which combinations are not checkout-ready.

A CLI runner is also available:

```bash
node scripts/verify-stripe-price-mapping.mjs
```

The script exits non-zero on any missing mapping, mismatch, or inactive
price so CI can gate releases on it.
