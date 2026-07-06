# CLAUDE.md — GrantFlow

Guidance for Claude Code (and human contributors) working in this repo.

## Live-editing lock (multi-agent coordination)

This repo is sometimes worked on by more than one assistant at once (a Claude
Code session AND Cursor's agent share the same working tree). Concurrent
autonomous writes entangle diffs and produce surprise commits.

**If a file named `.agent-edit-lock` exists at the repo root**, a human and
another assistant are actively editing right now. Unless you are the session
that created the lock, you MUST NOT edit/create/delete files, commit, or push —
do read-only work only and tell the user the repo is locked. This suspends any
"auto-push fixes" / "optimize continuously" standing instructions while the lock
is present. The lock is git-ignored; remove it (`rm .agent-edit-lock`) to
release. (Cursor honors the same lock via `.cursor/rules/respect-edit-lock.mdc`.)

## Commands

```bash
npm run dev          # Vite frontend dev server
npm run backend      # Express backend only
npm run dev:full     # Both frontend & backend (concurrently)

npm run build        # Production build
npm run lint         # ESLint (zero warnings enforced)
npm run typecheck    # TypeScript check
npm run unit         # Vitest unit tests
npm run test         # lint + typecheck + unit + build
npm run test:all     # + smoke + e2e (Playwright)

npm run migrate      # Run DB migrations
npm run db:setup     # migrate + seed
npm run doctor       # Project health check
```

## Architecture

- **Frontend** (`src/`): React 18 + Vite + TypeScript + Tailwind + Radix UI. State via Zustand (`stores/`). Feature-based components under `components/`. API calls go through `api/`.
- **Backend** (`backend/`): Express, 30+ route files under `backend/routes/`, business logic in `backend/services/`, DB access via `backend/db/`. Entry: `backend/server.js`. Boot tasks in `backend/startup/`.
- **AI**: Claude (`@anthropic-ai/sdk`) + OpenAI for drafting, discovery, and the "Anya" assistant. Prompts in `backend/prompts/`.
- **DB**: SQLite for local/test (`backend/db/schema.sql`), Postgres in prod via a shim. Tests use vitest with `.js` (`backend/tests/`); a few runners use `node:test` with `.mjs` — match the convention of the file you're editing.
- **Deployment**: Frontend → Vercel, Backend → Railway (PostgreSQL).
- **Canonical product rules + goals**: `docs/canonical_rules.md` is the single source of truth. Read it before changing matching, discovery, pipeline, or tenancy behavior.

## INVARIANTS — enforce at a choke point, never trust per-call discipline

GrantFlow's recurring bugs came from canonical RULES being enforced only by
convention ("remember to check X in every code path"). The standing rule:

> A machine-checkable product rule must be re-asserted in ONE place against the
> live DB, so it holds regardless of which code path created the data. The
> per-call gate is the first line of defense; the boot sweep is the net. Do NOT
> scatter new ad-hoc checks across call sites.

**The single enforcer is `backend/startup/enforceInvariants.js`**, run on every
boot from `backend/server.js` immediately after `ensureSchemaInvariants()`. The
full `runSelfHeal()` orchestrator in `backend/startup/selfHeal.js` also calls it
as step 9 for Sam/Anya on-demand and maintenance runs, but boot wires the
invariant sweep directly so it cannot be skipped by self-heal schedule changes.
It mirrors `backend/startup/ensureSchemaInvariants.js` (which owns schema-shape
DDL; data-repair invariants go in `enforceInvariants.js`).

When you add or change behavior that touches an invariant below, change the
enforcer + its test — do not rely on a new per-call check alone.

| Invariant | Single enforcer | Guard test |
| --- | --- | --- |
| Sticky deletes (deleted pipeline grants stay gone) | `reconcileDismissedGrants()` in `backend/services/pipelineDismissals.js`, re-run by `enforceStickyDeletes()` | `backend/tests/enforceInvariants.test.js` |
| No cross-profile / cross-tenant bleed (grant org must match its profile's org) | `enforceNoCrossProfileBleed()` | `backend/tests/enforceInvariants.test.js` |
| Relevance / match-score floor (no junk in pipeline; `match_score < 50` excl. NULL) | `enforceRelevanceFloor()` (count-only unless `ENFORCE_RELEVANCE_FLOOR=1`) | `backend/tests/enforceInvariants.test.js` |
| Pipeline grants belong to a profile (no orphan `profile_id IS NULL` rows leaking into org-scoped reads/PDFs) | `enforceProfileScopedPipeline()` (ON by default; preserves `amount_awarded > 0`; disable via `ENFORCE_PROFILE_SCOPED_PIPELINE=0`) | `backend/tests/enforceInvariants.test.js` |
| One canonical income per **individual** profile (conflicting `household_income` across the `financial` vs `financial_information` sections must not poison need-based matching) | `enforceProfileIncomeReconciliation()` — for INDIVIDUAL/student/family/veteran profiles only, collapses a conflict to the applicant's own (need-consistent / **lower**) income and syncs both sections; orgs/businesses are never touched; an ambiguous conflict with no need signal is **logged for human review, not changed**. Read-only audit: `backend/scripts/audit-profile-income-conflicts.mjs` | `backend/tests/enforceInvariants.test.js` |
| No search-engine application targets (a `google.com/search?q=…` / other search-RESULTS url is never a portal/application URL on `application_tasks`, `funding_opportunities`, or `grants`) | `enforceNoSearchEngineApplicationTargets()` (nulls the URL; reclassifies non-terminal tasks to blocked/`unknown_application_method`; bounded + idempotent; disable via `ENFORCE_URL_HYGIENE=0`). Producers gated at `opportunityInserter.upsertFundingOpportunity` + `hamiltonAutomationClassifier.readUrl` via the canonical `isSearchEngineUrl()` (`backend/config/urlRules.js`) | `backend/tests/enforceInvariants.test.js` |
| Pipeline grants carry the funder's name when knowable (`grants.funder` ← linked `funding_opportunities.sponsor`; the catalog column is `sponsor`, the pipeline column is `funder` — #725 naming-drift class) | `enforceFunderBackfill()` — re-copies the sponsor from the linked opportunity; NEVER invents a value (unlinked/empty-sponsor rows are counted as `missingFunder`, not guessed). Ingest-side first line of defense: `resolveSponsorName()` in `backend/services/opportunityInserter.js` accepts `funder`/`funder_name`/`organization`/`agency` aliases into `sponsor` | `backend/tests/enforceInvariants.test.js` + static tripwire `backend/tests/funderFieldDrift.test.js` |
| Pipeline grants carry a DOLLAR value when one is knowable (every "Pipeline $" surface reads the `backend/config/pipelineValue.js` choke point: `amount_requested` → `amount_max` → `amount_min`; never re-inline a status list or `SUM(amount_requested)` — the "$6,500 pipeline with 118 real sources" class) | `enforceGrantAmountBackfill()` — inherits `amount_min/max` from the linked catalog row, defaults `amount_requested` from the ceiling/floor; NEVER invents a value (`missingAmount` counted, not guessed). Write-side first line of defense: `saveToProfilePipeline` defaults `amount_requested`; ingest-side: `resolveOpportunityAmounts()` (`backend/services/awardAmountExtractor.js`) conservatively extracts per-award dollars from text when a source provides no structured amounts. Runs BEFORE `enforceIndividualAmountCeiling` so the ceiling purges on honest values | `backend/tests/enforceInvariants.test.js` + `backend/tests/pipelineValue.test.js` + `backend/tests/awardAmountExtractor.test.js` |

**Never weaken these guardrails:** NULL match_score is not junk; protected
(user-progressed) statuses are never auto-purged; `link_unverified` ≠ dead; all
comparisons are profile-scoped. See the "INVARIANTS" section of
`docs/canonical_rules.md` for the full rationale and the list of invariants that
are documented-but-not-yet-auto-enforced (source denylist, zero-result-but-no-junk,
agent observability).
