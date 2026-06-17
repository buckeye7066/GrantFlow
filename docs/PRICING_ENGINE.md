# GrantFlow Pricing Engine

This document describes how GrantFlow turns an Anya intake into:

1. A **funding match results screen** the user sees immediately.
2. A **background pricing recommendation** stored for admin review.

The pricing engine never bills a percentage of an award. It never makes
a fee contingent on award outcomes. Sam's pricing auditor enforces both
rules.

## Source of truth

The user-supplied pricing menu (dated **6/15/2026**) is encoded in
[`backend/services/pricing/pricingCatalog.js`](../backend/services/pricing/pricingCatalog.js)
and pinned to:

```
PRICING_CATALOG_VERSION = "2026-06-15"
```

Every quote stores the catalog version it was generated against
(`pricing_quotes.pricing_catalog_version`). Bumping the version requires:

1. Edit the catalog and bump `PRICING_CATALOG_VERSION` in
   `backend/services/pricing/pricingTypes.js`.
2. Decide what to do with existing quotes (typically: leave them on the
   prior version; they remain valid because they record their version).
3. Update the catalog test in `tests/unit/pricing-catalog.test.mjs`.
4. Update this document with a changelog entry.

## Architecture

```
intake answers ─────┐
profile ────────────┼─► pricingRules.determineClientCategory  ─► client_category
organization ───────┘                                          │
matches ─────────────────────────────────────────────────────► │
                                                               ▼
                                  pricingRules.recommendServices ─► line_items, reasons
                                                               │
                                                               ▼
                                  pricingCatalog.getServicePrice ─► base prices
                                                               │
                                                               ▼
                                  discountEngine.recommendDiscounts ─► discounts (pending approval)
                                                               │
                                                               ▼
                                              pricingEngine.buildRecommendedQuote
                                                               │
                                                               ▼
                                            quoteBuilder.persistQuote (DB)
                                                               │
                                                               ▼
                                              /api/pricing/* routes (admin)
```

The frontend lives in:

- `src/components/anya/AnyaIntakeResults.jsx` — match-results screen
- `src/components/anya/AnyaFundingMatchCard.jsx` — single match card
- `src/components/anya/AnyaPotentialFundingSummary.jsx` — totals card
- `src/components/pricing/*` — admin pricing review widgets
- `src/components/admin/AdminPricingRecommendations.jsx` — admin section

## Client categories

| category   | label       | rule                                                                 |
| ---------- | ----------- | -------------------------------------------------------------------- |
| individual | Individual  | profile is `individual`, `family`, `student`                         |
| small      | Small Org   | annual budget < $250,000, OR unknown but small/local signals present |
| mid_size   | Mid-Size    | annual budget $250,000–$2,000,000                                    |
| large      | Large Org   | annual budget > $2,000,000                                           |

When budget is unknown the classifier returns confidence
`needs_admin_review` and the resulting quote is flagged for admin
review.

## Service catalog

The 12 services + per-category prices live in
[`pricingCatalog.js`](../backend/services/pricing/pricingCatalog.js). The
catalog is frozen at boot and the prices are not editable at runtime.

## Service recommendation rules

`pricingRules.recommendServices` walks the intake + matches and produces
line-item recommendations. The full rule set is documented inline in
`pricingRules.js` and exercised by `tests/unit/pricing-rules.test.mjs`.

Notable rules:

- **Research-only intent** → Quick Eligibility Scan (or Comprehensive Funding Dossier when the landscape is broad).
- **Application help** → Micro-Grant (<$5K), Standard Foundation ($5K–$250K), or Complex/Federal ($250K+ or federal/grants.gov signals).
- **Existing draft** → Editing & Redraft.
- **Budget / logic-model gap** → Budget & Logic Model Development.
- **Post-award** → Compliance Reporting & Management.
- **Multiple deadlines** → Grant Calendar Setup & Management.
- **Unclear scope** → Hourly Consultation, with `admin_review_required=true`.

## Discounts

[`discountEngine.js`](../backend/services/pricing/discountEngine.js) is
deliberately conservative:

- No discount applies automatically unless the rule is **enabled** AND
  `PRICING_AUTO_DISCOUNTS_ENABLED=true`.
- Recommended discounts default to `approved=false`. The quote is flagged
  `admin_review_required=true` whenever a discount is recommended.
- The total discount across a quote is capped by
  `PRICING_MAX_TOTAL_DISCOUNT_PERCENT` (default 25 %).

## Environment toggles

| env                                              | default | meaning                                                     |
| ------------------------------------------------ | ------- | ----------------------------------------------------------- |
| `PRICING_DISCOUNTS_ENABLED`                      | `true`  | master switch for the discount engine                       |
| `PRICING_AUTO_DISCOUNTS_ENABLED`                 | `false` | apply enabled discounts automatically (without approval)    |
| `PRICING_REQUIRE_ADMIN_APPROVAL_FOR_DISCOUNTS`   | `true`  | every discount is recommended with `requires_admin_approval` |
| `PRICING_MAX_TOTAL_DISCOUNT_PERCENT`             | `25`    | hard cap on combined discount amount                         |
| `PRICING_REQUIRE_ADMIN_APPROVAL`                 | `true`  | quotes default to `admin_review_required=true`               |
| `PRICING_SHOW_CLIENT_ESTIMATE`                   | `false` | when `true`, `/api/pricing/my-estimate/:profileId` returns a non-binding estimate sentence |

## Storage

Migration: `backend/db/migrations/079_pricing_quotes.sql` (SQLite) and
`backend/db/postgres/migrations/0075_pricing_quotes.sql` (Postgres).

Tables:

- `pricing_quotes`              — header
- `pricing_quote_line_items`    — children (services, base price × quantity)
- `pricing_quote_discounts`     — per-quote discounts (require approval)
- `pricing_discount_rules`      — rule-level config (per-tenant overrides)

`quoteBuilder.js` writes through `withProfileScope({ bypass: true })`
because the system caller is acting cross-tenant.

## API

| route                                              | who    | purpose                                  |
| -------------------------------------------------- | ------ | ---------------------------------------- |
| `GET /api/pricing/my-estimate/:profileId`          | user   | gentle non-binding estimate (gated env)  |
| `POST /api/pricing/recommend`                      | admin  | called by Anya intake on completion      |
| `GET /api/pricing/quotes`                          | admin  | list quotes                              |
| `GET /api/pricing/quotes/:id`                      | admin  | quote detail                             |
| `POST /api/pricing/quotes/:id/approve`             | admin  | approve quote                            |
| `POST /api/pricing/quotes/:id/edit`                | admin  | edit a line item                         |
| `POST /api/pricing/quotes/:id/discount`            | admin  | approve / remove / add discount          |
| `POST /api/pricing/quotes/:id/mark-presented`      | admin  | mark presented to client                 |
| `POST /api/pricing/quotes/:id/mark-accepted`       | admin  | mark accepted                            |
| `POST /api/pricing/quotes/:id/mark-declined`       | admin  | mark declined                            |
| `GET  /api/pricing/discount-rules`                 | admin  | list discount rule defaults              |
| `POST /api/pricing/discount-rules`                 | admin  | accept/echo a rule (DB persistence is a follow-up) |

Errors return `{ ok: false, error }`.

## User-facing language

Anya's results screen uses **potential**, **may qualify**, and
**estimated** language. It explicitly disclaims:

> Potential funding amounts are based on published opportunity
> information and are not guaranteed.

Sam's `auditClientFacingLanguage` flags any text that contains
`guaranteed`, `will receive`, `you are getting`, or
`awarded ... guarantee`.

## Sam audit

`samPricingAuditor.js` checks:

- Catalog version present + matches the current catalog.
- Currency is USD.
- Subtotal == sum of line items.
- Total == subtotal − approved discounts (with $0.01 tolerance).
- Approved discounts do not exceed the configured cap.
- No discount progresses past `approved`/`presented`/`accepted` without approval.
- No line item or reason mentions `% of award`, `commission`, `success fee`,
  `contingent on award`.
- Client category matches annual-budget thresholds when budget is known.
- Quotes do not progress to `presented`/`accepted` without admin approval
  when `PRICING_REQUIRE_ADMIN_APPROVAL=true`.

Findings are returned with severity (`critical`, `high`, `medium`, `low`,
`info`), category, title, description, recommended fix, and structured
evidence so an operator can act.

## Tests

- `tests/unit/pricing-catalog.test.mjs`
- `tests/unit/pricing-rules.test.mjs`
- `tests/unit/discount-engine.test.mjs`
- `tests/unit/pricing-engine.test.mjs`
- `tests/unit/quote-builder.test.mjs`
- `tests/unit/sam-pricing-auditor.test.mjs`
- `tests/unit/anya-results-formatters.test.mjs`
