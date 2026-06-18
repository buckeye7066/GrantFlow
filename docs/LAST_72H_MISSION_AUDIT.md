# Last-72h Mission Optimization Audit

**Branch:** `audit/last-72h-mission-optimization`
**Audit date:** 2026-06-17 → 2026-06-18 (ET)
**Reviewer:** senior staff / QA-lead / release-auditor pass
**Commit range reviewed:** `edbde6cf` (= `800da056^`) … `6b365082` (HEAD at audit start)
**Window:** 38 commits over the last ~72 hours.

> Evidence rule: nothing below is marked *verified* unless the exact command was
> run in this audit and its output observed. Commands + results are in §6.

---

## 1. Commit range & systems touched

`git log --since="72 hours ago"` → 38 commits, `800da056 … 6b365082`.

Changed-area footprint (`git diff --name-only 800da056^..6b365082`, top dirs):

| Area | Files | Notes |
|---|---|---|
| `tests/unit` | 113 | large net-new coverage across agents/crawlers/pricing |
| `docs` | 28 | agent role docs, automation docs |
| `backend/routes` | 23 | `hamiltonAutomation`, `adminAgentControl`, `schoolPortal`, `crawlers`, `profiles`, pricing |
| `backend/services/hamilton` | 22 | renamed from `backend/services/yana/*` |
| `backend/services/robert` | 17 | funding-discovery → canonical match bridge |
| `backend/db/{postgres/,}migrations` | 34 | agents, school, pricing, agent-control, yana→hamilton rename, geo backfill |
| `backend/services/{pricing,larry,john,sam}` | 59 | new agents + pricing/access |
| `src/pages`, `src/components/admin`, `src/components/hamilton` | ~45 | admin consoles, agent control UI |

Headline features in-window: **Agent Control Center**, **Yana→Hamilton rename**, **Hamilton Autopilot + hard-stop resolver**, **school-portal SIS bridge**, **crawler/profile self-heal + partial-geo classification**, **pricing/access gate**, **single Anya onboarding**, **esbuild pin / MIGRATE_ON_BOOT default-on**.

---

## 2. Bugs found

| # | Severity | Area | Finding |
|---|---|---|---|
| **B1** | **CRITICAL** | Hamilton routes | A later-added block of `backend/routes/hamiltonAutomation.js` (payment-authorizations, saved sessions, attestations, resolved-fields, portal-policies, and the `:id` revoke/expire surfaces) read a caller-supplied `profileId` **with no authentication and/or no profile-access check**. Several used `req.user?.id || null`, tolerating unauthenticated callers. Result: **unauthenticated cross-profile reads** (payment authorizations, saved-session references, attestations, resolved fields) and **cross-profile mutation** (revoke/expire another profile's session, payment, attestation, or authorization). Directly violates the mission contract "no user may revoke/alter/use another profile's authorization/session/payment/attestation." No global `/api` auth gate exists (`attachRequestContext` is soft-auth), so the routes were genuinely reachable. |
| **B2** | LOW (process) | Test runner | `[anyaTestRepair]` auto-"repairs" failing tests *during* `npm run unit`. In this run it reported `Repaired: 0/1` (changed nothing), but an auto-mutating test-repair step is a latent regression-masking risk and should not run inside the release gate. |
| **B3** | LOW (env) | Windows dev env | 8 zombie `node --test tests/unit/yana-browser-automation.test.mjs` processes (from a **pre-rename** 2026-06-16 run) were still alive after ~26h and held the `better_sqlite3.node` native binary, causing `npm ci` to fail with `EPERM unlink`. The test file itself no longer exists (renamed to `hamilton-*`). Not a current code defect, but the leaked-process pattern can wedge CI / lock native binaries on Windows. |
| **B4** | INFO | Test runner | `tests/unit/scoring-consolidation.test.mjs` (a `node:test` file) is also collected by a vitest pass, where node:test's top-level `test()` calls cancel → 23 `cancelledByParent` "not ok" lines with `# pass 0 # fail 0`. Cosmetic TAP noise; **does not fail the gate** (`npm run unit` exits 0). |

### Non-findings (verified clean, not bugs)
- **UI does not fabricate match scores.** `src/pages/FundingOpportunities.jsx:scoreOpportunity` returns the backend `match_score` and explicitly refuses to invent one (`return { score: null … }`). Untouched in-window.
- **Score→label/color bands** (`GrantCard.jsx`, `GrantOverview.jsx`, `GeoFundingView.jsx`) are cosmetic styling of an already-computed backend score, not fabrication of the canonical `ACCEPT/REVIEW/REJECT` decision. `toCanonicalResult.js` validates decisions against a fixed `VALID_DECISIONS` set.
- **Raw `funding_opportunities` writes** in `routes/opportunities.js` (INSERT) and several services (UPDATE) had **0 commits in-window** (`opportunities.js`) or are `is_active`/link/deadline maintenance UPDATEs — pre-existing, not introduced in this window. (Recommend a separate pass to confirm all ingestion INSERTs set `reality_status`; see §8.)

---

## 3. Bugs fixed (this branch)

**B1 — Hamilton route auth + profile-scope (CRITICAL).** Minimal, pattern-consistent fix reusing the file's existing `requireAuthenticatedUser` + `userMayAccessProfile` helpers:

- Added two guards to `hamiltonAutomation.js`:
  - `requireProfileScope(req,res,profileId)` — auth + access for routes that take an explicit `profileId` (query/body).
  - `requireRecordOwnership(req,res,id,loader)` — auth + ownership for `:id` routes; loads the owning row and checks its `profile_id`.
- Applied to: `preflight-resolve`, `payment-authorizations` (GET/POST/`:id/revoke`/`can-pay`), `sessions` (GET/POST/`:id/revoke`/`:id/expire`), `attestations` (GET/POST/`:id/revoke`), `resolved-fields` (GET/POST), `authorizations/:id/revoke`.
- `portal-policies` **POST is now canonical-admin-only** (`isAdminUser`) because portal policy governs what Hamilton is *legally allowed* to do on a host; GET now requires auth.
- Added `getById` getters (return `profile_id` for ownership checks) to the session, payment, attestation, and authorization stores.

Files: `backend/routes/hamiltonAutomation.js` (+97/−36), `hamiltonCredentialSessionService.js`, `hamiltonPaymentAuthorizationService.js`, `hamiltonAttestationStore.js`, `hamiltonAuthorizationStore.js` (+9–10 each).

**Stale Yana→Hamilton labels (LOW).** `src/pages/Admin.jsx` tab "**Yana hard stops**" → "**Hamilton hard stops**" (the panel already renders `<AdminHamiltonHardStops/>`); `src/components/pipeline/GrantCard.jsx` comment "Yana — application-completion agent" → "Hamilton".

**B3 — environment recovery.** Killed the 8 zombie pre-rename test processes and re-ran `npm ci` cleanly (restored `better_sqlite3.node`).

> Not fixed here (out of window / by design): B2 and B4 are flagged for follow-up rather than patched, to avoid touching the shared test runner under a security-focused branch. See §8.

---

## 4. Tests added

| File | Tests | Proves |
|---|---|---|
| `tests/unit/hamilton-route-auth.test.mjs` | 8 | Real router mounted via supertest. Unauthenticated session/payment reads → 401; cross-profile read → 403; own-profile read → 200; **cross-profile session revoke → 403 and the row stays un-revoked**; cross-profile payment-auth create → 403; cross-profile resolved-fields read → 403; portal-policy write non-admin → 403, canonical admin → 200. |
| `tests/unit/yana-hamilton-naming.test.mjs` | 3 | Admin hard-stop tab says "Hamilton" not "Yana"; GrantCard doesn't call Yana the application-completion agent; `backend/services/yana` dir is gone and `hamilton*` route/engine exist. |

Both files run green (`node --test`): 8/8 and 3/3. They are picked up by `npm run unit` (node:test count rose 2239 → **2250**).

---

## 5. Migration integrity (verified)

- **Runner correctness** (`backend/db/migrate.js`): orders by *full filename* (`readdirSync().sort()`); idempotency keyed on the **full filename** in `_migrations(name UNIQUE)`. Postgres path is strict (never swallows DDL errors); SQLite swallows only "already-applied" idempotent errors by design.
- **Duplicate-prefix pairs are benign.** SQLite `078/079/080` and Postgres `0074/0075/0076` each have two files creating **disjoint** tables (`onboarding_sessions` vs `anya_onboarding_events`; `pricing_quotes` vs `school_partners`; `profile_pricing` vs `sam_runs`), all `CREATE TABLE IF NOT EXISTS`. Because tracking is by full filename, **both files in each pair apply** — confirmed in the fresh DB (`_migrations` contains all six `078/079/080*` rows). The `086`/`0082` gap is harmless (runner iterates files present, not a contiguous sequence).
- **Fresh SQLite migrate from empty DB** → exit 0, 99 migrations. yana→hamilton rename (`090`) leaves **no orphan `yana_*` tables** (cleanup works); 11 `hamilton_*` tables present; `agent_activity_events`, all 5 `agent_control_*`, `hamilton_blockers`, `school_partners`, `onboarding_sessions`, `sam_runs`, `profile_pricing` all created — so `MIGRATE_ON_BOOT` (now default-on, commit `6b365082`) does provision agent telemetry/control/Hamilton tables.

---

## 6. Commands run — pass/fail

All run on `audit/last-72h-mission-optimization`, Windows 11, Node 22.21.1, after a clean `npm ci`.

| Gate | Command | Result |
|---|---|---|
| install | `npm ci` | **PASS** (1028 pkgs; first attempt EPERM-failed on a zombie-locked native binary — see B3 — passed after killing the leak) |
| auth middleware | `npm run auth-middleware:check` | **PASS** |
| profile guards | `npm run profile-guards:check` | **PASS** |
| profile metadata | `npm run check:profile-metadata` | **PASS** (`OK (designated seeds)`) |
| runtime imports | `npm run runtime-imports:check` | **PASS** (407 backend-reachable files inside runtime image) |
| lint | `npm run lint` | **PASS** (zero warnings, incl. edited files) |
| typecheck | `npm run typecheck` | **PASS** |
| build | `npm run build` | **PASS** (6.6s; confirms esbuild/Vite 8 pin) |
| unit | `npm run unit` | **PASS** — `UNIT_EXIT=0`; node:test **2250/2250**, vitest **329 files / 746 tests**. (Cosmetic B4 noise present, gate still green.) |
| crawler doctor | `npm run crawler:doctor` | **PASS** (`API smoke OK` / `OK`) |
| national minimum | `npm run opps:check-national-minimum` | **PASS** (count 35 ≥ min 3; CA zip-scoped returns 3 national real) |
| fresh migrate | `SQLITE_DB_PATH=… npm run migrate` | **PASS** (exit 0, 99 migrations, no orphan yana_*) |
| new test (auth) | `node --test tests/unit/hamilton-route-auth.test.mjs` | **PASS** 8/8 |
| new test (naming) | `node --test tests/unit/yana-hamilton-naming.test.mjs` | **PASS** 3/3 |
| smoke | `npm run smoke` | **SEE §7** |

---

## 7. Live / browser checks

- `npm run smoke:install` — chromium already present (`ms-playwright/chromium-1208` etc.); install step not required.
- `npm run smoke` — **9 passed / 1 failed (env, not a regression).** The single failure is `admin-tools-button-live.spec.mjs:35` → `expect(me.status, '/api/auth/me should authenticate admin token').toBe(200)`. The test falls back to the placeholder token `'test-admin-token'` when **`SMOKE_ADMIN_TOKEN`** (or `ADMIN_TOKEN`) is unset, and that placeholder is not a valid admin token, so `/api/auth/me` returns non-200. Unrelated to the changes in this audit (no edit touches `/api/auth/me`, the Admin Tools FAB, or token auth). Re-run with `SMOKE_ADMIN_TOKEN` set to clear it.
- `npm run e2e` — **NOT RUN in this pass** (heavier full-server+browser suite; deferred to keep this branch focused on the security fix. Prerequisites are present locally.)
- `npm run smoke:mission` — **SKIPPED, not faked.** Requires live creds, all unset:
  `GRANTFLOW_BASE_URL`, `GRANTFLOW_TEST_EMAIL`, `GRANTFLOW_TEST_PASSWORD`. Re-run with those set against a deployed env to exercise the mission path end-to-end.

---

## 8. Remaining caveats / follow-ups

1. **B2 (anyaTestRepair in the unit gate).** Disable/quarantine the auto-repair step inside `npm run unit` so a release gate can never mutate tests. (Did nothing this run, but it should not be in the gate.)
2. **B4 (scoring-consolidation double-collection).** Exclude `node:test` files from the vitest glob (or move the file) to remove 23 misleading "not ok" TAP lines.
3. **Ingestion reality-gate sweep (out of window).** `routes/opportunities.js` / `routes/crawlers.js` contain raw `INSERT INTO funding_opportunities`. They were not modified in this 72h window, but a dedicated pass should confirm every ingestion INSERT sets `reality_status` and that no user-visible active opportunity bypasses `assessReality`.
4. **e2e + smoke:mission not exercised** here (see §7). Run before promoting if the deploy touches the autopilot browser path.
5. **Leaked-process hygiene (B3).** The Hamilton/Yana browser-automation tests can leave detached node processes on Windows; ensure their teardown kills spawned Playwright/Chromium children.

---

## 9. Release recommendation

### READY WITH CAVEATS

**Why ready:** all 11 runnable local gates pass; migrations are deterministic and idempotent (fresh-DB verified, duplicate prefixes proven safe, no orphan `yana_*`); Yana/Hamilton naming is clean on user-facing surfaces (regression-guarded); Agent Control Center is canonical-admin-only with single-flight locks, full lifecycle transitions, and dual canonical-admin notifications (existing tests, all green); school-portal merges + matches run through the canonical matcher with consent + non-destructive merge + hashed keys; crawler/profile self-heal and partial-geo classification are in place and tested; UI does not fabricate match decisions; the reality-gate / inserter / matcher / pipeline-enum contracts hold for in-window changes.

**Why "with caveats":** the **CRITICAL B1 cross-profile/auth gap was found and fixed *on this branch*** — it must be merged (with the two new test files) before release; this branch is the thing that makes it ready. Plus the §8 follow-ups (test-runner hygiene B2/B4, an out-of-window ingestion reality-gate sweep, and the un-run e2e/`smoke:mission` live checks).

**Blocker if not merged:** shipping `6b365082` (pre-audit HEAD) **as-is is NOT READY** — it carries the unauthenticated cross-profile B1 vulnerability.
