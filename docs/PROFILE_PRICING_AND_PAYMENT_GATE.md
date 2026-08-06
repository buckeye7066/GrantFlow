# Profile Pricing & Access Gate

This document describes how GrantFlow automatically prices every new
profile, notifies the only admin (`owner@example.invalid`), and gates
access to the full app behind a service agreement and a kickoff
payment.

It builds on the [Pricing Engine](./PRICING_ENGINE.md) (catalog,
client-category classifier, service-recommendation rules, discount
engine, quote builder, Sam pricing auditor).

---

## 1. Lifecycle of a new profile

1. A new profile is created (Anya intake, manual signup, organization
   profile, imported, or admin-created).
2. The caller invokes
   `initializeProfilePricing(db, { profile, intakeAnswers, organization,
   matches, user, source })` from
   `backend/services/pricing/profilePricingInitializer.js`. The
   `POST /api/pricing/recommend` endpoint and
   `POST /api/access-gate/initialize-pricing` both call into this
   helper.
3. The initializer:
   - calls `buildRecommendedQuote(...)` (catalog + rules + discounts)
   - persists the quote (line items + suggested discounts)
   - upserts a row in `profile_pricing`
   - creates an unsigned row in `service_agreements`
   - queues a row in `admin_pricing_notifications` for the configured
     admin email (skipped for admin profiles)
   - records `pricing_created` and `admin_notified`
     `payment_access_events`
4. The frontend pulls `/api/access-gate/status?profile_id=…` and
   either renders the requested route or redirects to
   `/PricingRequired?profile_id=…`.
5. The user accepts the agreement
   (`POST /api/access-gate/agreement/accept`). Status becomes
   `pending_payment`.
6. The user pays via the existing service-catalog Stripe flow
   (`POST /api/services/purchases` → `POST /api/stripe/checkout/service`).
7. On payment success, the webhook (or the admin
   `POST /api/access-gate/payment-success`) calls `markPaid`. Status
   becomes `active_paid`. `RequirePaidAccess` now lets the user into
   the full app.

Admins always bypass the gate. Admins can also call
`POST /api/access-gate/admin-waive` to grant access without payment;
the waiver is recorded in `payment_access_events`.

---

## 2. Tables

Migrations: `backend/db/migrations/080_pricing_access_gate.sql` and
`backend/db/postgres/migrations/0076_pricing_access_gate.sql` (idempotent).

| Table                          | Purpose                                                                 |
| ------------------------------ | ----------------------------------------------------------------------- |
| `profile_pricing`              | one row per profile; access_status drives the gate                      |
| `service_agreements`           | records agreement acceptance (version, IP, UA, snapshot)                |
| `payment_access_events`        | audit log of every gate transition                                      |
| `admin_pricing_notifications`  | queued/delivered/dismissed admin toast notifications                    |

`pricing_quotes` already exists from migration `079`; we additionally
use `quote_status` values `pending_user_agreement`, `pending_user_payment`,
`paid`, and `admin_waived`.

`access_status` values:

| value                | meaning                                            |
| -------------------- | -------------------------------------------------- |
| `pending_pricing`    | quote requires admin review                        |
| `pending_agreement`  | quote ready, awaiting user agreement               |
| `pending_payment`    | agreement accepted, awaiting payment               |
| `active_paid`        | payment confirmed; full app unlocked               |
| `admin_waived`       | admin waived the requirement                       |
| `blocked`            | manually blocked                                   |
| `expired`            | quote/agreement expired                            |

---

## 3. APIs

### Public (any authenticated user)

| Method | Path                                  | Body                                                | Notes                                  |
| ------ | ------------------------------------- | --------------------------------------------------- | -------------------------------------- |
| GET    | `/api/access-gate/status`             | (query: `profile_id`)                               | returns the decision payload           |
| POST   | `/api/access-gate/agreement/accept`   | `{ profile_id, agreement_text }`                    | records IP+UA, advances state          |
| POST   | `/api/pricing/recommend`              | `{ profile_id, intake_answers, … }`                 | runs initializer; idempotent           |

### Admin only

| Method | Path                                                        | Notes                                                |
| ------ | ----------------------------------------------------------- | ---------------------------------------------------- |
| POST   | `/api/access-gate/initialize-pricing`                       | force-init for an existing profile                   |
| POST   | `/api/access-gate/payment-success`                          | mark paid (used by webhook handlers)                 |
| POST   | `/api/access-gate/admin-waive`                              | grant access without payment                         |
| GET    | `/api/pricing/admin-notifications`                          | list queued/delivered/dismissed (admin email only)   |
| POST   | `/api/pricing/admin-notifications/flush-queued`             | flush queued items on login                          |
| POST   | `/api/pricing/admin-notifications/:id/delivered`            | mark a single notification delivered                 |
| POST   | `/api/pricing/admin-notifications/:id/dismiss`              | dismiss a notification                               |

The notification endpoints additionally restrict results to
`PRICING_ADMIN_NOTIFICATION_EMAIL` (default `owner@example.invalid`).
A user with `is_admin=true` but a different email gets an empty list.

---

## 4. Frontend

| Component                                                  | Role                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------- |
| `src/components/auth/RequirePaidAccess.jsx`                | route HOC; redirects unpaid users to `/PricingRequired` |
| `src/pages/PricingRequired.jsx`                            | landing page for the gate (agreement + checkout)        |
| `src/pages/ServiceAgreement.jsx`                           | agreement-only step                                     |
| `src/pages/CheckoutRequired.jsx`                           | checkout-only retry surface                             |
| `src/components/pricing/ProfilePricingGate.jsx`            | state machine for the unpaid experience                 |
| `src/components/pricing/ServiceAgreementGate.jsx`          | agreement checkbox + submit                             |
| `src/components/pricing/PricingCheckoutPanel.jsx`          | hands off to existing service-catalog Stripe flow       |
| `src/components/pricing/PricingPreviewCard.jsx`            | limited match preview with "not guaranteed" disclaimer  |
| `src/components/admin/AdminPricingToastListener.jsx`       | polls `/admin-notifications`; shows sonner toasts       |
| `src/components/admin/AdminPricingNotifications.jsx`       | admin page that lists every notification                |

Routing in `src/pages/index.jsx` is updated:
- `withGate(...)` wraps blocked routes (Dashboard, Pipeline, Documents,
  Apply, etc.).
- `withBoundary(...)` is preserved for routes that must remain
  reachable (login, AnyaOnboarding, AnyaIntakeResults, Pricing,
  PricingRequired, ServiceAgreement, CheckoutRequired, Admin, …).

`<AdminPricingToastListener />` is mounted once inside the layout. It
checks `user.email === owner@example.invalid` (or
`PRICING_ADMIN_NOTIFICATION_EMAIL` from env on the server) before
polling.

---

## 5. Environment toggles

| Env                                                         | Default       | Purpose                                                          |
| ----------------------------------------------------------- | ------------- | ---------------------------------------------------------------- |
| `PRICING_ADMIN_NOTIFICATION_EMAIL`                          | `owner@example.invalid` | the only admin who receives toasts                       |
| `PRICING_ADMIN_TOASTS_ENABLED`                              | `true`        | turn off to silence admin notifications                          |
| `PRICING_REQUIRE_PAYMENT_BEFORE_FULL_ACCESS`                | `true`        | controls whether agreement+payment are required                  |
| `PRICING_ALLOW_LIMITED_MATCH_PREVIEW_BEFORE_PAYMENT`        | `true`        | controls the post-intake match preview                           |
| `PRICING_SHOW_DISCOUNT_ELIGIBILITY_TO_CLIENT`               | `false`       | whether the user-facing UI exposes discount eligibility          |

---

## 6. Sam audits

`samPricingGateAuditor.js` adds the following findings:

- `profile_missing_pricing`         — profile without a `profile_pricing` row
- `admin_blocked_by_payment_gate`   — admin user with a non-waived blocking status
- `profile_pricing_total_mismatch`  — `subtotal − discount ≠ total`
- `wrong_admin_notification_target` — toast routed to a non-configured email
- `admin_notification_missing`      — new non-admin user with no `new_user_pricing` toast
- `unpaid_access_leak`              — `access_granted` event for an unpaid profile
- `paid_but_blocked`                — `payment_succeeded` event without `active_paid`
- `pricing_missing_catalog_version` — `profile_pricing` row missing the catalog version

The pre-existing `samPricingAuditor.js` continues to audit the catalog,
quote math, ethical billing, and client-facing language for
"guaranteed" claims.

---

## 7. Privacy & ethical billing

- Admin notification bodies show package + total + discount eligibility.
  Raw intake answers and sensitive demographic fields never appear.
- `service_agreements.agreement_text_snapshot` captures what the user
  saw when they accepted, so terms can be audited later.
- The user-facing copy in every component renders the spec-mandated
  disclaimer:

  > Potential funding amounts are based on published opportunity
  > information and are not guaranteed.

- The catalog and Sam's auditor both reject award-contingent /
  percentage-based language. See `catalogIsEthical()` and
  `auditClientFacingLanguage()`.
