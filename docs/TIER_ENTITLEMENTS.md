# GrantFlow Tier & Entitlement Model

This is the canonical reference for GrantFlow's billing tiers, what each tier
unlocks, how that's enforced, and how discounts/pro-bono work.

## 1. Single source of truth

**`shared/tierCatalog.js`** defines every tier ONCE. It is consumed by:

- **Backend** — seeds `billing_tiers` (`backend/services/billingAccounts.js`),
  served read-only at **`GET /api/billing/catalog`** (public), and used to
  resolve seat-count → org tier → monthly amount (`computeEffectiveBilling`).
- **Frontend** — `Pricing.jsx`, the `TierMatrix` "What your plan includes"
  component, and the `useTierEntitlements()` hook all read it **via the API**, so
  the backend stays the runtime source of truth and nothing can drift.

Because the catalog is the only place tiers are defined, the public pricing page,
the billing overview, admin tier tools, and entitlement enforcement are aligned
by construction (a test asserts `publicPricingTiers()` matches the tier
definitions and capabilities).

## 2. Canonical tiers

`id` matches `billing_tiers.id` — **do not rename without a migration.**

| id | name | family | monthly | hourly | seats | Document AI | Item funding | Pipeline automation |
|----|------|--------|---------|--------|-------|:-:|:-:|:-:|
| `foundation` | Foundation | service | Free | — | — | ✅ | ✅ | ❌ |
| `growth` | Growth | service | $99 | $150 | — | ✅ | ✅ | ✅ |
| `enterprise` | Enterprise | service | $249 | $225 | — | ✅ | ✅ | ✅ |
| `individual` | Individual / family | service | Free | $85 | — | ✅ | ✅ | ❌ |
| `small_org` | Small organization | organization | $149 | $85 | 1 | ✅ | ✅ | ❌ |
| `mid_size` | Mid-sized organization | organization | $349 | $115 | 2–5 | ✅ | ✅ | ✅ |
| `large_org` | Large organization | organization | $599 | $150 | 6+ | ✅ | ✅ | ✅ |

**Organization tiers are seat-driven.** An org account's monthly amount follows
its number of email logins (seats): 1 → small, 2–5 → mid, 6+ → large. See §5.

## 3. Capability flags (the entitlement vocabulary)

Three flags, identical on the backend (`backend/utils/tierGating.js
TIER_CAPABILITIES`), the `billing_tiers` columns, and the catalog:

| flag | plain English |
|------|---------------|
| `enable_document_ai` | AI reads uploaded documents and fills in the profile. **Uploading/storing documents is always free**; only the AI parsing/enrichment is gated. |
| `enable_item_funding` | Search funding for specific items/needs and queue deeper crawlers. |
| `enable_pipeline_automation` | Hamilton works the pipeline hands-off (prepares applications, fills portals). |

No UI ever shows a raw flag name — plain-English labels live in
`CAPABILITY_LABELS` and flow through the catalog API.

## 4. Discounts & pro bono (overrides, NOT tiers)

`student`, `minister`, `hardship`, and `pro_bono` are **discounts applied on top
of a tier**, never tiers themselves. Stored on `billing_accounts`
(`discount_type`, `discount_percent`, `is_pro_bono`). Defaults live in the
catalog `DISCOUNTS` list (student 15%, minister 10%, hardship 15%, pro bono
100%). An admin approves/sets them; `computeEffectiveBilling` applies them.

## 5. Seat → invoice amount

`computeEffectiveBilling(db, profileId, account)`
(`backend/services/billingAccounts.js`) resolves what a profile is actually
billed, in priority order:

1. `custom_monthly_cents` (admin override) — wins.
2. `is_pro_bono` → $0.
3. **Organization tier → the seat-derived org tier's monthly** (seats drive the
   amount). Seats = distinct `profile_emails` excluding the platform-admin email
   (`countSeats`, `backend/services/billing/seatTier.js`).
4. Otherwise the assigned tier's `base_monthly_cents`.

Then `discount_percent` is applied to produce `net_monthly_cents`. Adding a
member that crosses a seat boundary warns first (`POST /api/profiles/:id/emails`
returns `409 requires_confirmation`).

## 6. Backend enforcement (server-side, admins bypass)

Every premium endpoint resolves the profile's tier and checks the relevant flag
via `requireTierCapability` / `enforceTierCapability` (routes) or
`enforceCrawlerJobTier` (crawler jobs). Admins (`req.ctx.isAdmin`) bypass.

| Capability | Enforced at (examples) |
|-----------|------------------------|
| `enable_document_ai` | `ai.js` (10 AI routes), `documents.js` ingest/process, `profiles.js` enrich/scan/avatar-lookup, crawler jobs `document_ingest`/`profile_enrichment`/`avatar_lookup` |
| `enable_item_funding` | crawler job `item_search`, **`realCrawlers.js POST /specific-need` (live search — added so search + crawler can't diverge)** |
| `enable_pipeline_automation` | crawler job `pipeline_automation`, pipeline automation actions |

Frontend disabled buttons are **convenience only** — the server is authoritative.

## 7. Frontend gating

- **`useTierEntitlements(profileId)`** (`src/hooks/useTierEntitlements.js`) is the
  one place the UI asks "what can this profile do?" — returns `tier`,
  `capabilities`, `can(key)`, `locked[]`, `upgradeMessage(key)`, and
  loading/error. Admins bypass. It supersedes the ad-hoc
  `canUseFeature(billing, 'enable_x')` checks (migration of each page to the hook
  is ongoing — see verification report).
- **`TierMatrix`** renders the plain-English "What your plan includes" comparison
  from the catalog (used on Pricing + Billing).
- **Non-admin billing**: `GET /api/billing/me/:profileId` (auth + profile access,
  **read-only**). Mutations stay admin-only (`PUT /api/billing/accounts/:id`).

## 8. Visibility rule

**Locked features are shown with a plain-English upgrade message, not hidden.**
Navigation stays visible to all authenticated users; gating happens at the
feature/button level (disabled + upgrade message). Rationale: discoverability
drives upgrades, and hiding pages confuses users who had access on another tier.

## 9. Intentional open-access features

- **Document upload/storage** — always free; only AI parsing is gated.
- **Grant discovery, saving, and pipeline tracking** — available to all tiers.
- **Item funding search** — included in every current tier (baseline). The gate
  exists so an admin *could* restrict it, but no current tier does.
