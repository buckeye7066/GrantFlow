# GrantFlow Production Readiness Report — 2026-07-01

Fresh full-pass verification (regressions, new issues, gaps missed by prior passes).
Baseline: `origin/main` @ `9d639489` (immediately after dependency-bump PRs #808 and #809 —
40 dev-dep updates and 23 major runtime bumps — making this pass a timely regression check).
Branch later rebased onto `8b24742c` (CI-action + jsdom dev-dep chores only, #810–#812); deps
reinstalled and unit suites re-verified after the rebase.

**Verdict: production-ready, with the fixes in this PR applied.** No Critical findings. One High
(crawl-fetcher hang, fixed), four Medium (two fixed in code, env-example drift fixed + now CI-gated),
rest Low/Info (fixed or documented). 0 npm-audit vulnerabilities even after the major bumps. All
gates pass locally except known-environmental test flakes (documented in §6); CI is the final arbiter.

## 1. System Map

- **Frontend** (`src/`): React 18 + Vite 8 + Tailwind + Radix UI; state in Zustand; API via `src/api/`.
  Deployed to **Vercel** (auto-deploy from `main`).
- **Backend** (`backend/`): Express 5 (upgraded from 4.x, 2026-07-02 — see §9), ~30+ route files (`backend/routes/`), services (`backend/services/`),
  DB shim (`backend/db/`), boot tasks (`backend/startup/` — `ensureSchemaInvariants.js` then `enforceInvariants.js`).
  Entry `backend/server.js` via `backend/start.js`. Deployed to **Railway** (project `kind-flexibility`,
  service `GrantFlow`; auto-deploy from `main`; **ephemeral filesystem** — uploads stored as BYTEA in Postgres).
- **DB**: SQLite locally/tests, PostgreSQL in prod through a dialect shim with a
  `KNOWN_BOOLEAN_COLUMNS` boolean-rewrite allowlist (match_* columns are TEXT — intentional).
  Migrations: `backend/db/migrations/` (130 files), runner `backend/db/migrate.js` sorts by full
  filename (deterministic despite duplicate numeric prefixes).
- **AI/agents**: Claude + OpenAI; agent fleet Amy/Anya/Sam/Yana/John/Hamilton/Robert
  (crawling, coverage, outreach drafting, portal automation). John creates Outlook DRAFTS only —
  nothing auto-sends.
- **Crawler OS**: `backend/crawler-os/` (registry/planner/fetcher/parser/matcher/storage), own
  node:test `.mjs` suite.
- **CI** (`.github/workflows/ci.yml`): two required checks on `main` (branch protection ON):
  - `test`: npm ci → vite build → corruption detector → secret scan → `npm audit --omit=dev --audit-level=high`
    (blocking) → `release:gates` (spawn-based runner, real exit-code propagation — no &&-masking) →
    Playwright smoke (non-blocking, needs a DB).
  - `postgres-migrations`: full migration chain against ephemeral PG 16 + idempotency re-run +
    canonical schema verification.
  Other workflows: codeql, prod-smoke, sam-autofix, anya-code-fix-pr, auto-merge-recent-prs,
  merge-all-branches, delete-stale-branches, claude, apply-godaddy-vercel-dns.
- **Env**: `.env.example` (root) + `backend/.env.example`; enforced by `scripts/check-env-examples.mjs`
  (runs in prepush chain).

## 2. Baseline Verification (commands run individually; exit codes checked)

| Command | Result | Notes |
| --- | --- | --- |
| `npm ci` | PASS (exit 0) | lockfile applied cleanly; no drift, no `npm install` fallback needed |
| `npm run lint` | PASS (exit 0) | zero warnings |
| `npm run typecheck` | PASS (exit 0) | |
| `npm run unit` | MOSTLY PASS | node:test half: 1 flake (`agent-control-locks`, passed in isolation and on re-run); vitest half: 4 environment-dependent failures reproduced identically on pristine main (live web-search timeouts in local sandbox) — see §3/§6 |
| `npm run crawler-os:test` | PASS (exit 0) | 220/220 node:test |
| `npm run build` | PASS (exit 0) | Vite production build, 17.7s |
| `npm audit` (and `--omit=dev`) | PASS | **0 vulnerabilities** (both full and prod-only) |
| `node scripts/check-env-examples.mjs` | **FAIL (exit 1)** | checked-in `.env.example` files drifted from generator — see Finding M1 |
| Migration file review | PASS (read-only) | 130 files; full-filename sort ⇒ deterministic order; duplicate numeric prefixes (047, 054, 068, 069, 078, 079, 080, 110, 127) are cosmetic only; newest (128, 129) sane; CI replays chain + idempotency on PG 16. No migrations were run against any real DB. |

## 3. Findings (by severity)

### High
- **H1 — Production crawl fetcher had NO request timeout.**
  `backend/services/crawlerOsService.js:92` — `doFetch: (url, init) => fetch(url, init)`; the Crawler-OS
  fetcher (`backend/crawler-os/fetcher.js`) explicitly delegates deadlines to the host `doFetch`, which
  supplied none. Native fetch/undici waits forever on a half-open remote, so one hung page wedged an
  entire `runProfileDiscoveryLive` run and pinned a `MAX_CONCURRENT_CRAWLERS` slot. Reachable from the
  daily discovery loop, Robert/Amy/Anya agent runs, and login-triggered discovery. **FIXED** (F5).

### Medium
- **M3 — `/api/ai/comprehensive-match` and `/api/ai/ecf-service-search` missing profile-ownership check.**
  `backend/routes/ai.js` (~:174, ~:256) took `profile_id` from the request body and used it in the
  `funding_opportunities` isolation clause with no `ensureProfileAccess` — unlike every sibling route in
  the same file. An authenticated non-admin could read another profile's private crawl-discovered
  opportunity rows (limited sensitivity: grant rows, not PII/credentials). The scopedQuery net does not
  cover `funding_opportunities`. **FIXED** (F4).
- **M4 — Systemic: ~284 route-level catch blocks return raw `err.message` on 500** across ~45 route
  files (e.g. `backend/routes/accessGate.js:49`, `ai.js:243`), bypassing `middleware/errorHandler.js`'s
  production redaction and leaking DB/driver internals to clients. **FIXED at the choke point** (F6) —
  per the repo's own invariant philosophy — rather than editing 284 call sites.
- **M1 — Checked-in `.env.example` files drifted from the generator.** `node scripts/check-env-examples.mjs`
  fails (exit 1): ~45 referenced env vars missing from `.env.example` + `backend/.env.example`
  (e.g. `ADMIN_OPS_EMAIL`, `YANA_BACKLOG_ENRICH_LIMIT`, `WEB_DISCOVERY_MODEL_*`, `SAM_DAILY_CODE_SWEEP_*`).
  Contributors copying the examples miss required config; violates the repo's own traceability rule.
- **M2 — The env-example drift check runs nowhere in automation.** `check:env-examples` exists only in
  `check:prepush` (package.json:27), which no git hook or CI job invokes (`.githooks/pre-push` runs eslint
  only and `core.hooksPath` is unset). CI's `release:gates` never runs it — which is exactly how M1 happened.

### Low
- **L5 — `realFundingCrawler` timeout was a silent no-op** (`backend/services/realFundingCrawler.js:51`):
  passed node-fetch-style `timeout: 60000` to native fetch, which ignores it; the node-fetch fallback on
  line 22 was also broken (assigned a Promise, not a function). **FIXED** (F5).
- **L6 — Legacy connectors fetch with no deadline** (`backend/services/connectors/`:
  grantsGov, samGov, usaspending, stateOpenData, benefitsGov, clinicalTrials — node-fetch v3, no default
  timeout). Reached mainly from admin/discovery routes. **FIXED** (F5).
- **L7 — Hamilton autopilot could leak a Chromium process on the setup path**
  (`backend/services/hamilton/hamiltonAutopilotEngine.js:562-573`): `newContext()`/`newPage()` ran
  before the `try` whose `finally` closes the browser — a throw there (e.g. /dev/shm memory pressure)
  leaked the launched browser, compounding the very memory pressure that causes it. **FIXED** (F7).
- **L8 — Password-setup link (embeds the token) logged via `console.warn`**
  (`backend/services/emailFallback.js:32`). Dev-only in practice (prod auth routes error out before this
  fallback), but a token-in-logs pattern. **FIXED** (F8) — now gated to non-production.
- **L9 — JWT verification did not pin algorithms** (`backend/middleware/authIdentity.js:151`,
  `backend/routes/auth.js:317`): `jwt.verify(token, secret)` with no `{ algorithms: ['HS256'] }`. All
  GrantFlow tokens are HS256; pinning is cheap insurance against algorithm confusion. **FIXED** (F9).
- **L1 — Unescaped interpolation in print-iframe HTML.** `src/hooks/useGrantTools.js:203` interpolates
  `grant.source_url` raw into `document.write` HTML while sibling fields (lines 181–182, 197) use
  `escapeHtml()`. Backend-sourced data, hidden print iframe — low impact, but inconsistent and a
  break-out vector into the printed document.
- **L2 — Print sheet reads `grant.sponsor` only.** `useGrantTools.js:167,175` — pipeline grants use the
  `funder` column (funding_opportunities use `sponsor`); every other consumer falls back
  (`sponsor || funder`, cf. `AnyaFundingMatchCard.jsx:44`, `SearchResults.jsx:350`). Printed sheet shows a
  blank sponsor for pipeline grants.
- **L3 — Auto-merge workflows don't require any check to have actually run.** `auto-merge-recent-prs.yml`
  / `merge-all-branches.yml` gate on "no failing/pending checks + 1 approval" — an empty
  `statusCheckRollup` passes the script filter. Mitigated in practice: `gh pr merge --auto` still honors
  branch protection, and required contexts on `main` were verified live as `["test","postgres-migrations"]`
  (matches the actual job names). **RESOLVED (owner-approved follow-up, 2026-07-02):** both workflows now
  require the required contexts `test` and `postgres-migrations` to be PRESENT and SUCCESSFUL in the
  rollup before queuing a merge — an empty/absent rollup is treated as a failure and the PR is skipped.
- **L4 — Duplicate numeric migration prefixes** (047, 054, 068, 069, 078, 079, 080, 110, 127). Harmless:
  `backend/db/migrate.js:75-77` sorts by full filename, so order is deterministic and already baked into
  every prod migration ledger. Do NOT renumber (would re-run under new names). Cosmetic only.

### Info
- **I1 — One bare `console.log` ships to prod** (`src/components/proposals/SubmissionAssistant.jsx:110`);
  the repo convention is the DEV-gated `src/utils/logger.js`. Vite build does not drop console calls.
- **I2 — CI's Playwright smoke step is non-blocking** (`continue-on-error: true`) — intentional and
  documented (needs Postgres, not available in CI).

### Test-suite observations (local)
- `tests/unit/agent-control-locks.test.mjs` failed once under the full parallel node:test run
  (timing-sensitive lock-contention assertions), passed 14/14 in isolation and on the full re-run —
  **flake**, not a regression.
- 4 vitest tests fail **locally** in `backend/tests/crawlerOsCrossProfileMatch.test.js` (2) and
  `backend/tests/robertDiscoveryDryRunAndDegradation.test.js` (2) — 20s test timeouts. Verified
  **identical failures on pristine origin/main** (changes stashed): `runProfileDiscoveryLive`'s web
  lane makes live DuckDuckGo searches (8s timeout each) that hang/fail in this sandboxed local network.
  Environmental; these pass in CI (main is green under branch protection). CI on this PR is the
  authoritative arbiter.

### Clean areas verified (no findings)
- npm audit: 0 vulnerabilities (full and prod-only) — immediately after 23 major bumps in #809.
- Frontend XSS: single `dangerouslySetInnerHTML` is a static CSS constant; all other print/invoice
  `document.write` sinks HTML-escape interpolations (except L1); no `eval`/`new Function`.
- No secrets in `src/`, vite config, or `VITE_*` vars; Sentry DSN is a publishable client value.
- `backend/start.js` registers `unhandledRejection` (log+Sentry, stay alive — documented) and
  `uncaughtException` (log+Sentry, flush, force-exit) handlers.
- `release-gates.mjs` propagates exit codes correctly (spawn + reject); no `|| true` masking in gating
  scripts; `&&`-chains in `test`/`check:prepush` fail fast correctly.
- Branch protection on `main` verified live: required contexts `test` + `postgres-migrations`, matching
  the CI job names.
- (Backend security + agent/crawler audit results appended below when their sections say so.)

## 4. Fix Plan (written before code edits)

1. **M1**: run `node scripts/generate-env-examples.mjs`, verify placeholders-only (no secrets), commit.
2. **M2**: add `check-env-examples.mjs` as a gate in `scripts/release-gates.mjs` (runs in CI via
   `release:gates`), so drift fails CI from now on.
3. **L1+L2**: `useGrantTools.js` — escape `source_url` in the footer; use `sponsor || funder` fallback
   in the two header/detail fields (matches existing consumer pattern; behavior-preserving).
4. **I1**: route the stray `console.log` through the DEV-gated logger convention.
5. Anything surfaced by the backend-security and agent/crawler audits: triage — smallest correct
   change for Critical/High; document Medium/Low if fix risks behavior change.
6. L3, L4, I2: document only (no code change warranted).

## 5. Fixes Implemented

| # | Finding | Change | Files |
| --- | --- | --- | --- |
| F1 | M1 | Regenerated env examples via `scripts/generate-env-examples.mjs` (placeholders only, no secrets); includes the new `CRAWLER_FETCH_TIMEOUT_MS` from F5 | `.env.example`, `backend/.env.example` |
| F2 | M2 | Added `check-env-examples.mjs` as gate 0b in the release-gates runner (now enforced in CI) | `scripts/release-gates.mjs` |
| F3 | — | (documentation only: L3, L4, I2 — no code change warranted) | — |
| F4 | M3 | `ensureProfileAccess` ownership gate on `/api/ai/comprehensive-match` + `/api/ai/ecf-service-search`, matching sibling routes | `backend/routes/ai.js` |
| F5 | H1, L5, L6 | `fetchWithTimeout` wrapper (default 30s, `CRAWLER_FETCH_TIMEOUT_MS` override, `AbortSignal.any` merge with caller signal) on `makeProductionFetcher`; `AbortSignal.timeout` on `realFundingCrawler` (replacing the no-op `timeout:` option and the broken node-fetch fallback) and on all 6 legacy connectors | `backend/services/crawlerOsService.js`, `backend/services/realFundingCrawler.js`, `backend/services/connectors/*.js` (6 files) |
| F6 | M4 | Production-only 500-detail redaction at the existing response-envelope choke point: string `error`/`message`/`detail`/`details` replaced with `Internal server error`, `stack` dropped, original logged server-side with request id. Statuses ≠ 500 (503 catalog_busy, 504 timeout) untouched; dev/test unchanged | `backend/utils/responseEnvelope.js` |
| F7 | L7 | Browser-close guard around `newContext()`/`newPage()` setup in Hamilton autopilot | `backend/services/hamilton/hamiltonAutopilotEngine.js` |
| F8 | L8 | Password-setup link log gated to non-production | `backend/services/emailFallback.js` |
| F9 | L9 | `{ algorithms: ['HS256'] }` pinned on both `jwt.verify` sites | `backend/middleware/authIdentity.js`, `backend/routes/auth.js` |
| F10 | L1, L2 | Escaped all plain-text interpolations in the grant print sheet; `sponsor \|\| funder` fallback (matches other consumers) | `src/hooks/useGrantTools.js` |
| F11 | I1 | Stray `console.log` routed through the DEV-gated client logger | `src/components/proposals/SubmissionAssistant.jsx` |

### Tests added
- `backend/tests/crawlerFetchTimeout.test.js` (3 tests): hung remote aborts within the configured
  deadline; fast responses pass through; caller-provided AbortSignal still honored.
- `backend/tests/responseEnvelope.test.js` (+3 tests): 500 detail redacted in production (and original
  logged server-side); non-production unredacted; intentional 503 messages untouched in production.

## 6. Final Verification (after all fixes; commands run individually)

| Command | Result |
| --- | --- |
| `npm run lint` | PASS (exit 0, zero warnings) |
| `npm run typecheck` | PASS (exit 0) |
| `node scripts/run-unit-tests.mjs` (node:test half of `unit`) | PASS (2753 pass / 0 fail / 12 skip) |
| `npm exec -- vitest run` (vitest half of `unit`) | 2280 pass / 7 fail / 5 skip — **all 7 failures are local-environment flakes**: 4 are the network-dependent discovery tests that fail identically on pristine origin/main (see §3 test-suite observations); 3 (hamiltonFullProposalGenerator ×1, hamiltonPacketBilingual ×2) fail only under full parallel load and pass 18/18 in isolation with the fixes applied. New/changed-behavior suites verified directly: `responseEnvelope.test.js` 8/8, `crawlerFetchTimeout.test.js` 3/3, `pipelineExclusionSectionAwards.test.js` (covers patched comprehensive-match) 8/8. CI ("test" required check) is the authoritative gate. |
| `npm run deployment-config:check` + corruption guards | PASS (exit 0) |
| `npm run crawler-os:test` | PASS (220/220) — pre-fix run; crawler-os untouched by fixes |
| `npm run build` | PASS (exit 0) |
| `node scripts/check-env-examples.mjs` | PASS (exit 0) |
| auth-middleware / profile-guards / runtime-imports / safe-sql / profile-scope / scan:secrets | ALL PASS (exit 0) |

## 7. Remaining Risks / Human-Approval Items

- **Owner-config items from the June 2026 pass remain** (backups/legal/retention, Sentry DSN) — owner
  scope, not code.
- **`funding_opportunities` and `organizations` SQL-bleed net — RESOLVED (owner-approved, 2026-07-02).**
  `backend/db/scopedQuery.js` now covers both tables with tier-appropriate enforcement (chosen after
  auditing all ~255 `funding_opportunities` call sites and every request-path `organizations` query):
  - **`organizations` → strict org-scoped tier.** The table has NO `profile_id` column (tenancy links
    through `profiles.organization_id` / `user_organizations`), so the profile_id-predicate rule cannot
    apply. Instead, under a non-admin request with an active profile claim, SELECT/UPDATE/DELETE must be
    row-targeted (`id = ?` / `id IN (...)`) or reached through the owning-row linkage (an
    `organization_id` equality/join); INSERT (org creation) reads nothing and is allowed. Violations
    THROW by default (`ProfileScopeError`), same escape hatch as the core tier (`PROFILE_SCOPE_MODE=warn`).
    Every existing request-path query already satisfies this (verified: organizations list route adds
    `id IN (accessible set)` for non-admins; wholesale COUNT/scan sites are admin-gated or boot/agent
    contexts that bypass the guard) — so this is pure hardening, no behavior change.
  - **`funding_opportunities` → dual-scope tier.** The table is deliberately dual-scope: `profile_id IS
    NULL` rows are the shared global crawl catalog, non-NULL rows are profile-private (canonical clause
    `(profile_id IS NULL OR profile_id = ?)`). Blind inclusion in the strict net would have broken the
    product: catalog browse and matching scans legitimately read the whole catalog today. Enforcement:
    **writes (UPDATE/DELETE) are strict** — a wholesale write under a non-admin tenant claim throws;
    row-targeted writes (id / fingerprint / source_id / canonical_opportunity_key / profile_id predicates,
    or `profile_id IS NULL` global maintenance) pass; INSERT (crawl ingestion of global rows, including
    request-initiated discovery) is allowed. **Reads are an observability tier** — unscoped catalog-wide
    reads under a tenant claim are counted on the request context (`profileBleed` + samples) and warn-logged
    (deduped per route+op to keep prod logs readable), NOT blocked; flip `PROFILE_SCOPE_FUNDING_READS=strict`
    once the drift list retires. All wholesale writers were verified boot/background/admin-only
    (deadlineExpiryService: server boot scheduler; anyaHealthService: admin route + startup service;
    remove-loans: admin/bulk-key gate; ensureMinimumNationalOpportunities: selfHeal/boot), so strict
    writes cannot break existing flows. Guard tests extended: `tests/unit/scoped-query.test.mjs`
    (32 tests, +21 new covering both tiers).
- **Local-only test flakes**: `agent-control-locks` (parallel-run timing) and the 4 network-dependent
  discovery tests (sandboxed local network). Consider stubbing the web-search lane in those tests so
  local runs are hermetic.
- **F6 behavior note**: in production, HTTP-500 bodies now always say `Internal server error` in their
  string `error`/`message` fields (this already was the central errorHandler's prod contract; route-level
  catches previously violated it). If any client flow string-matches specific 500 error text, it would
  see the generic text instead — none found in `src/`.
- Do-not-touch items preserved: matching thresholds, eligibility rules, normalizer patterns, Stripe
  behavior, auth rules, agent product behavior, John draft-only invariant (verified no send paths),
  KNOWN_BOOLEAN_COLUMNS shim, BYTEA upload pattern.

## 8. Manual checks still required

- Node version for `AbortSignal.any` (≥ 20.3): Dockerfile uses `node:20-slim` (current 20.x — fine) and
  CI uses Node 20. No action expected; noted for completeness.
- Post-deploy: watch one scheduled discovery cycle for `[envelope] redacted 500 response detail` log
  lines (each one identifies a route-catch leak site now being redacted) and for crawl-fetch timeout
  aborts (`TimeoutError`) replacing formerly-hung slots.
- ~~Optional: extend `PROFILE_SCOPED_TABLES` (see §7) after a dedicated review.~~ DONE 2026-07-02
  (dual-scope + org-scoped tiers, see §7). Post-deploy: watch for `[profile_bleed]` log lines with
  `"tiers":["funding_read"]` — each identifies a catalog-wide read under a tenant claim to retire
  before flipping `PROFILE_SCOPE_FUNDING_READS=strict`.

## 9. Dependency majors taken (owner-approved, 2026-07-02 — second PR of the follow-up pair)

The two deliberately-deferred majors from the dependency-bump review were taken as a mechanical
upgrade validated by the full test suite. No payment behavior, prices, products, auth rules, or
public API shapes were changed.

### Express 4.22.2 → 5.2.1

Full route-pattern audit (grep of every `.get/.post/.put/.delete/.patch/.all/.use/.options` path
string across `backend/routes/`, `backend/server.js`, `backend/middleware/`, `backend/apply/`)
found exactly four Express-5 incompatibilities, all fixed:

| Site | v4 form | v5 fix |
| --- | --- | --- |
| `backend/server.js` SPA fallback | `app.get('*', …)` | `app.get('/{*splat}', …)` (braced so it matches `/` too) |
| `backend/server.js` CORS preflight | `app.options('*', …)` | `app.options('/{*splat}', …)` |
| `backend/routes/opportunities.js` GET/PUT/DELETE `/:id(<uuid-regex>)` ×3 | inline param regex (removed in path-to-regexp v8; throws at route registration) | plain `/:id` + in-handler `requireUuidParam()` returning the same 404 non-matches used to get; static `/meta/*` and `/geo/*` routes register earlier so precedence is unchanged |
| `backend/server.js` query parsing | v5 default parser changed `'extended'` → `'simple'` | pinned `app.set('query parser', 'extended')` to preserve v4 nested/array query semantics |

Audited and confirmed absent: `app.del`, `res.sendfile`, `req.param()`, `res.redirect('back')`,
writable-`req.query` assignments, two-arg `res.json(status, body)`, optional-`?` route params,
bare `req.body.x` access in GET/DELETE handlers (v5 leaves `req.body` undefined when nothing was
parsed). `express.urlencoded` is used once (smsInbound) with an explicit `extended: false`.
express-rate-limit 8.x supports Express 5. Promise-rejection forwarding to error middleware is new
v5 behavior and strictly an improvement (errorHandler is already registered last).

**Runtime verification** (not just tests): server booted locally on SQLite; `/readyz` + `/healthz`
returned 200, CORS preflight 204, SPA fallback served `dist/index.html` at `/` and at deep links,
non-UUID `/api/opportunities/:id` returned 404 as before.

### Stripe SDK 20.4.1 → 22.3.0

Actual SDK surface used (exhaustive grep): `stripe.customers.create`,
`stripe.checkout.sessions.create`, `stripe.prices.retrieve`, `stripe.webhooks.constructEvent` —
all stable across the 21/22 majors, which principally move the SDK-pinned default API version and
raise the Node floor to 18 (runtime is Node 20+). The client is constructed without an explicit
`apiVersion` (SDK default, by design — comment preserved in `backend/services/stripeService.js`);
webhook raw-body handling and idempotent event processing are unchanged. Billing suites pass
(19/19: billingRoutes, billingAccounts, billingEffective).

### Verification (each gate run individually, post-upgrade)

- lint PASS, typecheck PASS, build PASS
- node:test half: 2765 tests, 2753 pass, 0 fail, 12 skip
- vitest half: 2278 pass / 9 fail — the documented environmental set only (4 network-dependent
  discovery tests + hamiltonFullProposalGenerator / hamiltonPacketBilingual / anyaAutoRepairService
  parallel-load flakes, re-verified 44/44 in isolation)
- static gates: env-examples, profile-scope, safe-sql, deployment-config all PASS
- Dependabot reference PRs #815/#814 closed in favor of this change (dependabot's lockfile-only
  express bump had failing CI — the route-syntax fixes above were required).
## 10. Addendum — owner comms & scheduling verification pass (2026-07-02)

Verification-first sweep of the five owner-requested comms behaviors (evidence pulled from prod
telemetry via read-only in-container queries):

| # | Requirement | Existed? | Enabled in prod? | Evidence | Gap fixed in this PR |
|---|---|---|---|---|---|
| 1 | Yana→John daily leads→Drafts (cap 50, FROM Ellie@axiombiolabs.org, never auto-send) | Yes | Yes (`JOHN_ENABLED`/`JOHN_RUN_ON_SCHEDULE`, daily 05:30 ET) | `john_runs` scheduled rows 06-29/06-30/07-01; drafts carry `actual_from: Ellie@axiombiolabs.org`, `alias_send_supported: true`; cap defaults 50/24h; Ellie mailbox confirmed real via Graph (200 on `/users/Ellie@…/messages`) | Nothing to fix (volume is lead-supply-limited, not cap-limited). Owner-side: SendAs grant + `User.Read.All` remain optional polish (see §10.1) |
| 2 | Sam nightly sweep → ONE Anya morning email (09:00 ET) | Yes | Yes (`SAM_DAILY_CODE_SWEEP_ENABLED`, `ANYA_DAILY_REPORT_ENABLED`) | `system_kv` markers + `sam_runs` (2026-07-02 run `sam-mr2zetbz-qsfnrz`); Anya summary `sent:true, to: owner` — exactly one/day via day-key marker | **Midnight-hour bug fixed**: Node 20 ICU renders midnight as hour `"24"`, so a tick in 00:00–00:59 ET opened the whole day's windows (Sam 05:00 sweep + Anya "09:00" email both fired ~00:05 ET on 2026-07-02). New `backend/utils/etTime.js` clamps it; all six server.js ET schedulers now share it. `SAM_RUN_ON_SCHEDULE=false` is INTENTIONAL (retired legacy 04:00-UTC cron superseded by the 05:00 ET sweep) — left off |
| 3 | Weekly Monday 09:00 ET per-ACTIVE-profile update, AUTO-SEND | Partially (Hamilton weekly digest Mon 08:00 ET — but DRAFT-only into owner mailbox) | Yes (ran 2026-06-29: 19 drafted, 0 errors) | `system_kv` `hamilton_weekly_digest_last_run(_summary)` | Added `HAMILTON_WEEKLY_DIGEST_DELIVERY=send` mode: auto-sends each active profile's digest via the comms channel (Resend), audited in `comms_broadcasts(_recipients)` kind `weekly_digest`. Default stays `draft`; prod env set to `send` + hour `9`. "Active" = profile status not deleted/suspended, excluding `agent:amy` synthetics |
| 4 | Friday 09:00 ET invoices; per-profile weekly / every-other-week / monthly cadence | Yes (weekly Fri + semimonthly + monthly-on-the-1st; `billing_cadence` field + `PUT /api/billing/me/:id/cadence`) | Yes (`BILLING_AUTOMATION_ENABLED=true`) | `billing_invoices`: 19 sent for `weekly:2026-06-26`; all 23 accounts `weekly` | Added `biweekly` (every OTHER Friday 09:00 ET, parity anchored to persisted `billing_anchor_at` / fixed epoch `2026-01-02` — redeploy-stable); `monthly` moved to FIRST FRIDAY 09:00 ET (0 monthly accounts in prod → no period-key collisions); cadence select added to the Billing page (was API-only) |
| 5 | Auto reminders for unpaid/overdue invoices | Yes (dunning: second notice ≥3 days unpaid; suspend after one full billing cycle, only when a payment path exists) | Yes (same gate as #4) | `billing_invoices`: `second_notice` row 2026-06-26; 10 `suspended` from `weekly:2026-06-19` | Nothing to fix; `cadenceCycleDays` already handles `biweekly` (14d) |

### 10.1 Owner-side (cannot be done from this repo)

- **Send-as-Ellie at MANUAL send time**: Graph accepts `from: Ellie@axiombiolabs.org` on draft
  creation today (drafts verified). For the manual send from dr.johnwhite's Drafts to go out as
  Ellie, Exchange needs a Send-As grant: M365 admin center → Users → Ellie → Mail → *Send as*
  → add `dr.johnwhite@axiombiolabs.org` (or PowerShell:
  `Add-RecipientPermission "Ellie@axiombiolabs.org" -Trustee "dr.johnwhite@axiombiolabs.org" -AccessRights SendAs`).
- **App-registration `User.Read.All` (application) + admin consent** would let John's alias
  verifier read the mailbox object (today its directory-lookup step 403s — cosmetic; drafting works).

### 10.2 Idempotency / cadence design decisions

- All schedulers remain persisted-checkpoint (Postgres `system_kv` day/week markers + scheduler
  locks + hourly catch-up); invoices are unique on `(profile_id, period_key)` — Railway
  mid-schedule redeploys can neither skip nor double-send.
- Biweekly parity is a pure function of the persisted anchor (never "now"), so restarts cannot
  flip which Friday an account is billed.
- Do-not-touch items preserved: matching thresholds untouched; John remains draft-only.
