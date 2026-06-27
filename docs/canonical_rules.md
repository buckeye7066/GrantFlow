# GrantFlow Canonical Rules & Goals

_Last updated: 2026-06-27_

This document is the **single source of truth** for GrantFlow’s product rules, correctness invariants, and acceptance criteria.

If a rule is uncertain, it is marked explicitly as an **Assumption**. **Do not change behavior** that depends on an assumption until the assumption is either confirmed or replaced with an explicit rule.

## Scope

Applies to:
- **Backend**: `backend/server.js`, `backend/routes/*`, `backend/services/*`, SQLite schema in `backend/db/schema.sql`
- **Frontend**: `src/pages/*`, `src/api/*`, `src/stores/*`
- **Automation**: crawler jobs (`crawler_jobs`), funding catalog (`funding_opportunities`), pipeline (`grants`)

## Definitions

- **Profile**: A record in `profiles` plus its structured `profile_sections`. Profiles may be linked to a user via `profiles.user_id`.
- **Opportunity / Funding Opportunity**: A row in `funding_opportunities` (the “Discover Grants / Funding Opportunities catalog”).
- **Grant**: A row in `grants` representing a pursued opportunity (pipeline status workflow).
- **Crawler Job**: A row in `crawler_jobs` representing an automation run (local, scholarship, comprehensive, item_search, document_ingest, profile_enrichment, pipeline_automation, avatar_lookup).
- **Match score**: A normalized score in \([0,1]\) for standardized crawler output (future) and a UI match score in \([0,100]\) for display. Conversion: \(score\_{pct} = round(score\_{0..1} * 100)\).
- **Orphan profile**: A `profiles` record that is **not linked to any `users` row** (`profiles.user_id IS NULL`) but is otherwise active.

## Product goals (from repo docs + implementation)

Sources:
- `README.md`
- `docs/PROD_READINESS.md`
- `docs/AUTH_FLOW_BLUEPRINT.md`
- `docs/BASE44_GAP_ANALYSIS.md`
- `OPS_AUTOFIX.md`
- Current implementation in `backend/services/*.js` and `src/pages/*.jsx`

### G0. Truthful data, truthful proof, no fake shortcuts

Hard rules:
- **Do not fake funding.** User-facing catalogs, profile pipelines, crawler results, award histories, foundation traces, and application packets must never contain fabricated, placeholder, lorem, demo, dummy, or AI-invented funding sources presented as real.
- **Do not fake production proof.** A deterministic test, fixture, or offline routing check may prove code behavior, but it must be labeled as such. It must not be described as a live crawl, live award lookup, deployed health check, or production data verification unless it actually used that live path.
- **Do not bypass guardrails to make a result look green.** Auth, admin checks, tenant/profile scoping, the reality gate, the canonical matcher, source verification, Hamilton hard stops, and release gates must not be skipped, weakened, or hidden to pass a demo or deadline.
- **Missing evidence is a gap, not a license to invent.** If a source, foundation grant list, portal, award amount, document field, profile answer, or live endpoint cannot be verified, GrantFlow must say so and either ask Anya/Hamilton/the admin for the missing proof or mark the item as unverified.
- **Mocks, fakes, and fixtures are allowed only inside tests and clearly labeled tooling.** They must never seed production, masquerade as crawler output, or be used as the sole basis for declaring a live workflow production-ready.
- **AI may summarize, classify, and draft from supplied facts; it may not invent facts, relationships, amounts, eligibility, deadlines, portal access, funder history, or prior contact.**

### G1. Non-fragile, observable, and testable

- **No silent failures**: exceptions must be surfaced to the caller (API response / job status) with context.
- **Every critical behavior has a test**: unit/integration/E2E coverage is required for core flows.
- **Deterministic automation**: given identical inputs, mocked externals, and the same DB seed, automation results must be stable in CI.
- **Errors funnel through ONE choke point.** Route handlers must surface failures
  via `next(error)`, not by calling `res.status(500).json(formatError(e))` inline.
  The global `errorHandler` middleware (`backend/middleware/errorHandler.js`,
  mounted last in `server.js`) is the single place that (a) records the error for
  diagnostics via `recordRequestError` (so Sam / Mission Control can see it) and
  (b) classifies it. Do NOT re-implement status mapping per route.
- **Transient DB contention is retryable (503), not a 500.** A Postgres
  `statement_timeout` (SQLSTATE 57014) or pool-acquire timeout — e.g. a heavy
  `funding_opportunities` catalog scan colliding with a live crawl — is a
  capacity condition, not a server fault. `isRetryableDbError()` detects this and
  the choke point returns `503 { error: 'catalog_busy', retryable: true }`; the
  Discover UI retries with backoff. The ~12 heavy read routes that still
  `catch → res.status(500)` inline (discovery, opportunities, grants, robert,
  fundingTrace, …) should converge on `next(error)` so they inherit this.

### G2. Funding discovery must be useful (zero-results is a failure state)

This repo’s UX and automation pages present crawlers as a system that should populate the opportunity catalog.

Hard rule:
- **Zero results is a failure state** for discovery operations. If an operation evaluates candidates but includes none, the system must **log why items were removed** and then **relax constraints and/or re-score** rather than returning a silent empty set.

### G3. Crawl results must appear in the “Discover Grants / Funding Opportunities” UI

Hard rule:
- If crawlers insert opportunities into `funding_opportunities`, those opportunities **must be retrievable** via `GET /api/opportunities` and **must be count-visible** in the UI.

Hard rule (counts mapping):
- The UI’s “Showing X opportunities” must map **1:1** to backend response fields:
  - `GET /api/opportunities` returns `{ data, total, limit, offset }`
  - UI displays `total` when provided, otherwise `data.length`

### G4. Profile-driven behavior (avoid brittle boolean filtering)

Hard rules:
- **Missing profile fields must not disqualify** a funding source by default. Missing fields are neutral.
- **Profile attributes increase score, not eliminate results** by default.
- **Exact-match requirements are forbidden** unless legally required.
- **Population/eligibility mismatches reduce score, not discard results** (unless the opportunity is explicitly exclusive).
- **Hard AND filters must be avoided** unless the funding source is explicitly exclusive.

Geographic matching rule:
- Matching expands outward: **city → county → state → national** (never only “exact ZIP” unless explicitly exclusive).

Directory-style resources rule:
- Directory-style or general funding resources (broad “where to find grants” sources) must survive filtering unless explicitly excluded.

### G5. Compliance (“grant funds only”) is a presentation/triage layer, not data loss

Current code supports a “Funding terms” filter in UI (`src/pages/FundingOpportunities.jsx`) backed by `GET /api/opportunities?compliance=...`.

Hard rules:
- Compliance classification must be **computed and explainable** (`compliance_status`, `compliance_reasons`), never silently applied.
- **Default behavior must not hide all opportunities**. If applying compliance filtering would produce zero results while opportunities exist, the response must include:
  - a reason summary explaining removals, and/or
  - a relaxed mode suggestion (or automatic fallback) that still returns some opportunities.

Assumption (pending confirmation):
- “Grant funds only” is the default view, but “review-required” opportunities should remain available via a filter toggle without being deleted/ignored in storage.

### G6. Automation job invariants

Hard rules:
- Every `crawler_jobs` run must end in one of: `completed`, `failed`, `cancelled`.
- A completed job must store:
  - `result_count` (inserted or processed count)
  - `result_meta` (JSON) with at least `duration_seconds` and relevant counters (e.g., `evaluated`, `inserted`)
- Failures must store a non-empty `error` and should store a structured `result_meta.error`.

### G7. Geo crawler (nationwide ZIP coverage) must persist REAL sources (≥ 3 per ZIP)

The UI and docs claim “Nationwide crawl… at least three grants per ZIP” (see `src/pages/Automation.jsx` and `src/pages/FundingOpportunities.jsx`).

Hard rules:
- Maintain a durable `geo_funding_sources`-style table keyed by ZIP.
- For each ZIP, persist **≥ 3 verified sources**, or the ZIP job remains incomplete and retries later.
- “REAL” means:
  - URL is valid and non-placeholder
  - URL is reachable (polite rate limiting, timeouts)
  - The source appears to be a funding/grants entity (heuristics + allow/deny list)
  - De-duplicate by normalized domain + name
- Must respect robots.txt and terms; prefer official/public datasets or directories.
- The nationwide crawl must be **incremental and resumable** (checkpointed).

### G8. Security, RBAC, and secrets handling

Hard rules:
- Secrets live in env vars; no keys in code.
- Admin access must be enforced server-side; UI-only protection is insufficient.
- Auth/session tokens handled securely; avoid leaking across accounts.

## INVARIANTS — enforce at a choke point, never trust per-call discipline

**Why this section exists:** The same class of bug kept recurring because a
canonical rule above was enforced only by *convention* ("remember to check the
tombstone in every insert path", "remember to scope by `profile_id`
everywhere"). Every new code path that forgot the check re-introduced the
violation (deleted grants reappearing, cross-profile bleed, junk piling up).

**The standing rule for ALL future changes (humans and agents):** Do not rely
on remembering to do the right thing in each call site. A machine-checkable
product rule MUST be re-asserted in ONE place against the live DB so it holds
regardless of which path created the data. The per-call gate (e.g. a DISMISSED
check before insert) is the first line of defense; the boot sweep is the net.
When you add or change behavior that touches one of these invariants, you change
the single enforcer + its test — you do NOT scatter new ad-hoc checks.

The canonical enforcer is **`backend/startup/enforceInvariants.js`**, run on
every boot from `runSelfHeal()` in `backend/startup/selfHeal.js` (step 9, after
`reconcileDismissedGrants`). It mirrors `backend/startup/ensureSchemaInvariants.js`:
each invariant is its own guarded, idempotent, dialect-agnostic step that detects
violations, repairs/quarantines them, and logs a structured summary. Schema-shape
DDL stays in `ensureSchemaInvariants.js`; data-repair invariants go here.

| Invariant (rule above) | Single enforcer (one function) | Test that guards it |
| --- | --- | --- |
| **Sticky deletes** — a source a user deleted from a profile pipeline stays gone | `reconcileDismissedGrants()` in `backend/services/pipelineDismissals.js`, re-run by `enforceStickyDeletes()` | `backend/tests/enforceInvariants.test.js` ("sticky deletes") |
| **No cross-profile / cross-tenant bleed** (G4, G8) — a grant's `organization_id` must equal its `profile_id`'s org | `enforceNoCrossProfileBleed()` (re-aligns to the profile's org; profile_id is the authoritative tenancy signal) | `backend/tests/enforceInvariants.test.js` ("no cross-profile / cross-tenant bleed") |
| **Relevance / match-score floor** (G4 + prune playbook) — pipeline must not accumulate junk (`match_score < 50`, excl. NULL) | `enforceRelevanceFloor()` (count-only by default; deletes only when `ENFORCE_RELEVANCE_FLOOR=1`; never touches NULL scores or protected statuses) | `backend/tests/enforceInvariants.test.js` ("relevance floor") |

**Guardrails baked into the enforcer (do not weaken):**
- NULL `match_score` is NEVER junk (G4 "missing fields are neutral").
- Grants in `PROTECTED_PIPELINE_STATUSES` (submitted/awarded/drafting/… + legacy) are NEVER auto-purged — that is user work (Mission Goal #10).
- `reality_status='downgraded'` / `link_unverified` means "URL not yet pinged", NOT "dead" — never delete on that signal (G2/G5).
- Tombstone matching and every comparison are profile-scoped so one profile can never delete another's data.

**Invariants documented but NOT yet auto-enforced (TODO — add a step + test before relying on convention):**
- **Source allowlist / denylist** — blocklist currently matches 0 grant funders in prod; auto-purge needs a confirmed funder→blocklist match rule before it's safe to delete on.
- **Zero-result-but-no-junk** (G2) — "relax constraints and re-score on empty" is a request-time behavior, not a stored-state invariant; can't be reconciled by a boot sweep.
- **Agent observability rule** — any change in an agent's scope must be visible to Sam (diagnostics) + usable by Anya; this is a wiring/process rule, enforced in review, not by a DB sweep.

## Known gaps / TODOs (must become hard rules once implemented)

- Standardized crawler output schema: `{ raw, normalized, score_0_1, explain, provenance }`
- Deterministic pipeline runner: every crawler × every profile, persist results with score > 0.50
- Stripe end-to-end billing contract and idempotent webhook handling
