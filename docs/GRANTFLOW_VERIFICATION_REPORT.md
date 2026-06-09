# GrantFlow Mission — Verification Report (Part 2)

**Branch:** `audit/root-fix-grantflow-mission` · **Date:** 2026-06-09
**Environment:** Windows 11, Node v22.21.1, local SQLite (`backend/data/grantflow.db`).

This report records the exact commands run and their real results. Where a check
requires live credentials/network it is **not faked** — the required env is documented.

---

## 1. Commands run & results

### Baseline (before any change)
| Command | Result | Notes |
|---------|--------|-------|
| `npm run lint` | ✅ PASS | |
| `npm run typecheck` | ✅ PASS | |
| `npm run build` | ✅ PASS | |
| `npm run unit` | ✅ PASS | 227 files / 616 tests |
| `npm run crawler:doctor` | ❌ FAIL | `no such column: opportunity_kind` |
| `npm run opps:check-national-minimum` | ❌ FAIL | `no such column: opportunity_kind` |
| `GRANTFLOW_DRY_RUN=1 npm run smoke:mission` | ⏭ SKIP (exit 2) | needs live creds (expected) |

### After this pass
| Command | Result | Notes |
|---------|--------|-------|
| `npm run lint` | ✅ PASS | |
| `npm run typecheck` | ✅ PASS | |
| `npm run unit` | ✅ PASS | 616 existing + 17 new tests (4 new files) |
| `npm run build` | ✅ PASS | |
| `npm run crawler:doctor` | ✅ PASS | schema applies; API smoke OK |
| `npm run opps:ensure-national-minimum` | ✅ PASS | 35 real national opportunities present |
| `npm run opps:check-national-minimum` | ✅ PASS | count=35, CA ZIP-scoped national_real=3 (≥3) |
| `GRANTFLOW_DRY_RUN=1 npm run smoke:mission` | ⏭ SKIP (exit 2) | needs live creds (expected) |

> The `opportunity_kind` failure was a single root cause (schema not idempotent on
> a pre-existing DB). Fixing it unblocked both gates; the 35 national opportunities
> were already real data the crashing query could not reach — no fake rows were added.

### New tests added (all passing)
- `tests/unit/schema-idempotency.test.mjs` — 6 tests (`applySqliteSchema` heals old tables, fresh DB, repeatable, parsing).
- `tests/unit/normalizer-loan-and-funding-type.test.mjs` — 7 tests (unknown→unknown; loan in description/metadata; forgiveness-not-loan; plain grant).
- `tests/unit/match-missing-eligibility-fields.test.mjs` — 2 tests (populated on non-REJECT; parity with `evaluateEligibility`).
- `tests/unit/ingestion-reality-gate.test.mjs` — 2 tests (broken-link direct reality-rejected on import; inactive reference row exempt).

---

## 1b. Part-2 continuation (commits f6f23137, 7ea4dd70)

Additional fixes after the first commit, each gated by lint + typecheck + build +
unit (all PASS) and, for crawler changes, `crawler:doctor` (PASS):

| Area | Change | Tests |
|------|--------|-------|
| RC-7 geo crawler | `nationalZipCrawler.saveOpportunity` routes through the gated `upsertFundingOpportunity` (reality gate + URL-fingerprint dedupe) | `geo-crawl-missing-tables` updated to full schema; `crawler:doctor` PASS |
| RC-7 Anya promote | `anyaAutonomousFunctionRunner` global-promote routes through `upsertFundingOpportunity` | unit suite |
| RC-9 match scout | `anyaMatchScout` uses `computeMatchDecision`; never surfaces/notifies a REJECT | `anyaMatchScout.test.mjs` (9) PASS |
| RC-10 explainMatch | `grants.explainMatch` uses `computeMatchDecision` instead of bespoke scoring | unit suite |
| RC-11 Anya prompt | callable-tool list generated from `CHAT_TOOL_WHITELIST`; honest reframe of non-callable capabilities | `anya-prompt-whitelist-parity.test.mjs` (3) PASS |
| RC-12 zero-result | `matching.js` junk-dump removed (canonical ladder authoritative); store carries `diagnostics`; `FundingResults` empty state explains searched/expanded + profile gaps + actions | `fundingResultsStore.profileScope` (6, +1 new) PASS |
| RC-15 card warnings | loan / matching-funds / expired chips on `FundingResultCard`; `toCanonicalResult` maps `is_loan`/`requires_match` | `FundingResultCard.test.jsx` (15, +4 new) PASS |

Deferred items (RC-8, RC-13, RC-14, RC-16, RC-17) with rationale are documented in
`AUDIT_GRANTFLOW_ROOT_CAUSES.md` — each requires a core-table schema/constraint
rebuild, a cross-cutting UI sweep, or a central matching-behavior change whose
quality impact is not verifiable without a live/E2E environment.

## 2. Migrations / schema

- **No destructive schema changes.** No production migration files were added in this
  pass.
- New helper `backend/db/ensureSqliteSchema.js` performs **additive, idempotent**
  column reconciliation (ALTER ADD COLUMN only) when standalone scripts apply
  `schema.sql` to a pre-existing SQLite DB. It never drops or rewrites data.
- The canonical migration runner (`backend/db/migrate.js`) and numbered migrations
  remain the source of truth for evolving app DBs; this helper only makes the
  schema-applying *scripts* resilient to old DB files.
- **Postgres:** the helper is SQLite-only (used only by SQLite scripts). The
  `assessReality` enforcement in `ingestionService` is dialect-agnostic (pure
  function on the opportunity object) and applies to both SQLite and Postgres.

---

## 3. Files changed in this pass

**Production code**
- `backend/db/ensureSqliteSchema.js` (new) — idempotent schema apply / column reconciler.
- `backend/services/opportunityNormalizer.js` — unknown funding type → `unknown`; full-text loan detection.
- `backend/services/matchEngine.js` — propagate `missingEligibilityFields` on ACCEPT/REVIEW.
- `backend/services/sources/ingestionService.js` — enforce canonical reality gate on active imports.
- `src/components/funding/toCanonicalResult.js` — stop fabricating the match decision; emit `UNRATED`.

**Scripts**
- `scripts/crawler-doctor.mjs` — use `applySqliteSchema`.
- `scripts/opportunities-national-minimum.mjs` — use `applySqliteSchema`.

**Tests**
- `tests/unit/schema-idempotency.test.mjs` (new)
- `tests/unit/normalizer-loan-and-funding-type.test.mjs` (new)
- `tests/unit/match-missing-eligibility-fields.test.mjs` (new)
- `tests/unit/ingestion-reality-gate.test.mjs` (new)

**Docs**
- `docs/AUDIT_GRANTFLOW_ROOT_CAUSES.md` (new)
- `docs/GRANTFLOW_MISSION_FIX_PLAN.md` (new)
- `docs/GRANTFLOW_VERIFICATION_REPORT.md` (new, this file)

---

## 4. Manual QA performed
- Confirmed the stale local DB (`backend/data/grantflow.db`, created 2026-04-05) was
  missing `opportunity_kind`, `source_trust_tier`, `result_kind`, `link_status`, etc.;
  confirmed `applySqliteSchema` backfills them and the dependent indexes then create.
- Empirically isolated the ingestion fixtures: a broken-link active direct row passes
  policy + validator + reviewer and is caught **only** by the reality gate (so the new
  test proves the new wiring, not an incidental earlier rejection).
- Confirmed `npm run unit` includes the four new test files (auto-discovered by
  `scripts/run-unit-tests.mjs`).

---

## 5. Remaining caveats / not verified here
- **Live mission smoke (`npm run smoke:mission`)** requires `GRANTFLOW_BASE_URL`,
  `GRANTFLOW_TEST_EMAIL`, `GRANTFLOW_TEST_PASSWORD` against a deployed instance. Run
  it post-deploy; it writes `artifacts/mission-smoke-report.json`.
- **Live ingestion (`npm run ingest:grantsgov`, `ingest:usaspending`)** hits real
  government APIs (network). The reality-gate enforcement was verified with an
  in-memory DB + deterministic fixtures, not against live payloads.
- **Browser E2E / smoke (`npm run smoke`, `e2e`)** were not run in this pass (require
  Playwright Chromium install + a running app).
- **Open follow-up items (confirmed, not yet fixed):** RC-7 through RC-17 in
  `AUDIT_GRANTFLOW_ROOT_CAUSES.md` — additional reality-gate insert bypasses
  (`nationalZipCrawler`, Anya autonomous promote, admin/seed routes), display-side
  parallel trust gate, Anya match-scout/explainMatch canonicalization, Anya
  prompt↔whitelist reconciliation, zero-result UI wiring, pipeline stage unification,
  profile-scoped saved items, result-card loan/expired chips.

**This pass did not declare the full mission DONE.** It fixed and verified a coherent
slice (two failing mission gates + four correctness root causes) and produced a
complete, evidence-backed audit of the remainder.

---

## 6. How to reproduce
```bash
git checkout audit/root-fix-grantflow-mission
npm ci
npm run lint && npm run typecheck && npm run build && npm run unit
npm run crawler:doctor
npm run opps:ensure-national-minimum && npm run opps:check-national-minimum
# Live (needs creds): GRANTFLOW_BASE_URL=... GRANTFLOW_TEST_EMAIL=... GRANTFLOW_TEST_PASSWORD=... npm run smoke:mission
```
