# GrantFlow — Codebase Audit

> Read-only audit. No source files were modified. Findings are grouped by file and tagged
> **critical** / **important** / **nit**, each with a `file:line` reference.
> Generated 2026-06-19.

> **Historical snapshot — not current release evidence.** This report records the
> repository as it existed on 2026-06-19. Many findings below have since been
> remediated or moved behind fail-closed controls, and line references have drifted.
> Reproduce a finding against the current commit before relying on it. In particular,
> current-tree admin authority is environment- and database-backed, public profile
> fixtures are synthetic, and deployed designated-profile data requires a private
> manifest. Public Git history may still retain retired identifiers and remains a
> separate owner/privacy-counsel decision.

---

## 1. Repository Map

### Languages & frameworks
- **Frontend** (`src/`): React 18 + Vite 8 + TypeScript (JS/JSX-heavy) + Tailwind + Radix UI. State via Zustand (`src/stores/`). Data fetching via TanStack Query. API access through `src/api/`.
- **Backend** (`backend/`): Express 4 (ESM), Node 20–22. 78 route files (`backend/routes/`), 412+ service files (`backend/services/`), `pg` (PostgreSQL) + `better-sqlite3` (legacy/local). Entry: `backend/start.js` → dynamic-imports `backend/server.js`.
- **AI**: `@anthropic-ai/sdk` (Claude) + `openai`. Prompt templates in `backend/prompts/`.
- **Crawlers**: Grant ingestion (Grants.gov, NIH, USASpending, geo crawls) in `backend/services/crawlers/`, `backend/scripts/`, top-level `scripts/`.
- **Shared** (`shared/`): cross-cutting helpers used by both tiers.
- **Tests** (`tests/`, `backend/tests/`): Vitest (unit), Playwright (smoke + e2e), custom runners.

### Entry points
- Backend HTTP server: `backend/start.js` (bootstrap: loads `.env`, installs `unhandledRejection` guard, then `await import('./server.js')`). Migrations are `spawn`ed detached post-boot so Railway port-binding isn't blocked.
- Frontend SPA: `index.html` → Vite → `src/main.*`.
- Server app definition + middleware + route mounting: `backend/server.js`.

### Build & run
```bash
npm run dev          # Vite frontend dev server
npm run backend      # Express backend (node backend/start.js)
npm run dev:full     # both, via concurrently
npm run build        # vite build (prebuild: scripts/ensure-build-natives.mjs)
npm run migrate      # node backend/db/migrate.js
npm run db:setup     # migrate + seed:deterministic
```

### Tests / quality gates
```bash
npm run lint         # ESLint (src, backend, shared, tests/unit)
npm run typecheck    # tsc -p tsconfig.node.json --noEmit
npm run unit         # custom runner (scripts/run-unit-tests.mjs) + vitest run
npm run smoke        # Playwright smoke (tests/smoke/playwright.config.mjs)
npm run e2e          # Playwright e2e
npm run test         # check:profile-metadata + lint:ci + typecheck + build + unit
npm run test:all     # test + smoke + e2e
npm run doctor       # project health check
```
Custom guard scripts gate PRs: `auth-middleware:check`, `profile-guards:check`,
`runtime-imports:check`, `check:env-examples`, `safe-sql:check`, `profile-scope:check`,
`quality:gate` (code-quality-gate.mjs), `scan:secrets`.

### Notable structural risks (to verify during audit)
- **Dual migration trees**: `backend/db/migrations/*.sql` (SQLite) vs `backend/db/postgres/migrations/*.sql` — schema drift risk.
- **Two DB drivers** coexisting (`pg` + `better-sqlite3`) — query-dialect divergence.
- **Detached background migration** on boot — app may serve traffic against an un-migrated schema.
- **`process.on('unhandledRejection')` swallows crashes** (`start.js:11`) — intentional, but can mask real bugs.
- **143 loose service files** at `backend/services/` top level — high surface for inconsistency.

---

## 2. Findings

> Findings below are organized by directory group. Each group was reviewed in a dedicated pass.

<!-- Part files are merged in below this line. -->


---

# Backend Core Audit

Read-only audit of `backend/` core infrastructure: entry points, middleware, config/constants, db layer, startup, jobs, apply, vnext, and prompts. Findings tagged `[critical]` / `[important]` / `[nit]` with `file:line`.

---

## Entry points

### backend/server.js

- **[historical finding; remediated]** The wired inline auth parser now pins `jwt.verify(..., { algorithms: ['HS256'] })`; a live-server regression rejects HS384 even for a valid backing user. The separate `middleware/authIdentity.js` implementation uses the same allowlist.
- **[historical finding; canonical authority remediated]** The inline parser still derives a provisional role from JWT claims and may OR that claim with a session-row flag while constructing `req.user`. It no longer establishes authorization authority: `attachRequestContext()` immediately resolves canonical `req.ctx.isAdmin` from the trusted `users` row or validated synthetic-service-token provenance, fails closed on a missing row or DB error, and the remediated routes named below use that context. A raw `roles:['admin']` claim therefore does not retain canonical admin access on those paths, although the duplicate provisional-role logic and any unreviewed legacy caller remain cleanup work.
- **[important]** `backend/server.js:1420-1604` — The entire primary auth gate is a large inline `app.use` middleware rather than the dedicated `middleware/authIdentity.js` (which exists and does the same job). Two parallel auth implementations are a divergence/maintenance hazard; only one is actually wired (the inline one), leaving `authIdentity.js` as likely dead code at the server level.
- **[historical finding; substantially remediated]** A failed startup DB healthcheck is now recorded in `app.locals.db_startup_error`; runtime-secret key migration and schema/seed/background startup work are skipped or isolated, and readiness remains unavailable. The process intentionally stays up only to expose health/diagnostic evidence. Re-test the remaining best-effort secret-restore catch path before treating degraded boot as fully closed.
- **[important]** `backend/server.js:907` — Legacy SQLite auto-migration builds DDL by string concatenation: `db.prepare(\`ALTER TABLE ${table} ADD COLUMN ${column} ${type}\`)`. Guarded by `validTables` Set + `validColumnPattern` (line 902), so safe in practice, but identifiers are concatenated rather than validated-then-quoted; relies entirely on the whitelist.
- **[important]** `backend/server.js:380-388` — CORS `origin` is set to an array of allowed origins (good), but when `ENV.corsOrigins` is empty it falls back to `defaultCorsOrigins` which includes `http://localhost:5173`/`:3000`. In production these dev origins remain whitelisted; combined with `credentials: true`, dev origins can make credentialed cross-origin requests against a production deploy.
- **[historical finding; remediated]** The redundant later raw `ADMIN_TOKEN` bearer branch has been removed from the wired inline parser; the single earlier constant-time branch retains explicit service-token provenance.
- **[nit]** `backend/server.js:437-467` — Both `req.setTimeout` and `res.setTimeout` are registered with the same handler and both send a 504. If both fire, the second `res.status().json()` after `headersSent` is guarded by `!res.headersSent`, so no crash — but this duplicates the dedicated `middleware/requestTimeout.js` which is also imported (line 79) yet apparently not used here. Divergent timeout handling.
- **[nit]** `backend/server.js:1659` — `/api/auth/diagnostics` reports `jwtSecret: ... ? 'configured' : 'not configured'` and `adminTokenConfigured` — presence-only, no values leaked. Good; flagged only to confirm.
- **[nit]** `backend/server.js:144` — `safeTokenEqual` correctly returns false for `null`/non-string, so `ADMIN_TOKEN === null` (unset) cannot accidentally authenticate. Verified safe.

### backend/start.js

- **[critical]** `backend/start.js:11-16` — The global `unhandledRejection` handler logs and **keeps the process alive** but does nothing else. This is the masking guard the audit was asked to scrutinize: every unhandled rejection anywhere (background jobs, intervals with no `.catch`, the `setInterval` loops in `backgroundServices.js`/`queueRecovery.js`) is silently swallowed to a single `console.error` line, with no metric, alert, or health signal. Real failures (e.g. a DB pool that has permanently failed) are reduced to log noise. The rationale (avoid perpetual 502) is valid, but there is no surfacing/aggregation, so genuine faults are invisible.
- **[important]** `backend/start.js:46` — `dotenv.config({ override: shouldOverrideDotenv })` where `shouldOverrideDotenv` (lines 32-38) re-derives the smoke heuristic inline instead of calling `isSmokeLikeRuntime()` (lines 23-30), which computes the *same* thing. Two copies of the smoke-detection logic that can drift apart.
- **[important]** `backend/start.js:96`, `backend/start.js:127` — `spawn(process.execPath, [...], { env: process.env })` passes the full environment (including all secrets) to a child migration process. Expected for a migration, but `stdio: 'inherit'` (line 98) means any secret the migration logs goes straight to the parent's stdout. Confirm migrate.js never prints env values.
- **[nit]** `backend/start.js:100-103` / `backend/start.js:136-142` — `child.on('exit', ...)` logs a failed migration (`exit != 0`) but takes no recovery action and does not set any degraded flag the server can read; a failed background migration leaves the app "healthy" with stale schema.
- **[nit]** `backend/start.js:149` — `await import('./server.js')` then runs migrations after; if `server.js` top-level throws (it does heavy boot work), the migration background steps never run, but the unhandledRejection guard would keep a half-booted process alive.

---

## Middleware

### backend/middleware/auth.js

- **[important]** `backend/middleware/auth.js:60,84-88` — `ensureProfileAccess` falls back to a raw DB lookup `SELECT id, user_id FROM profiles WHERE id = ?` and grants access if `profile.user_id === user.userId`. The `profiles` table is profile-scoped, but this query has no profile_id predicate of its own (it *is* the profile lookup). Acceptable, but note access is granted on a direct `user_id` match without consulting `req.ctx.accessibleProfileIds` as the source of truth — two authorization paths that can disagree.
- **[nit]** `backend/middleware/auth.js:70-80` — Redundant access check: lines 70-76 already test `req.ctx.accessibleProfileIds.has(profileId)` (after the null/undefined sentinel guard), then lines 78-80 test `req.ctx?.accessibleProfileIds?.has(profileId)` again. The second `if` is dead — it can only be true when the first was already true.
- **[nit]** `backend/middleware/auth.js:31,60` — `req.ctx?.isAdmin ?? (await isAdminUserWithDb(...))` uses `??`, so when `req.ctx.isAdmin === false` the DB fallback is correctly skipped; but when `req.ctx` is undefined the DB call runs on every request. Fine, just noting the per-request DB cost when ctx middleware hasn't run.

### backend/middleware/profileContext.js

- **[important]** `backend/middleware/profileContext.js:13-21` — `extractProfileId` trusts `req.query.profileId`, the `x-profile-id` header, and `req.user.profileId` **in that order**, with the client-controllable query/header winning over the authenticated `req.user`. A user can set `?profileId=<other>` or `X-Profile-Id: <other>` to stamp the AsyncLocalStorage scope with a profile they may not own. The scope guard (`scopedQuery.js`) only checks that *a* profile_id predicate exists, not that it matches an authorized profile, so the actual authorization still depends entirely on route-level `ensureProfileAccess`. This middleware does not itself validate ownership of the claimed profileId.
- **[nit]** `backend/middleware/profileContext.js:36` — `runProfileContext(ctx, () => next())` — if a downstream middleware throws synchronously, the error propagates out of `storage.run` normally; fine. But `next()` is wrapped in an arrow with no error propagation concern. No bug.
- **[nit]** `backend/middleware/profileContext.js:45` — `withProfileScope(ctx, fn)` defaults to `{ bypass: true }` when no ctx given, which fully disables tenant scoping for jobs/crons. Intended, but a caller that passes a falsy-but-not-undefined ctx (e.g. `null`) also gets full bypass; broad.

### backend/middleware/errorHandler.js

- **[nit]** `backend/middleware/errorHandler.js:18` — `error_type: error?.error_type || error?.code || error?.name` is sent to the client even in production. While `error.message`/`stack` are correctly hidden in prod (lines 17,19), `error.code` can leak internal details (e.g. Postgres SQLSTATE codes like `42P01`, `SQLITE_CONSTRAINT`), giving an attacker schema/dialect fingerprinting. Minor info-leak.
- **[nit]** `backend/middleware/errorHandler.js:28` — `const statusCode = err.statusCode || err.status || 500`. If an error carries `statusCode: 0` (unlikely) it falls to 500; benign.
- **[nit]** `backend/middleware/errorHandler.js:44-50` — `console.error('Error:', {... stack: err.stack ...})` always logs the full stack server-side. Correct for debugging, no client leak, but verify logs aren't shipped somewhere world-readable.

### backend/middleware/ensureAdminUser.js

- **[historical finding; remediated]** `ensureAdminUser.js` now gates only on `isSyntheticServiceAdmin(user)`, which requires validated service-token provenance, rather than a raw `user.role`/`is_admin` JWT claim. The insertion remains best-effort and is not an authorization grant.
- **[nit]** `ensureAdminUser.js:33-45,59` — TOCTOU between the existence `SELECT` and the `INSERT`: two concurrent admin requests can both pass the check, one INSERT throws on PK conflict, silently swallowed by bare `catch {}` (line 59) which also hides genuine schema errors. Functionally harmless.
- **[nit]** `ensureAdminUser.js:48` — Hardcoded column INSERT with no `ON CONFLICT` guard, inconsistent with upsert patterns elsewhere.

### backend/middleware/rateLimiting.js

- **[important]** `rateLimiting.js:12-44` — No limiter sets a `keyGenerator`, so `express-rate-limit` keys on `req.ip`. Behind Railway/Vercel proxies this is correct only if `app.set('trust proxy', 1)` is set (it is, server.js:171) **and** the immediate upstream is trusted; with `trust proxy: 1` a client-supplied `X-Forwarded-For` can still shift the perceived IP if more than one proxy hop exists. Verify the proxy-hop count matches the trust setting.
- **[nit]** `rateLimiting.js:5-7` — Fallback defaults applied with `||`, so a legitimate `0` (disable) is overridden by the fallback. Unlikely intentional value.

### backend/middleware/requestContext.js

- **[historical finding; remediated boundary]** Configured-admin elevation now compares the exact allowlist only with `users.primary_email` loaded from the trusted DB row, never with a token-supplied email. Deployed runtimes must provide the operator email through environment configuration; the current tree has no source-controlled privileged mailbox.
- **[important]** `requestContext.js:27-28,79-81` — `lastAdminSelfHealAtMs` module-global throttle mutated without a lock; concurrent admin requests can both pass the time check before either updates it, running the heavy self-heal multiple times. Best-effort, racy.
- **[historical finding; remediated]** A missing users row or DB error now fails closed for admin and profile/org access. Only a token admitted through validated synthetic-service provenance retains its explicitly scoped service authority; raw JWT role, email, and `is_admin` claims are not fallback authority.

### backend/middleware/authIdentity.js

- **[historical finding; remediated]** Both `middleware/authIdentity.js` and the wired inline parser verify JWTs with `{ algorithms: ['HS256'] }`.
- **[current implementation detail; not canonical authority]** This module still uses token/session role data to construct provisional `req.user`, but `requestContext` is the downstream authorization authority and re-resolves admin from the DB or validated service-token provenance. Do not use `req.user.role` for authorization.
- **[historical finding; production guard remediated]** This helper still has no local non-empty-secret assertion, but deployed boot validation now requires `AUTH_JWT_SECRET`/`JWT_SECRET` and rejects known placeholders. A direct standalone invocation with an empty secret still fails closed and should remain covered by tests.
- **[nit]** `authIdentity.js:62-134` — All token comparisons correctly use `safeTokenEqual` (constant-time). Logs print `error.message` only, no tokens. Good. This module appears to duplicate the inline server.js auth and may be unused.

### backend/middleware/schoolPortalAuth.js

- **[important]** `schoolPortalAuth.js:21,57-67` — API keys hashed with **plain unsalted SHA-256, no HMAC/pepper** before DB lookup. Acceptable for 32-byte random keys (`generateApiKey`), but a DB compromise plus offline guessing is the only residual risk; no server-side secret means a stolen `key_hash` table is directly attackable for any low-entropy keys.
- **[important]** `schoolPortalAuth.js:101-107` — Populates `req.schoolPartner.allowed_origins` but never enforces it. If no downstream consumer validates the request origin against this list, the per-partner origin restriction is dead config.
- **[nit]** `schoolPortalAuth.js:84-85` — `expires_at` parsed via `new Date(...)`; an unparseable value yields `NaN` and the `Number.isFinite(expiresAt) && expiresAt < Date.now()` check treats it as **non-expiring** — a corrupted expiry fails open.

### backend/middleware/entitlements.js

- **[nit]** `entitlements.js:18-26` — `profileExists` swallows all DB errors and returns `false`, surfacing a transient DB failure as a "Profile not found" 400 instead of 500. Fail-closed (safe) but misleading.
- **[nit]** `entitlements.js:46-47,100-101` — Relies on `requireTierCapability` to send its own response when not allowed; if that helper can ever return falsy without responding, the request hangs. Confirm in `utils/tierGating.js`.

### backend/middleware/pipelineMonitor.js

- **[nit]** `pipelineMonitor.js:65,115` — Mojibake (corrupted UTF-8 `â` chars) in comments and the `SUPPRESSION DETECTED` log string; the log will render garbled.
- **[nit]** `pipelineMonitor.js:16-21` — `buckets` is module-global in-memory state; in multi-instance deployments `/api/admin/pipeline-health` reflects only one instance. Documented limitation.

### backend/middleware/responseCache.js

- **[important]** `responseCache.js:23` — `startCleanup()` runs at import time and the `setInterval` is not `unref()`'d, keeping the event loop alive in tests/short-lived processes until a signal.
- **[nit]** `responseCache.js:9,34` — Cleanup loop uses a hardcoded `30000` ms expiry independent of the per-middleware `ttlMs` parameter; entries with a longer ttl are still purged at 30s.
- **[nit]** `responseCache.js:64` — `CACHEABLE_PREFIXES` redefined inside the patched `res.json` closure on every response; wasteful, and indentation (lines 61-72) is broken.

### backend/middleware/requestTimeout.js

- **[nit]** `requestTimeout.js:14` — 504 timeout sets the response but does not abort the in-flight slow handler; the handler keeps running and may later attempt to write to an already-sent response (guarded only by `res.headersSent` inside the timer). Inherent to this pattern. No leak found in the listener cleanup.

---

## Config & Constants

### backend/config/env.js

- **[critical]** `env.js:208` — Production wildcard CORS check is gated on `if (isProd && env.CORS_ORIGIN && containsCorsWildcard(...))`, so `CORS_ORIGIN` **unset** in prod yields `corsOrigins: []` with no warning. If the consuming CORS layer treats empty as allow-all (or falls back to defaults including localhost — see server.js:380), this is a silent gap. A missing prod CORS origin deserves at least a warning.
- **[important]** `env.js:131` — In production with no DB config, `provider` falls through to `'sqlite'` and boot succeeds; there is no prod guard requiring Postgres in `loadEnv`/`assertEnv` (the Postgres requirement lives only in `db/index.js`). A prod deploy that forgets `DATABASE_URL` boots on ephemeral SQLite rather than failing fast at env validation.
- **[important]** `env.js:259,265` — `getJwtSecretOrThrow` returns hardcoded `'grantflow-dev-secret'` in non-prod, where `isProd` is derived from `env.isProd || env.NODE_ENV === 'production'`. If a caller passes raw `process.env` (no `isProd` field) with `NODE_ENV` unset, it resolves non-prod and emits the insecure default. Correctness depends on callers passing the enriched `loadEnv` env object — undocumented, fragile coupling.
- **[important]** `env.js:241` — `assertEnv` calls `process.exit(1)` only when `String(mode || process.env.NODE_ENV) === 'production'` (exact match, no trim), while `loadEnv` derives `isProd` through the Zod-defaulted `env.NODE_ENV`. A whitespace/case variant (`' production '`) fails Zod validation in `loadEnv` but skips the `process.exit` in `assertEnv`, so a misconfigured prod boot could return non-fatally.
- **[nit]** `env.js:28-43` — `looksUnsafeJwtSecret` only catches a fixed placeholder list; a short secret like `"a"` passes as "safe" in production. No minimum-length/entropy check despite the message recommending 32+ bytes.

### backend/config/constants.js

- **[historical finding; remediated]** Deployed runtimes no longer inherit any source-controlled privileged identity. `ADMIN_EMAIL`/`ADMIN_EMAILS` are environment-owned; only local/test runs receive the non-routable `admin@grantflow.local` fixture, and production env validation requires an explicit operator mailbox.
- **[nit]** `constants.js:52` — `DEFAULT_OPENAI_MODEL` reads `process.env.OPENAI_MODEL` at module-load time; if env is restored later (server.js restores secrets at boot) this captures the pre-restore value.

### backend/config/pipelineAllowedSources.js

- **[critical]** `pipelineAllowedSources.js:212-213` — `normalizeSourceKey` is invoked at module-evaluation time but declared (`export function`) on line 279, *after* use. Hoisting makes it work today, but if it were ever refactored to a `const` arrow (matching nearby helpers) these lines throw `ReferenceError: Cannot access before initialization` at import, crashing boot. Latent landmine in a boot-critical config.
- **[important]** `pipelineAllowedSources.js:222-270` — `TRUSTED_LABEL_TOKENS` is very permissive (`service`, `center`, `network`, `department`, `agency`, `corporation`, ...). Almost any plausible-looking source string passes `isPipelineSourceAllowed` unless on the exact denylist. This substantially weakens the pipeline trust gate.
- **[important]** `pipelineAllowedSources.js:377-380` — `evaluatePipelineSource` checks the denylist only against the source label; `record_origin` is denied only for two hardcoded values (`synthetic`/`untrusted`). A row with `record_origin: 'spam'`/`'fake'` and a trusted-looking label passes. Source and origin denylists are asymmetric.

### backend/config/urlRules.js

- **[important]** `urlRules.js:120-127` — `SSRF_BLOCKED_HOSTS` is an exact-string Set of specific loopback/metadata IPs; it does **not** block private ranges (10/8, 172.16/12, 192.168/16), IPv6 (`::1`, IPv4-mapped), or encoded forms (decimal IP, `0x7f.0.0.1`). For a control labeled "SSRF protection," this is bypassable. Genuine SSRF-hardening gap.
- **[important]** `urlRules.js:114` — `isPlaceholderText` pattern `/\bn\/?a\b/i` matches "na"/"n/a" anywhere, so benign descriptions ("Fee: N/A") get flagged as placeholder and may suppress valid opportunities (conflicts with the "avoid zero results" goal).
- **[nit]** `urlRules.js:87-89` — `/127\.0\.0\.1/`, `/0\.0\.0\.0/`, `/placeholder/i` are unanchored and match anywhere in the URL string.

### backend/config/designatedProfiles.js

- **[historical finding; current tree sanitized]** The 2026-06-19 tree contained real designated-profile PII. The current public fixture contains synthetic personas only; deployed designated-profile seeding fails closed unless an owner-approved private manifest is mounted. The historical exposure is not erased by this source edit: public Git history may still retain retired identifiers and requires the separate owner/privacy-counsel decision stated at the top of this report.
- **[historical, sanitized]** A designated-profile email-mapping mismatch was recorded in the prior audit; the public fixture identities and mappings have since been replaced with synthetic examples.
- **[historical, sanitized]** `designatedProfiles.js` previously shipped a non-routable profile-owner placeholder; the public fixture now uses a reserved synthetic address.

### backend/config/userProfileMappings.js

- **[historical finding; current tree sanitized]** Legacy personal-mailbox mappings were removed from source. The checked-in defaults now use reserved `example.invalid` demo identities; production/staging mappings must come from `USER_PROFILE_MAPPINGS_FILE` or `USER_PROFILE_MAPPINGS_JSON`.
- **[historical finding; remediated]** The admin sentinel is now included only when configured `ADMIN_EMAIL` is non-empty; deployed runtimes do not receive a source default.

### backend/config/profileSchema.js

- **[important]** `profileSchema.js:578-593` — `getFlatFieldToSectionMap` overwrites duplicate field names (only `console.warn`s, then `map.set` runs unconditionally). Many fields are duplicated across sections by design (`household_size`, `notes`, `mission`, `address`), so a PUT sending such a field always persists to whichever section is iterated **last**, not the intended one — a data-routing bug that also spams warnings on every call.

### backend/config/comprehensiveApplicationSchema.js

- **[important]** `comprehensiveApplicationSchema.js:88` — `tenncare_id: ''` (a Medicaid identifier field) is structurally part of the crawler/matching-visible schema; the file header says "Crawlers/matching can treat any data point as a potential signal." Sensitive identifier exposed to that path with only an unenforced "PII-safe filtering" caveat.
- **[nit]** `comprehensiveApplicationSchema.js:223` — `GROUP_RULES` student matcher does not match `student_grade_levels` (default at line 58), so it triggers the unmapped-key warning and maps to `'other'`.

### backend/config/features.js / matchThresholds.js / missionGoals.js / grantsGovEndpoints.js / constants/needCategories.js / constants/nteeMapping.js

- **[nit]** `matchThresholds.js:17` — Comment "must sum to 1.0" is satisfied today (0.35+0.25+0.20+0.20=1.0) but there is no runtime assertion; a future edit can break it silently. Also three same-valued thresholds (`AUTO_ADD_SCORE`/`GOOD_MATCH_SCORE`/`ACCEPT_SCORE` = 70) can drift.
- **[nit]** `features.js:20` — `isEnabled` returns `false` for an unknown feature name, indistinguishable from a disabled feature; a typo is silent.
- **[nit]** `missionGoals.js:143` — `MISSION_GOALS = GRANTFLOW_GOALS` legacy alias; possibly dead if `codeGuardService.js` was migrated.
- **[nit]** `grantsGovEndpoints.js:30,42-43` — Exported `SAM_GOV_API_KEY_ENV = 'SAM_GOV_API_KEY'` no longer reflects the resolver's preferred `SAM_GOV_PUBLIC_API_KEY`. Naming drift, no bug.
- No correctness/security issues in `needCategories.js` or `nteeMapping.js`.

---

## DB layer

### backend/db/index.js

- **[important]** `db/index.js:699-702` — `getDb()` runs the Postgres singleton healthcheck **without awaiting** and clears `singleton = null` inside the async `.catch`. Because it is not awaited, the current `getDb()` call still returns the (broken) singleton; the clear only takes effect on a later call, and there is a window where two callers can both observe `singleton` and one nulls it under the other. The comment acknowledges the non-await is intentional, but a transiently-slow healthcheck that later rejects nulls a singleton that may have been recreated meanwhile.
- **[important]** `db/index.js:591` — Postgres SSL is configured as `ssl: { rejectUnauthorized: false }`. This disables TLS certificate verification, exposing the DB connection to MITM. Common for managed Railway Postgres but should be flagged: a verifying CA bundle is preferable.
- **[important]** `db/index.js:573-577,488,600` — `fixBooleanIntegers` rewrites `<col> = 1`/`= 0` → `= TRUE`/`= FALSE` via regex over the **whole SQL string** for a hardcoded boolean-column list (lines 545-568). This is a string-rewrite of SQL outside string-literal awareness — a literal value like `WHERE note = 'is_active = 1'`... is protected by `assertProfileScopedSql` ordering but `fixBooleanIntegers` runs on raw SQL with no string-literal masking, so a matching pattern inside a quoted literal would be rewritten. Fragile dialect shim.
- **[nit]** `db/index.js:787` — `export const db = getDb()` executes `getDb()` at **module import time**, establishing the connection (and in prod throwing on misconfig) as an import side-effect, before any boot opt-out can run. Any module importing `db/index.js` triggers this.
- **[nit]** `db/index.js:455-472` — `SqliteDb.withTransaction` uses a hand-rolled `_asyncTxLock` promise to serialize async transactions. Correct for serialization, but if `fn` never resolves the lock is held forever (no timeout), blocking all subsequent transactions.
- **[nit]** `db/index.js:159-229,233-314` — The `?`→`$N` and `@name`→`$N` placeholder converters are hand-written string scanners. They handle single/double quotes and comments, but any edge case (e.g. dollar-quoted Postgres strings `$$...$$`, or `?` inside an identifier) is not handled. Works for the in-house query style but brittle.

### backend/db/scopedQuery.js

- **[important]** `scopedQuery.js:147-197` — `assertProfileScopedSql` only **logs a warning** (`profile_bleed`) for an unscoped query unless `NODE_ENV=test` or `PROFILE_SCOPE_STRICT=1` **and** a profileId is claimed (line 162). In production an unscoped query against a profile-scoped table with an active non-admin context **proceeds** (returns the SQL unchanged, line 196). The tenant-isolation "enforcement" is therefore advisory in production — it relies on every call site already including the predicate. Combined with `profileContext.js` trusting client-supplied profileId, the SQL-layer guard does not actually block cross-tenant reads in prod.
- **[nit]** `scopedQuery.js:101-108` — `tableRegex` matches `FROM/JOIN/INTO/UPDATE <table>` but not CTEs, subqueries aliased differently, or `DELETE FROM ... USING`. A profile-scoped table reached via an unmatched syntax would be classified `isScoped: false` and pass silently.
- **[nit]** `scopedQuery.js:46` — `ADMIN_ROLES` includes `'health_check'`; a context with `actorRole: 'health_check'` bypasses all scope checks. Confirm that role can never be set from a request-derived value.

### backend/db/migrate.js

- **[critical]** `migrate.js:284-317` — `runPendingMigrationsOnBoot` swallows migration errors (`logger.error('...continuing...')` at line 315) for **both** dialects, leaving the file unstamped to retry every boot, while the server reports healthy. This violates the file's own stated rule (line 251) that "Postgres migrations must be strict — never swallow on error." A genuinely broken Postgres migration boots anyway with silent schema drift.
- **[important]** `migrate.js:151-163` — The continue-on-idempotent path splits SQL naively on `;` after stripping only full-line `--` comments. A `;` inside a string literal or a `BEGIN...END;` trigger body mis-splits statements; combined with the per-statement swallow of `isIdempotentAlreadyAppliedError`, a mis-split fragment can be silently skipped and the migration stamped applied (line 162) while half-applied.
- **[important]** `migrate.js:192` — `isIdempotentAlreadyAppliedError` treats `near "exists" ... syntax error` as "already applied." A fresh migration with a genuine typo near a token spelled `exists` would be misclassified as idempotent and recorded as applied, masking a broken migration.
- **[nit]** `migrate.js:343-345` — `isDirectInvocation` uses `process.argv[1].endsWith('backend/db/migrate.js')`; fragile on Windows (this repo is win32) with path casing/separators, via symlinks, or npm bin shims. `import.meta.url === \`file://${process.argv[1]}\`` is more robust.
- **[nit]** `migrate.js:107-136` — In `applyMigration` the `.mjs` Postgres branch and its `else` are byte-identical; dead branching.
- **[nit]** `migrate.js:218-268` — `await db.close?.()` is duplicated 2-3× before `process.exit` in several spots; if `close()` is not idempotent the extra call could reject right before exit.

### backend/db/ensureSqliteSchema.js

- **[critical]** `ensureSqliteSchema.js:160,180` — `PRAGMA table_info(${tableName})` and `ALTER TABLE ${tableName} ADD COLUMN "${name}" ${type}` interpolate `tableName` with **no** identifier-regex guard inside `reconcileTableColumns` (the `name` path IS validated at line 130, but `tableName` is only validated upstream in `extractTableNames`). If any caller passes `opts.reconcileTables` (lines 199/206) with an attacker-influenced/malformed table name, it is interpolated unsanitized. Constant-only today; verify no external caller feeds `reconcileTables`.
- **[important]** `ensureSqliteSchema.js:177-188` — Reconciled columns are added with base type only, no constraints/defaults. A column the schema declares `NOT NULL DEFAULT 0` is added nullable with no default on an old DB, and the later `db.exec(schemaSql)` (CREATE TABLE IF NOT EXISTS) is a no-op on the existing table, so the drift is never corrected and is not surfaced.
- **[important]** `ensureSqliteSchema.js:131-132` — Any parsed type not in `SQLITE_BASE_TYPES` is coerced to `TEXT`; a `NUMERIC`/`REAL` column misread by the parser becomes TEXT affinity, silently changing sort/comparison behavior vs a freshly-created column.

---

## Startup

### backend/startup/bootstrap.js

- **[critical]** `bootstrap.js:411-414` — When `getJwtSecretOrThrow` fails, the code throws `new Error('Storage validation failed in production')` — a *storage* message masking a *JWT* failure. Operators debugging a missing `AUTH_JWT_SECRET` are misdirected. The same wrong message is reused at lines 82, 115, 444 for genuinely different failure classes.
- **[important]** `bootstrap.js:300-317` — The SQLite per-column `ALTER` loop and the Postgres self-heal loop run **unconditionally** on every boot, not gated by `shouldAutoMigrate` (only the full `schema.sql` apply is gated). If disabling auto-migrate was meant to skip schema mutation, this leaks DDL.
- **[important]** `bootstrap.js:124-139` — DB healthcheck failure continues in degraded mode by design, but subsequent `db.prepare(...)` self-heal steps still run against the failed DB, producing cascading caught errors.
- **[nit]** `bootstrap.js:148` — `restoreRuntimeSecretIfMissing` treats any current value containing `*` as "missing"; a legitimate secret containing `*` would be overwritten from the DB.
- **[nit]** `bootstrap.js:496-514` — The `__schema_test_*` probe inserts/deletes rows outside any transaction; a crash mid-loop can leave a `__schema_test_<type>__` row in `crawler_jobs`.

### backend/startup/queueRecovery.js

- **[important]** `queueRecovery.js:123-182` — The queue poller `setInterval` has **no in-flight/overlap guard**. The async callback does multiple awaited DB round-trips plus up to 3 awaited dispatches; if one cycle exceeds `QUEUE_POLL_INTERVAL_MS`, a second invocation starts concurrently and both `SELECT ... status='queued' LIMIT 3` then dispatch the **same** job IDs — duplicate dispatch.
- **[important]** `queueRecovery.js:162-173` — `await dispatchCrawlerJob({...}).catch(...)` is itself wrapped in a `try/catch`; the rejection is already swallowed by `.catch()`, making the outer `catch` dead for the async path. Error swallowed either way.
- **[important]** `queueRecovery.js:184-193` — Interval handles cleared on `SIGTERM`/`SIGINT` but never `unref()`'d, so they keep the event loop alive on a `server.close()`-driven shutdown. (`anyaBrainCleanup.js:77` does it right with `_timer.unref?.()`.)
- **[important]** `queueRecovery.js:22,59,90,119,123` — Multiple startup IIFEs and the poller run **concurrently with no ordering**; re-queue (Section 2) sets jobs to `queued` while the startup drain and poller are already selecting/dispatching `queued` rows — overlapping recovery on the same rows.
- **[nit]** `queueRecovery.js:110-113,205-212` — `Number.parseInt(env || '60000', 10)` unvalidated; a non-numeric env → `NaN` → `setInterval(fn, NaN)` treated as `0` → tight loop.

### backend/startup/backgroundServices.js

- **[critical]** `backgroundServices.js:249-260,267-278,287-289` — All three scheduler `setInterval`s have **no in-flight guard, no overlap protection**, are not stored/`unref()`'d/cleared. The code-crawl timer (287) ignores the return value of `startBackgroundCodeCrawlAndRepair`, so a rejected promise becomes an **unhandled rejection** every interval (swallowed by start.js's guard), and overlapping repair runs stack.
- **[important]** `backgroundServices.js:34-72` — Postgres CHECK-constraint auto-heal does `DROP CONSTRAINT IF EXISTS` then `ADD CONSTRAINT` in a single `db.exec` **without a transaction**; a crash/failure between them leaves the table with no CHECK constraint until the next successful boot — a window for invalid inserts.
- **[important]** `backgroundServices.js:75-104` — Pipeline self-check **string-interpolates** `trustedOriginClause()`/`trustedSourceClause()`/`activeVal` directly into the `db.prepare` SQL with no parameterization. Safe if those helpers stay constant; an injection surface if they ever incorporate external input.
- **[important]** `backgroundServices.js:127-388` — Boot work sprayed across hardcoded `setTimeout` delays (3000–30000 ms), none tracked/cleared/`unref()`'d; ordering is purely timing-based and breaks silently on slow boot; fast shutdown can't exit until the longest timer fires.
- **[nit]** `backgroundServices.js:118` — `err.message` (not `err?.message`) inside a catch; a non-Error throw makes the catch itself throw.

### backend/startup/ensureSchemaInvariants.js

- **[important]** `ensureSchemaInvariants.js:198-205` — `ensureCrawlerJobsTypeCheck` interpolates `CRAWLER_JOB_TYPES` into the CHECK constraint wrapped in single quotes with **no escaping** (`map(t => \`'${t}'\`)`). The dropped-constraint name correctly uses `%I` (line 194), but the added list is unsanitized — a type containing `'` would break out. Should assert `/^[a-z_]+$/` or escape.
- **[nit]** `ensureSchemaInvariants.js:144-167` — The Postgres crawler-job-type list and the SQLite rebuild list in `bootstrap.js:526-539` **differ**, so a job type valid in prod (Postgres) can be rejected in local SQLite.
- **[nit]** `ensureSchemaInvariants.js:347-373` — All steps swallow their own errors (`runStep` returns `false`); if all 8 fail, only a `warn` is emitted — silent degradation, no boot-fail/alert mechanism.

### backend/startup/bootPolicy.js

- **[important]** `bootPolicy.js:78-86` — `isSmokeMode` infers smoke from `PORT==='0' && DB_AUTO_MIGRATE && NODE_ENV!='production'`. A legitimate dev run with an ephemeral port + real migrations is misclassified as smoke, disabling background services and skipping migrate-on-boot. Documented but a real foot-gun.
- **[nit]** `bootPolicy.js:115-121` vs `bootstrap.js:143` — `shouldAutoApplySchema` exists here but `bootstrap.js` re-implements the same decision inline instead of importing it, so the drift this module was created to prevent still exists.

### backend/startup/selfHeal.js

- **[important]** `selfHeal.js:414-455` — `repairMissingUploadAvatars` loads `rows` with no `LIMIT` (`WHERE avatar_url IS NOT NULL`) then per-row issues additional `SELECT` + `UPDATE`; a large table blocks boot.
- **[nit]** `selfHeal.js:141-184` — `activeCount` computed (lines 145-147) but never used; an extra `COUNT(*)` runs every boot for nothing.
- **[nit]** `selfHeal.js:470-484` — `repairInvalidDocumentStatuses` runs a blanket `UPDATE` on every boot with no "only if drift" check; idempotent but always scans.

### backend/startup/validateImports.js

- **[nit]** `validateImports.js:65` — A failed import is logged as `CRITICAL` via `console.error` but the function is non-fatal (header says "only logs warnings"); the wording overstates severity and can trigger false alerts.
- **[nit]** `validateImports.js:54` — Imports modules purely to "validate" the tree; any top-level side effects (timers/connections) execute at boot just for validation.

---

## Jobs

### backend/jobs/exclusionAutoLearn.js

- **[important]** `exclusionAutoLearn.js:7` — `WHERE false_positive = 1` is dialect-fragile: the date clause is branched for postgres/sqlite (lines 2-4) but the boolean literal is not. On Postgres with a real `BOOLEAN` column this errors (`operator does not exist: boolean = integer`) or matches nothing. Half-applied dialect awareness.
- **[important]** `exclusionAutoLearn.js:5-21` — No `try/catch` anywhere; if any query rejects and this is invoked from an unguarded `setInterval`, it becomes an unhandled rejection (unlike `anyaBrainCleanup.js`). No scheduling wrapper exists in-file, so it is either dead code or relies on an unseen caller.
- **[important]** `exclusionAutoLearn.js:13-21` — One-row-at-a-time `UPDATE` in a sequential `await` loop with no transaction; a partial failure demotes some rules and not others. `r.cnt` from `COUNT(*)` is a string under node-postgres, so `r.cnt >= 3` relies on coercion.

### backend/jobs/anyaBrainCleanup.js

- **[important]** `anyaBrainCleanup.js:71-77` — `startAnyaBrainCleanupCron` clears `_timer` on re-call but the `kickoff = setTimeout(...)` (line 74) is not tracked; two rapid inits fire two kickoff runs. The interval (line 76) also has no in-flight guard, so a small `intervalMs` allows overlapping cleanups on the same rows.
- **[nit]** `anyaBrainCleanup.js:28` — `Number(process.env.ANYA_USAGE_RETENTION_DAYS || 30)`; a non-numeric env → `NaN` → `new Date(NaN).toISOString()` throws (caught, secondary purge silently skipped) — misconfig masked.

---

## Apply

### backend/apply/applyEngine.js

- **[critical]** `applyEngine.js:352,620-621,etc.` — `prepareApplication`/`getApplicationOr404`/`patchApplication`/`exportApplicationPackage` query `applications`, `grants`, `organizations`, `application_sections`, `application_checklist_items` by id/grant_id/organization_id with **no `profile_id` predicate**. These are profile-scoped tables; the engine relies entirely on the route layer for access control, so a caller reaching these with a guessed `applicationId` can read/mutate another profile's data. (`scopedQuery.js` only warns in prod, so it doesn't block this.)
- **[critical]** `applyEngine.js:783-789,808` — `markSubmitted` does `UPDATE grants SET status = 'submitted' ... WHERE id = ?` (and a `milestones` insert) keyed only on `grant_id` from an unscoped app row — global mutation with no profile scoping.
- **[important]** `applyEngine.js:917,923` — `autoPopulate` wraps work in `db.withTransaction(async () => {...})` but the inner `patchApplication`/`upsertSection`/`setChecklistItem` use the outer `db` handle, not `tx`, so the writes run outside the transaction — no atomicity (unlike `markSubmitted` which correctly uses `tx.prepare`).
- **[important]** `applyEngine.js:848-850` — `markSubmitted` persists warnings via a post-transaction `UPDATE applications SET snapshot_json = ?` computed from an in-memory value taken before the transaction, clobbering any concurrent `snapshot_json` change.

### backend/apply/storageAdapter.js

- **[nit]** `storageAdapter.js:30-43` — Path-traversal guard compares `resolvedAppDir` against `resolvedBase` but builds `appDir`/`ensureDir`/`path.join` from the unresolved `base`; mixing the two is fragile (harmless when `base` is already absolute).
- **[nit]** `storageAdapter.js:33` — An `applicationId` of `.` or `''` resolves to `resolvedAppDir === resolvedBase` and passes (equality allowed), writing artifacts directly into the base dir. Callers pass UUIDs, so low impact.
- **[nit]** `storageAdapter.js:59` — `assertArtifactPathIsSafe` exported but appears unused; verify it has a caller or it is dead code.

---

## VNext

### backend/vnext/stateMachine.js

- **[critical]** `stateMachine.js:104,212` — `attemptTransition` allows any forward `target` (only backwards is blocked). Multi-step jumps skip intermediate side-effects: `ensureDraftingTasks` only runs when `target === DRAFTING`, so a `DISCOVERED → REVIEW_READY` jump never creates drafting tasks even though that state implies drafting occurred. Side-effects are not idempotent across skipped states.
- **[important]** `stateMachine.js:96,226-238` — The final `UPDATE vnext_applications SET state = ? WHERE id = ?` has **no optimistic-concurrency predicate** (no `AND state = ?`). Two concurrent transitions both reading the same `current` both pass guards and the second clobbers the first (lost update); the audit `before` is wrong. No row lock / `FOR UPDATE`.
- **[important]** `stateMachine.js:129-238` — Schema inference, scoring, missingness, task creation, and the state UPDATE are independent awaited calls with **no surrounding transaction**; a failure mid-sequence leaves partial side-effects with state unchanged.
- **[important]** `stateMachine.js:156,171` — `computeMissingRequirements` is called **twice** in a single MISSING_RESOLVED-or-later transition; each writes `missing_requirements`, creates tasks, and emits audit events → duplicate writes/events per transition.
- **[important]** `stateMachine.js:186-190` — Dead/no-op guard: the `DRAFTING` guard body contains only a comment and an empty `if`, enforcing nothing.

### backend/vnext/missingnessService.js

- **[critical]** `missingnessService.js:202` — `UPDATE vnext_applications SET missing_requirements = ? WHERE id = ?` keyed only on `applicationId`, no `profile_id` predicate (the `documents` read at line 124 IS correctly profile-scoped). Relies on the caller having proven scope.
- **[important]** `missingnessService.js:90` + `vnextUtils.js:36` — `buildMissing` counts a required field satisfied only if `isTruthyText` passes, but `isTruthyText` rejects `'n/a'`/`'none'`; a legitimate `"None"` answer is counted as **missing**, creating a spurious FILL_FIELD task.
- **[important]** `missingnessService.js:45` — `computeMappedFields` only resolves `maps_to` paths beginning with `profile.`; a field mapping to `organization.*` (no `profile.` prefix) is never mapped and always reported missing.
- **[nit]** `missingnessService.js:108-113` — An opportunity with no required and no mapped fields reports `overall_confidence: 0` (avgConf 0, penalty 0), which downstream may misread as "totally unmapped."

### backend/vnext/schemaService.js

- **[critical]** `schemaService.js:113` — `UPDATE funding_opportunities SET schema_id = ? ... WHERE id = ?` keyed only on opportunity id, no `profile_id` predicate. Callers pass a scoped opportunity, but the exported function itself is unscoped.
- **[important]** `schemaService.js:113` — SQL identifier built via string concat with `nowExpr` from `sqlNowLiteral(db)` (a fixed literal, safe today) — the one spot bypassing the templated style; injectable if `sqlNowLiteral` ever took external input.

### backend/vnext/vnextUtils.js

- **[important]** `vnextUtils.js:70-73` — `insertIgnore` interpolates `table` and column names directly into SQL (`INSERT INTO ${table} (${colList}) ...`) with no allowlist/validation, unlike `applyEngine.js`'s `assertSafeIdentifier`. All callers pass literals today, so not currently exploitable, but it is an unguarded identifier-injection surface that also bypasses the `db.prepare` profile-scoping assertion.

### backend/vnext/auditEventsService.js

- **[important]** `auditEventsService.js:91-94,114` — Audit writes swallow errors with an empty `catch (error) {}` (intentional "never throw from audit logging") but emit **nothing** — not even a `console.warn` — so a persistently broken `audit_events` insert produces zero observability.
- **[nit]** `auditEventsService.js:98` — `logAuditEvent(db, {...})` called without `await` inside a `try`; if it is async and rejects, the `catch` (line 114, syncronous-only) won't catch it → unhandled rejection. Confirm it is synchronous.

### backend/vnext/scoringService.js

- **[important]** `scoringService.js:120-121` — `value = amount_expected * p_win * fit * (1 - time_risk)` is **not clamped**, feeding `expected_value = value - cost` which is persisted. With a huge `amount_expected`, `expected_value` is unbounded; no sanity cap. (Division-by-zero is otherwise guarded by `clamp01`.)
- **[nit]** `scoringService.js:110,123` — `risk_score` reads `missing?.missing_fields?.length`; unparseable/old `missing_requirements` → `undefined` → falsy → treated as "no missing items," silently inflating the score.

### backend/vnext/constants.js / schemaService extras

- No issues in `vnext/constants.js` (frozen enums, validated `normalizeVNextState`).

---

## Prompts

### backend/prompts/grantApplicationApproach.js

- **[important]** `grantApplicationApproach.js:27,30,33` — `${JSON.stringify(grant ?? null)}` interpolates the entire **crawler-sourced** grant/opportunity record into the prompt with no field allow-listing or instruction stripping. A poisoned grant description ("Ignore previous instructions...") can hijack `application_method`/`contact_email`/`portal_url`, which feed downstream auto-application routing. Highest injection exposure of the prompt builders (crawler text is the most adversarial). No `safeStringify` guard either, so a non-serializable value 500s the route.

### backend/prompts/pipelineAutomation.js

- **[important]** `pipelineAutomation.js:123` — `${safeStringify(base)}` interpolates `grant/organization/documents/...` wholesale; injected text can flip `suggested_status` to `submitted` and `handoff_required:false`, marking unsubmitted grants submitted. The prompt drives state-machine transitions.
- **[important]** `pipelineAutomation.js:48-124` — The entire prompt template carries 30-40+ leading spaces per line (code-nesting indentation shipped verbatim in a raw template literal), garbling structure and wasting tokens. Should be flush-left.

### backend/prompts/anyaMatchScout.js

- **[important]** `anyaMatchScout.js:38-56` — Seven raw `JSON.stringify` interpolations including crawler-sourced `candidateOpportunities` (line 56). The prompt's own safety rules (lines 129-135) are model instructions, not enforcement, and can be overridden by injected candidate text to surface junk in `high_confidence_matches`.

### backend/prompts/profileSections.js

- **[important]** `profileSections.js:395` — `${JSON.stringify(context, null, 2)}` ships the full profile plus **all other sections** (line 360-364) — including SSI/SSDI/Medicaid IDs, member/group IDs, immigration status, medical history — to the LLM for **every** single-section request, far broader than needed, plus an injection surface from any free-text/OCR-derived field. Scope `other_sections` to what each section actually needs.

### backend/prompts/reminderPlan.js

- **[nit]** `reminderPlan.js:1-11` — `sanitizeList` field allow-lists (the safest builder), but allow-listed `title`/`description` are still raw user/DB text and not injection-neutralized. Lower severity (narrow, user-owned fields).
- **[nit]** `reminderPlan.js:15,26` — `.slice(0, 6)` silently truncates deadlines/milestones with no "N more" hint; if callers don't pre-sort by urgency, the most urgent item can be dropped.

No file in `prompts/` instantiates an Anthropic/OpenAI client or hardcodes a model ID — these are pure prompt-string builders; the actual LLM calls live in the calling services (out of scope here).


---

# Backend Routes Audit (A–M)

Read-only audit of `backend/routes/*.js` files whose names begin with a letter A–M.

Conventions assumed for this repo: auth via `requireAuthenticatedUserMiddleware`/`ensureAuth`; authenticated context on `req.ctx` (`userId`, `activeProfileId`, `email`, `isAdmin` — DB-backed canonical admin); DB via `req.db.prepare(sql).get/all/run(...args)` (parameterized); tenant data queries scoped to the caller's profile/org; admin endpoints require admin authz.

---

### backend/routes/activity.js
- No issues found. Single `POST /page-view` route validates auth from `req.ctx`, validates input, ACKs 204, then runs a guarded fire-and-forget audit write (cannot leak an unhandled rejection). Only writes the caller's own activity, so no tenant-scoping concern.

### backend/routes/admin.js
- **[important]** `backend/routes/admin.js:1710` — `POST /reattach-users` has no in-handler admin check (`ensureAdminRequest` not called) yet performs destructive mass re-assignment of profile ownership (`UPDATE profiles SET user_id = ...`, links all unowned profiles to admin ~1784). Protected today only by router-level middleware; diverges from the defense-in-depth pattern every sibling mutating route uses.
- **[important]** `backend/routes/admin.js:3744` — `POST /link-admin-to-organizations` similarly has no in-handler admin check while mutating `user_organizations`.
- **[historical finding; remediated]** `POST /upload-profile-document` now authorizes with canonical `req.ctx.isAdmin === true`; raw `req.user.role`/`is_admin` claims do not grant this profile-creation and job-dispatch path.
- **[important]** `backend/routes/admin.js:807` / `:849` / `:926` — `/openai/verify-key`, `/openai/apply-key`, `/env/apply` accept secrets in the body and mutate `process.env` process-wide, with no rate limiting on the router. Sensitive secret-handling endpoints unthrottled.
- **[important]** `backend/routes/admin.js:3561` — `POST /seed-baseline-profiles` allows a non-session auth path via `X-Seed-Key`/body `seed_key` compared `===` to `process.env.SEED_KEY` (non-constant-time compare; key may be passed in JSON body where it is more likely to be logged).
- **[nit]** `backend/routes/admin.js:1476` — `POST /upload-profile-document`: early validation returns (e.g. 400 on no extractable text ~1480) exit before the catch's `fs.unlinkSync`, leaving the uploaded file orphaned on disk.
- **[nit]** `backend/routes/admin.js:863` — `/openai/apply-key` sets `process.env.OPENAI_API_KEY` *before* validating the key with `openai.models.list()`, so an invalid key overwrites the working one even when the response reports failure.
- **[nit]** `backend/routes/admin.js:4092` — `/crawlers/audit-live` builds a parameterized `IN (...)` from `profile_ids` with no length cap (the auto-select branch is capped at 200); large arrays are a perf/DoS foot-gun.
- **[nit]** `backend/routes/admin.js:226` (and many handlers, e.g. 1107, 2071, 2744) — error responses return raw `error.message`; `/profiles/integrity` returns the full failing `sql` string. Admin-gated but leaks schema/SQL detail.

### backend/routes/adminAgentControl.js
- No issues found. Strong admin gate (`ensureAuth` + `ensureCanonicalAdmin`), consistent async rejection guard, input validated against `RUN_TYPES`/`ALL_AGENTS` allowlists, parameterized store calls, audit logging, correct status codes (202/404/400).

### backend/routes/adminQueueOps.js
- No issues found. `requireAdmin` checks `req.ctx.isAdmin === true` on every route; SQL fully parameterized; dynamic `WHERE` built only from an allowlisted status set; pagination clamped; appropriate 404/409/500 codes.

### backend/routes/adminServiceCatalog.js
- **[nit]** `backend/routes/adminServiceCatalog.js:14` — `GET /catalog` has no `try/catch` (unlike every sibling handler); if `loadServiceCatalogResilient` ever throws, the rejection escapes to Express's default handler.
- **[nit]** `backend/routes/adminServiceCatalog.js:36` / `:86` — `res.status(500).json({ error: error.message })` leaks raw error text (admin-only).

### backend/routes/agentTelemetry.js
- No issues found. Router-level `ensureAuth` + `ensureAdmin`; every handler wrapped in `adminScoped` (sets admin scope + catches rejections). Note: error path intentionally returns HTTP 200 `{ ok:false }` (`:59`) so the dashboard renders an empty state — by design.

### backend/routes/ai.js
- **[critical]** `backend/routes/ai.js:1277` — `POST /discover-needs` IDOR: `SELECT p.* FROM profiles p WHERE p.id = ?` keyed only on body `profile_id`, with no `ensureOrganizationAccess`/ownership guard (router only enforces authentication). Any authenticated user can read another tenant's full profile PII (name, location, financial/health/housing/education). Sibling routes `/match` (`:288`) and `/analyze/eligibility` (`:695`) correctly call `ensureOrganizationAccess`.
- **[critical]** `backend/routes/ai.js:1387` — `POST /generate-profile-todo` same IDOR: `SELECT * FROM profiles WHERE id = ?` plus that profile's `grants` (`:1408`) and `profile_sections` (`:1426`), all keyed only on body `profile_id` with no access check. Leaks arbitrary tenants' profile + pipeline + section data.
- **[important]** `backend/routes/ai.js:1017` — `POST /portal-assist` performs `fetch(portal_url, ...)` with no URL validation (no scheme allowlist, no private-IP/localhost block) — SSRF. The fetched content is summarized back to the caller. admin.js has a dedicated SSRF guard (`assertRemoteUrlAllowed`/`isPrivateIpAddress`) that this route does not use.
- **[nit]** `backend/routes/ai.js:1089` (and 1230, 1343, 1512) — `if (!openai) return res.status(503)` is likely dead: `getOpenAI()` calls `createOpenAIClient()` without `allowMissing`, so a missing key throws (→ 500 via catch) rather than returning falsy. The intended 503 "AI not configured" path won't fire.
- **[nit]** `backend/routes/ai.js:158` / `:224` — `/comprehensive-match` and `/ecf-service-search` accept caller-supplied `profile`/`profile_id` and run scoring with no ownership verification; they scope the opportunity query by `profile_id` and don't read the profile row from the DB, so no direct PII leak, but they trust caller-supplied profile data.

### backend/routes/anya.js
- **[important]** `backend/routes/anya.js:405` — `POST /sessions/:sessionId/tasks/:taskId/execute` calls `markTaskExecuted(...)`; the underlying service loads the task by `WHERE id = ? AND session_id = ?` but never verifies the caller owns `sessionId`, and this route (unlike sibling task routes that go through `getSession()`/`assertSessionAccess`) does no session-ownership check. Potential cross-tenant write (mark another tenant's task executed). Verify the service's scoping.
- **[important]** `backend/routes/anya.js:47` — `adminAuth` has a fallback accepting a static shared `ADMIN_TOKEN`/`ANYA_ADMIN_TOKEN` env secret via headers, granting full admin to every `adminAuth`/`/autonomous/*` endpoint — a broad static-secret trust path beside the canonical `req.ctx.isAdmin`.
- **[important]** `backend/routes/anya.js:91` — `GET /health` is fully public (mounted before any auth), runs `COUNT(*)` queries and discloses `RAILWAY_DEPLOYMENT_ID`/version plus operational counters, with no rate limiting.
- **[nit]** `backend/routes/anya.js:86` — `handleError` uses `error.message` (no optional chain, unlike `error?.status` one line earlier); a null rejection throws inside the error handler.
- **[nit]** `backend/routes/anya.js:387` — `PATCH /sessions/:sessionId/tasks/:taskId` is the only handler written as `(req,res)=>{ Promise.resolve().then(...) }` instead of `async`, inconsistent with siblings.

### backend/routes/anyaMatchSuggestions.js
- **[important]** `backend/routes/anyaMatchSuggestions.js:101` — `forwardFromOpportunity` derives the internal base URL from `req.get('host')` (attacker-controllable `Host` header) when `ANYA_SELF_BASE_URL` is unset, then POSTs forwarding the caller's `Authorization`/`cookie` headers (`:110`) — SSRF / credential-forwarding. `POST /:id/accept` (`:181`) has no rate limiting and triggers this on every call.
- **[nit]** `backend/routes/anyaMatchSuggestions.js:64` — `loadAuthorizedSuggestion` swallows any DB read error and reports `404 Suggestion not found`, masking real DB outages.
- **[nit]** `backend/routes/anyaMatchSuggestions.js:223` — post-accept `UPDATE` failure is logged/swallowed as non-fatal but the handler still returns `{ ok:true, status:'accepted' }`; the row may stay `pending` (state divergence, retry double-add).

### backend/routes/applicationDrafts.js
- **[important]** `backend/routes/applicationDrafts.js:100` — `POST /`: `const id = data.id ? String(data.id) : crypto.randomUUID()` lets the client pick the primary key (id mass-assignment). `status` (`:124`) is accepted with no allowlist validation.
- **[important]** `backend/routes/applicationDrafts.js:73` — `GET/PUT/DELETE /:id` load by `id` alone then call `ensureGrantAccess(req, res, row.grant_id)`. IDOR protection rests entirely on `ensureGrantAccess`; if a grant is public/global, drafts under it become cross-tenant readable/writable. Verify.
- **[nit]** `backend/routes/applicationDrafts.js:69` (and all five handlers) — catches return `error?.message` directly to the client, leaking DB/driver error text.

### backend/routes/applications.js
- **[important]** `backend/routes/applications.js:198` — `GET /:id/artifacts/:artifactId/download` streams from `artifact.storage_path` after `assertArtifactPathIsSafe(...)`. The artifact row is scoped (`WHERE id = ? AND application_id = ?`) and the application is access-checked, so IDOR is covered, but path-traversal safety rests entirely on `assertArtifactPathIsSafe` — confirm it rejects absolute/`..` paths.
- **[nit]** `backend/routes/applications.js:116` — `PUT /:id/sections/:sectionKey` and `/checklist/:key` pass body `title`/`content`/`label`/`status` to the engine with no validation or length bounds.
- **[nit]** `backend/routes/applications.js:52` (pervasive) — idiom `x && typeof x === 'string' ? x : String(x || '')` silently converts a missing required value to `''` rather than rejecting with 400.

### backend/routes/applicationTasks.js
- **[historical finding; remediated]** Application-task admin branches now use canonical `req.ctx.isAdmin`; non-admin task access delegates to the shared DB-backed accessible-profile resolver rather than a raw role claim.
- **[nit]** `backend/routes/applicationTasks.js:79` — `GET /` non-admin path issues one `listApplicationTasks` query per accessible profile (unbounded fan-out; each capped at 100, but no cap on number of profiles).
- **[nit]** `backend/routes/applicationTasks.js:203` — `POST /:taskId/missing-info` iterates `items` with no count bound, doing sequential DB writes per item.

### backend/routes/applicationWorkflow.js
- **[nit]** `backend/routes/applicationWorkflow.js:67` — `loadApplication` enforces access only `if (row.profile_id)`; a `grant_applications` row with null `profile_id` bypasses `ensureProfileAccess` entirely and is returned (and mutable via the steps/documents/status routes that funnel through it). Cross-tenant hole if null `profile_id` is possible.
- **[nit]** `backend/routes/applicationWorkflow.js:105` — `POST /preview` makes `profile_id` optional; when omitted it runs `generateActionPlan(opportunity, {})` unscoped on attacker-supplied `opportunity`. Low risk (side-effect-free planner) but unscoped.
- **[nit]** `backend/routes/applicationWorkflow.js:96` (every catch) — returns `err?.message ?? String(err)` to the client.

### backend/routes/authMe.js
- **[historical finding; remediated]** Both the wired `/api/auth/diagnostics` handler and the extracted router definition now require authentication plus canonical admin authorization before returning presence-only operational metadata.
- **[historical/unwired implementation note]** The extracted `authMe.js` `/me` handler still contains legacy `req.user`-primary logic, but the server's earlier wired `/api/auth/me` handler uses the canonical resolved context and wins routing. Do not mount the extracted duplicate without first converging its authority contract.
- **[nit]** `backend/routes/authMe.js:19` — `routeLogger` created but never used (file logs via `console.*`).

### backend/routes/auth.js
- **[important]** `backend/routes/auth.js:2189` — `/phone/verify` (and `/email/verify` `:1828`) have no rate limiter on OTP verification. The per-credential `attempt_count` is incremented but no handler ever rejects on a threshold, so 6-digit OTPs are brute-forceable. Only the *start* endpoints are limited.
- **[important]** `backend/routes/auth.js:353` — `generateSixDigitCode()` uses `Math.random()` (`Math.floor(100000 + Math.random()*900000)`) for security-sensitive OTPs — not a CSPRNG; predictable. Should use `crypto.randomInt`.
- **[important]** `backend/routes/auth.js:271` — OTP codes stored/compared as unsalted single-pass `sha256(`email:code`)`; a 6-digit space (1e6) is trivially brute-forced from a leaked `code_hash` column.
- **[important]** `backend/routes/auth.js:2916` — account enumeration in `/password/login`: non-existent user → `401 invalid_credentials` immediately; existing user with no password → `400 password_not_set`; wrong password → full `bcrypt.compare` (cost 15) before 401. Status + timing divergence enumerates emails. `/access/check` (`:2434`) is an explicit unauthenticated enumeration oracle returning `{allowed, hasPassword}`.
- **[important]** `backend/routes/auth.js:2701` — `/password/reset/start` returns `403 unauthorized_email` for non-matching emails but `202` for valid ones — enumeration oracle.
- **[nit]** `backend/routes/auth.js:1696` / `:1746` — DB error responses include `details: dbError.message` when `NODE_ENV !== 'production'`; a Railway/Vercel prod deploy that doesn't set `NODE_ENV=production` would leak raw DB errors (inconsistent with the centralized `isProductionEnvironment()` helper).
- **[nit]** `backend/routes/auth.js:2474` — unreachable `else { reason = 'unknown' }` (function already returned 403 above; comment acknowledges "should not be reachable").
- **[nit]** `backend/routes/auth.js:2828` — `bcrypt.hash(passwordRaw, 15)` is an unusually high cost (~1–3s/hash); availability/DoS-amplification note.
- **[nit]** `backend/routes/auth.js:3322` / `:3378` — `/refresh` and `/logout` have no rate limiter (refresh-token entropy makes brute force impractical; noting the gap).

### backend/routes/billing.js
- **[historical finding; remediated]** Billing admin authorization now requires canonical `req.ctx.isAdmin`; profile access for non-admins is resolved through the shared DB-backed accessibility contract.
- **[nit]** `backend/routes/billing.js:357` / `:372` — uses `req.user.userId` for `assigned_by`/`changed_by`; if undefined it degrades audit attribution to `'admin'`.
- **[nit]** `backend/routes/billing.js:16` — `ensureProfileAccess as ensureProfileAccessByEmail` imported but never used.

### backend/routes/billingSettings.js
- **[nit]** `backend/routes/billingSettings.js:81` — `incoming = req.body` stored wholesale into `custom_preferences.billing_settings` with no allow-list/validation (mass-assignment; low impact, namespaced under the caller's own row).
- **[nit]** `backend/routes/billingSettings.js:51` (and 68, 118, 154) — error responses return `error?.message` regardless of environment.
- Note: tenant scoping is correct — every handler queries `user_preferences WHERE user_id = ?` and `:id` routes verify `row.id === req.params.id` after loading by `userId`; no IDOR.

### backend/routes/blocklist.js
- **[historical finding; remediated]** Blocklist routes no longer accept raw `req.user.role`/`is_admin` claims. Browser admin access uses canonical `req.ctx.isAdmin`; the separately configured device/admin bearer tokens remain explicit credential paths with timing-safe comparison.
- **[nit]** `backend/routes/blocklist.js:188` — `res.status(result.ok ? 200 : 200)` — both branches 200; a failed sync (`ok:false`) still returns HTTP 200, masking failure.
- **[nit]** `backend/routes/blocklist.js:77` — `GET /` `const limit = Number(req.query.limit) || 500` has no upper bound (the `/hits` route correctly clamps to 1000).

### backend/routes/budgets.js
- **[important]** `backend/routes/budgets.js:75` — `GET /`: for admins, when `getAccessibleOrganizationIds(req)` is empty, the `if (orgIds && orgIds.length > 0)` guard is skipped so no org clause is added and the query returns budgets across all organizations. Empty accessible-org list silently becomes "see everything." Confirm intent.
- **[important]** `backend/routes/budgets.js:145` — `POST /`: `const id = data.id ? String(data.id) : crypto.randomUUID()` allows client-supplied primary keys (id mass-assignment; 201-vs-500 difference probes id existence).
- Note: `GET/PUT/DELETE /:id` correctly enforce `ensureGrantAccess(req, res, row.grant_id)` after loading by id (no IDOR).

### backend/routes/colleges.js
- **[nit]** `backend/routes/colleges.js:38` — `radiusMiles` is computed/returned but never used for filtering (`radiusFilteringApplied: false` hardcoded at `:142`) — misleading API surface.
- **[nit]** `backend/routes/colleges.js:147` — `const msg = err instanceof Error ? err.message : String(err)` assigned but never used (dead variable).
- Note: `trustedOriginClause()`/`trustedSourceClause()` are interpolated into SQL (`:78`, `:91`) but are constant clause-builders with no request input — not injection. Auth + rate limiting applied router-wide.

### backend/routes/committedCollege.js
- **[historical finding; remediated]** `committedCollege.js` now grants admin access only through `req.ctx.isAdmin === true` and otherwise checks the shared DB-backed accessible-profile set; the token-only admin shortcut was removed.
- **[nit]** `backend/routes/committedCollege.js:45` — `try { await ensurePipelineDismissalsSchema(db) } catch {}` silently swallows schema-init errors.
- Note: deletes/updates in `deleteDeselectedFromPipeline` are correctly scoped by `profile_id` (`:51`, `:58`); SQL parameterized.

### backend/routes/contactMethods.js
- **[important]** `backend/routes/contactMethods.js:110` / `:130` — `created_by` written directly from client-supplied `data.created_by ?? null` (forgeable ownership/audit field) instead of `req.ctx.userId`; `data.id` is also client-controllable (chosen primary key).
- **[nit]** `backend/routes/contactMethods.js:73` (and 88, 137, 175, 192) — error responses leak raw `error?.message` to the client.
- **[nit]** `backend/routes/contactMethods.js:106` — `if (!type || !value)` partly dead: `type` was already validated non-empty against `validTypes` above.
- Note: `GET/PUT/DELETE /:id` fetch by id then `ensureOrganizationAccess(req, res, row.organization_id)` — check-after-fetch, no IDOR (relies on that guard rejecting foreign orgs).

### backend/routes/contacts.js
- **[important]** `backend/routes/contacts.js:145` — `GET /:id` runs the profile-scoping check only when `row.profile_id && req.ctx?.activeProfileId` are both set. A profile-scoped contact requested by a user with no active profile skips the profile check and is returned on org access alone — cross-profile read. The list endpoint (`:108`) correctly 400s when the column exists but no profile is specified.
- **[important]** `backend/routes/contacts.js:16` — `contactsHasProfileIdColumnCache` is a module-level cache of column existence that is never invalidated; a `false` computed before a migration silently disables all profile scoping for the process lifetime.
- **[nit]** `backend/routes/contacts.js:130` (and 156, 251, 319, 336) — raw `error?.message` returned to client.
- **[nit]** `backend/routes/contacts.js:170` — client-controllable `data.id` used as primary key on insert.

### backend/routes/crawlers.js
- **[critical]** `backend/routes/crawlers.js:2595` — `POST /foundation-990/batch` has no auth: it calls `createCrawlerJob` + `dispatchCrawlerJob` (`:2604`/`:2613`) for any anonymous caller (router mounted with only `responseCache`; this handler never calls `ensureAuth`). It also records `requestedBy: req.userId ?? 'admin'` — `req.userId` is never set (the codebase uses `req.ctx.userId`), so every job is mislabeled admin-originated. Unauthenticated job-injection / resource abuse.
- **[critical]** `backend/routes/crawlers.js:431` / `:1834` / `:2309` — `GET /`, `GET /county-status`, `GET /health` have no auth/authz (no router-level auth; handlers never call `ensureAuth`), exposing operational data to anonymous callers.
- **[important]** `backend/routes/crawlers.js:1379` — `POST /jobs/:id/retry` calls `dispatchCrawlerJob({...})` with no `await` and no `.catch` (unlike the create path's `setImmediate(...).catch(...)`) — unhandled rejection. Same un-`.catch`'d `setImmediate(() => dispatchCrawlerJob(...))` at `:2566` (`/profile-change`) and `:2613` (`/foundation-990/batch`).
- **[important]** `backend/routes/crawlers.js:1680` (and 1765, 2129, 2435, etc.) — destructive/seed endpoints (incl. `/remove-loans` → `DELETE FROM funding_opportunities`) authorize via `req.ctx?.isAdmin` OR a shared static `process.env.BULK_POPULATE_KEY` header with no rate limiting — a sensitive bypass of the DB-backed admin model.
- **[important]** `backend/routes/crawlers.js:449` — `GET /jobs` parses `limit`/`offset` with raw `Number.parseInt` and never validates bounds (no max-limit clamp; negative offset possible). The imported `validatePagination` (`:10`) is unused (dead import).
- **[nit]** `backend/routes/crawlers.js:1977` — `seed-state-assistance` writes rows without going through `gateAndStampReality` (unlike sibling seeders), bypassing the "never write an ungated active row" invariant.

### backend/routes/crawlerV2.js
- **[critical]** `backend/routes/crawlerV2.js:17` — `GET /health` has no auth (only `/runs`, `/runs/:id`, `/run` call `requireAdminOrToken`); queries `crawl_runs`/`nf_programs_*` and returns operational internals to any anonymous caller.
- **[important]** `backend/routes/crawlerV2.js:8` — `requireAdminOrToken` accepts a static shared `BULK_POPULATE_KEY` via `x-bulk-key`/`x-admin-token`; `POST /run` (`:129`) triggers a live crawler with no rate limiting.
- **[nit]** `backend/routes/crawlerV2.js:38` / `:49` / `:50` — `req.db.prepare(...).get()?.count` is not `await`ed before optional-chaining `.count`; on an async (postgres) dialect `.get()` returns a Promise, so the count is `undefined` → silently `0`. Likely a real bug on the async path.
- **[nit]** `backend/routes/crawlerV2.js:64` (and 87, 125, 154) — raw `error.message` returned to client.

### backend/routes/crawlLogs.js
- **[important]** `backend/routes/crawlLogs.js` (whole file) — `GET /` and `POST /filter` require only `requireAuthenticatedUser` with no admin/tenant scoping; any authenticated user reads the full crawl history (incl. `error_message`, `:30`). Diverges from the "admin endpoints must have admin authz" convention for crawler surfaces.
- **[nit]** `backend/routes/crawlLogs.js:55` / `:107` — raw `error?.message` returned to client.

### backend/routes/discovery.js
- **[critical]** `backend/routes/discovery.js:30` — `GET /discover-grants` has no profile/tenant scoping: it queries `funding_opportunities` filtered only by `is_active` (+ optional `state`), with no `profile_id IS NULL` restriction (unlike `searchOpportunities`/`comprehensiveMatch`). Any authenticated user can read other profiles' private crawl results (rows where `profile_id` is set).
- **[important]** `backend/routes/discovery.js:678` — `archOpportunities` `action === 'list'` branch hardcodes `WHERE archived = 1` (SQLite literal) even though the archive/unarchive branches use `isPostgres ? 'TRUE' : '1'`; on Postgres this errors or returns nothing.
- **[important]** `backend/routes/discovery.js:217` — candidate `LIMIT ${candidateLimit}` is string-interpolated (constant 3000 today, so not exploitable, but diverges from parameterized convention and is fragile if made dynamic).
- **[important]** `backend/routes/discovery.js:627` — `archOpportunities` admin check via `req.user ?? { role:'guest' }` / `isAdminUser(user)` rather than `req.ctx.isAdmin`; reliability depends on what populates `req.user`.
- **[nit]** `backend/routes/discovery.js:466` — `searchOpportunities` does not bound `page`/`per_page` (negative page → negative OFFSET; huge per_page).
- **[nit]** `backend/routes/discovery.js:452` (and 615, 703, 786) — returns `error.message` in the body, leaking internal detail.

### backend/routes/documents.js
- **[important]** `backend/routes/documents.js:790` — `POST /signed-url` performs no ownership check on `file_uri` and is a trivial passthrough (`${host}${file_uri}`, no actual signing). It both misrepresents itself and can mint URLs for arbitrary `/uploads/...` paths.
- **[important]** `backend/routes/documents.js:742` — `Content-Disposition` filename derives from DB `file_name`/`name` with only `replace(/"/g,'')`; newlines/control chars are not stripped → header (CRLF) injection via crafted document names.
- **[important]** `backend/routes/documents.js:452` vs `:568` — download authorizes via `ensureDocumentAccess` (`profile_id && accessibleProfiles.has(...)`) while delete uses a looser `activeProfileId === profileId` ownership rule; confirm the inconsistency is intended.
- **[nit]** `backend/routes/documents.js:743` — `fs.createReadStream(...).pipe(res)` has no `'error'` handler; a mid-stream read error (file deleted after `existsSync`) emits an unhandled stream error after headers are sent.

### backend/routes/expenses.js
- **[important]** `backend/routes/expenses.js:120` — `PUT /:id` updates `approved` directly from the body (`Boolean(approved)`) for any user with expense access. If approval is meant to be privileged (admin/manager), this is a missing authz check / mass-assignment of an approval flag. Confirm against product rules.
- **[nit]** `backend/routes/expenses.js:104` — POST does not validate `date`/`category`/`description` formats.
- **[nit]** `backend/routes/expenses.js:82` (and 116, 134, 147) — error responses return `error.message` to the client.
- Note: list/post/put/delete otherwise enforce grant/org access correctly via `ensureGrantAccess`/`ensureOrganizationAccess`.

### backend/routes/fieldUsage.js
- **[important]** `backend/routes/fieldUsage.js:36` — no authentication middleware anywhere in this router (unlike every other file). Data comes from a static registry (limited exposure) but it diverges from the `requireAuthenticatedUserMiddleware` convention and exposes internal field semantics unauthenticated. Confirm intended public.

### backend/routes/foundations.js
- **[important]** `backend/routes/foundations.js:199` — in `GET /calendar/deadlines`, the saved-grants query is scoped by `g.user_id = ?` but the matched-opportunities query has no user/profile scoping (returns the global catalog). By-design for a catalog, but note `profileId` from the query is applied to saved grants without an access check (combined with the caller's `userId`, so low risk).
- **[nit]** `backend/routes/foundations.js:158` — month math computes `endDate` with month `13` for `mo=12` and then overwrites it in a Dec special-case; the dead December computation is confusing. Also no `YYYY-MM` validation, so bad `month` yields `NaN` filters.
- **[nit]** `backend/routes/foundations.js:52` — `GET /:ein` is registered before literal routes; the greedy param route shadows any future single-segment route (current two-segment routes don't collide).

### backend/routes/fundingLibrary.js
- No issues found. Auth enforced router-wide; cross-tenant access documented as intentional; list/get delegate to the service layer with options passed as data.

### backend/routes/fundingTrace.js
- **[critical]** `backend/routes/fundingTrace.js:48` — `POST /add` builds `INSERT INTO funding_opportunities (${columns.join(', ')}) ...` where `columns` are object keys from `traceSourceToOpportunity(source, ...)` and `source` is attacker-controlled body. If the service does not allowlist keys, this is SQL injection via column identifiers (admin-only mitigates severity). Verify `traceSourceToOpportunity` returns a fixed schema; if not, this is a confirmed injection. Values themselves are parameterized.

### backend/routes/fundingTrace.js — note
- Router is correctly admin-gated via `ensureAuth` + `ensureAdmin`.

### backend/routes/geoCrawl.js
- **[nit]** `backend/routes/geoCrawl.js:62` — `callerProfileId` from caller-supplied body is written to `crawler_jobs.profile_id` with no verification the admin has access to that profile (low risk, admin-gated).

### backend/routes/grantApplications.js
- **[important]** `backend/routes/grantApplications.js:50` — `GET /` scopes by `user_id` only, with no `activeProfileId` scoping; rows created under a profile the user later loses access to remain visible. Convention divergence (scoping by `user_id` rather than `activeProfileId`).
- **[nit]** `backend/routes/grantApplications.js:240` — PUT writes `grant_name` as `String(data.grant_name).trim()` with no required-field re-validation (POST validates, PUT does not), so a blank `grant_name` can be persisted.
- **[nit]** `backend/routes/grantApplications.js:99` (and elsewhere) — error responses return `error?.message` directly to the client.

### backend/routes/grantMonitoring.js
- **[nit]** `backend/routes/grantMonitoring.js:186` — `insert`/`seenRecent` prepared statements are built on `req.db` every request but never used (the transaction re-prepares `insertTx`/`seenRecentTx`). Dead code.
- **[nit]** `backend/routes/grantMonitoring.js:95` — `Number.parseInt(req.query.limit ?? 100, 10)`; an array `limit` yields `NaN` → `NaN` LIMIT, which can throw at the DB layer.

### backend/routes/grants.js
- **[nit]** `backend/routes/grants.js:507` — `organization_id` filter is appended unconditionally and pushed raw (not `String()`-wrapped); parameterized so no injection, type-consistency nit (non-admin access is correctly checked at `:493`).
- **[nit]** `backend/routes/grants.js:1132` — `if (status === 'applied' …)` may be unreachable dead code if `'applied'` is not in `GRANT_STATUSES` validated at `:1119`. Confirm the constant.
- Note: dynamic SQL (`IN (...)` placeholder lists, column names) is consistently guarded by `assertSafeIdentifier`/allowlists with parameterized values — no injection found.

### backend/routes/hamiltonAutomation.js
- **[historical finding; remediated]** Hamilton task listing and profile access now use canonical `req.ctx.isAdmin` and the shared DB-backed accessible-profile contract. Raw role claims are retained only for display/audit attribution, not authorization.
- **[nit]** `backend/routes/hamiltonAutomation.js:1094` — `admin/tasks` interpolates `${where}` built from a fixed allowlist (constant literals, no injection).

### backend/routes/health.js
- **[nit]** `backend/routes/health.js:112-113` — the table-identifier regex check `if (!/^[a-zA-Z0-9_]+$/.test(item.table)) return ... 'invalid_table_identifier'` is duplicated verbatim (line 113 repeats line 112). Harmless dead duplicate.

### backend/routes/incognito.js
- No issues found. Auth enforced via `router.use`; parameterized query; JSON parse guarded.

### backend/routes/items.js
- **[nit]** `backend/routes/items.js:25` — `limit` parsed and finite-checked but has no upper-bound clamp; an arbitrarily large limit is passed to `suggestItemsForProfile`. Admin checks present on `/discover` and `/seed`.

### backend/routes/john.js
- **[nit]** `backend/routes/john.js:113` (and 142, 197) — admin error handlers return `err?.message` to the client (admin-only, low risk). `adminAuth` token compare uses `crypto.timingSafeEqual` after a length short-circuit (standard/acceptable).

### backend/routes/laptopConnector.js
- **[important]** `backend/routes/laptopConnector.js:146` — `/runs/:id/ingest` increments `created` inside `.then()` callbacks on un-awaited `insertReviewItem(...)` promises, then reads `created` (`:184`) and sends `candidates_created: created` immediately. The count is almost always 0/undercounted and the response is sent while inserts are still in flight — correctness/race bug.
- **[important]** `backend/routes/laptopConnector.js:387` — `acceptProfileField` forwards to an internal URL built from `req.get('host')` (client-controlled `Host`) when `ANYA_SELF_BASE_URL` is unset, attaching the caller's `authorization`/`cookie` headers — SSRF / credential-forwarding. Use a configured trusted base URL.
- **[nit]** `backend/routes/laptopConnector.js:108` — `text` length is unbounded (stored and analyzed); no size guard.

### backend/routes/larry.js
- **[nit]** `backend/routes/larry.js:234` — `/outreach/:attemptId/send` approval gate `if (!attempt.approved_at && !attempt.approved_by_user_id)` passes when either field is set; a partial write (one field only) is treated as approved.
- **[nit]** `backend/routes/larry.js:305` — `void PROSPECT_STATUS` — imported only to suppress an unused-import lint error; dead import.

### backend/routes/legacyFunctions.js
- **[critical]** `backend/routes/legacyFunctions.js:150` — `/crawlGrantsGov` (and `/crawlBenefitsGov` `:206`, and the other crawl endpoints through `:671`) have no admin/automation authorization — only `requireAuthenticatedUser` (+ for some, `requireTierCapability`). Any authenticated user with the crawling tier can trigger a full Grants.gov crawl; no admin gate on an automation surface.
- **[important]** `backend/routes/legacyFunctions.js:451` — `/crawlSourceDirectory` correctly fetches the row then `ensureOrg` on `row.discovered_for_organization_id` (404-then-org-check); contrast with `/crawlGrantsGov` which has no org/admin scoping at all.
- **[nit]** `backend/routes/legacyFunctions.js:354` — `await req.db.prepare(...).get(String(orgId))?.count`: `?.count` is accessed on the Promise before `await` resolves (async dialect), so `existing` may be `undefined`/`NaN`, defeating the "seed only if none exist" guard. Verify the DB wrapper's `.get()` semantics.
- **[nit]** `backend/routes/legacyFunctions.js:167` — `setImmediate(async () => {...}, 0)` — `setImmediate` ignores the trailing `0` (setTimeout syntax); harmless copy-paste.

### backend/routes/matching.js
- **[important]** `backend/routes/matching.js:189` — `GET /profile/:profileId/grants` uses `row.id` (from `fo.*`) to decide opportunity-vs-grant shape; works because `fo.*` columns are NULL when unjoined, but `row.title`/`row.deadline` silently come from `fo.*` and shadow grant columns — fragile, correctness depends on alias collisions. (Not a security bug; authz is correctly enforced via `requireProfileAccess`/`ensureProfileAccess`.)
- **[nit]** `backend/routes/matching.js:300` — `min_score` parsed with no clamp (later guarded by `Number.isFinite`).
- Note: dialect literals (`isPostgres ? 'TRUE' : '1'`, `CURRENT_DATE`) are interpolated but hardcoded; all user-supplied values are parameterized — no injection.

### backend/routes/milestones.js
- **[important]** `backend/routes/milestones.js:135` — `POST /` does not persist `organization_id` on the milestone row, yet `GET /` filters on `COALESCE(m.organization_id, g.organization_id)`. Scoping relies entirely on the grant join; if the grant is later deleted/unlinked the milestone is orphaned and `ensureMilestoneAccess` (`:56`) returns 403 forever (no org fallback). Data-model gap.
- **[nit]** `backend/routes/milestones.js:89` — `console.warn(..., { userId: user.id })` logs `user.id` but the context uses `user.userId`; `user.id` is likely `undefined`.
- **[nit]** `backend/routes/milestones.js:121` (and elsewhere) — error handler returns `error.message` to the client.
- Note: `:id` routes go through `ensureMilestoneAccess` (org access check) — no IDOR.

---

## Cross-cutting patterns
- **Historical non-canonical admin checks (remediated in the named routes)**: `billing.js`, `blocklist.js`, `committedCollege.js`, `hamiltonAutomation.js`, `applicationTasks.js`, and `discovery.js` now gate admin behavior on canonical `req.ctx.isAdmin`. Re-verify any new or legacy route separately; the deprecated raw-role helper still exists for compatibility and must not be treated as proof that all callers are safe.
- **Raw `error.message` leaked to clients** across many files (applicationDrafts, applicationWorkflow, contacts, contactMethods, crawlerV2, discovery, expenses, grantApplications, billingSettings, milestones, admin).
- **Client-supplied primary keys / mass-assignment** of `id`/`created_by`/`approved`: applicationDrafts.js:100, budgets.js:145, contactMethods.js:110/130, expenses.js:120, billingSettings.js:81.
- **`Host`-header-derived internal `fetch` (SSRF + credential forwarding)**: anyaMatchSuggestions.js:101, laptopConnector.js:387 (and the `getInternalBaseUrl` pattern referenced in anya.js).
- **Un-awaited `.get()?.count` on the async/postgres path**: crawlerV2.js:38, legacyFunctions.js:354 (silently yields 0/undefined).


---

# Backend Routes Audit — N–Z

Scope: all `backend/routes/*.js` whose filename begins with a letter n–z.

Convention note: the global middleware in `backend/server.js` (~line 1602–1648) only *attaches* `req.user`/`req.ctx`; it does NOT enforce authentication. Each route must guard itself (via `ensureAuth`, `requireAuthenticatedUser`, or `req.ctx?.userId` checks). The Stripe webhook is correctly mounted with `express.raw({ type: 'application/json' })` (`server.js:479`).

---

### backend/routes/stripe.js
- **[nit]** `backend/routes/stripe.js:104-115` — `getQuote`/latest-quote resolution swallows errors with only a `routeLogger.warn`, then proceeds; acceptable (best-effort discount linkage) but means a DB fault silently drops approved discounts. Verified intentional by the resolver design.
- **[nit]** `backend/routes/stripe.js:154-156` — Idempotency key embeds `final_amount_cents`; if a price changes between two checkout attempts for the same purchase/phase the key changes and a second Stripe session can be created. This is by design (price drift should re-quote), noted for awareness.
- File is otherwise solid: every endpoint is `ensureAuth`-gated, purchases are ownership-checked (`String(purchase.user_id) !== String(userId)` → 403, lines 64, 253), milestone ordering is enforced server-side (lines 72-90), price is resolved server-side via `resolveChargeForQuote` (clients cannot set amounts), hourly invoices are de-duplicated (lines 288-293), and the admin mapping-status route is `ensureAdmin`-gated. SQL is parameterized throughout.

### backend/routes/stripeWebhook.js
- **[nit]** `backend/routes/stripeWebhook.js:96-97` — When `phase` is an unrecognized milestone phase, the code `console.warn`s but then still runs the milestone UPDATE marking it `'paid'` (`newStatus` is null so only the purchase-status update is skipped). Harmless given upstream validation in stripe.js, but the warn-then-proceed reads as if it should skip.
- **[nit]** `backend/routes/stripeWebhook.js:213-224` — On handler failure the response leaks `error.message` to the (Stripe) caller. Low risk since the consumer is Stripe, not an end user, but diverges from the "generic error to client" convention.
- Verified secure: signature verification uses the raw body via `stripe.webhooks.constructEvent` (`stripeService.js:152`) and is mounted with `express.raw` (`server.js:479`); a missing signature is rejected 400 (line 52); idempotency is enforced via `recordStripeEventIfNew` with a unique `event_id` insert (`stripeService.js:155-168`) and duplicate events short-circuit (line 71); forged `quote_id` metadata is cross-checked against the purchase's profile before granting access (lines 174-188); a 0-row UPDATE refuses to grant access (lines 199-200). DB writes use synchronous `req.db.transaction(() => {...})()`.

### backend/routes/vehicles.js
- **[critical]** `backend/routes/vehicles.js:117` — `POST /ingest` has NO authentication and NO rate limiting (router defines no auth middleware; `server.js:1962` mounts it bare). Any anonymous caller can insert arbitrary rows into `vehicle_opportunities` (data poisoning / storage exhaustion), and each insert triggers `scheduleDebouncedVehicleSync(db)` which pushes to GitHub — outbound write amplification. This is the most exposed write endpoint in the range.
- **[nit]** `backend/routes/vehicles.js:43-44,60-63` — `data.price = Number(body.price)` accepts negatives/absurd values; `detectScam` only rejects `viper` under $10k, so negative or zero prices pass. Data-quality gap given the endpoint's scam-filtering intent.

### backend/routes/realCrawlers.js
- **[critical]** `backend/routes/realCrawlers.js:923` — `GET /find-profile` has NO `ensureAuth` (every sibling route has it) and runs an unscoped `SELECT id, display_name, primary_type FROM profiles WHERE display_name LIKE ?`. Any unauthenticated caller can enumerate every tenant's profile names/IDs via `?name=`, enabling cross-tenant disclosure and profile-ID harvesting for downstream IDOR.
- **[important]** `backend/routes/realCrawlers.js:249,786,1441` — Expensive crawl endpoints (`/run`, `/run-multiple`, `/run-housing`) are `ensureAuth`-gated but have no rate limiter, unlike `/run-smart` (line ~1157) which correctly adds `standardRateLimiter`. `/run-multiple` loops `runCrawler` over an arbitrary-length `crawler_types` array; abusable for resource exhaustion / outbound-request amplification by any authenticated user.
- **[important]** `backend/routes/realCrawlers.js:1441` — `/run-housing` comment says "Admin or authenticated user" but only checks `ensureAuth`, then bypasses the request-scoped `req.db` by calling `getDb()` to grab the global handle and run a write-heavy seeding crawler. Any authenticated user can trigger a global DB-mutating ingestion job; not admin-gated, not rate-limited.
- **[nit]** `backend/routes/realCrawlers.js:740` — `threshold_fallback_message` is set twice in the same `res.json` object literal (explicit key plus a spread). Harmless duplicate.

### backend/routes/opportunities.js
- **[important]** `backend/routes/opportunities.js:389` — `GET /` (list/search) has no auth gate at all; it returns funding-opportunity catalog data. This is likely intentional (public catalog), but it is the only list route in the range with zero authentication — confirm the catalog is meant to be public.
- **[nit]** `backend/routes/opportunities.js:478-485` — Search builds `%...%` LIKE patterns from user input without escaping `%`/`_`; parameterized so no injection, but a search term with wildcards matches unexpectedly broadly.
- **[nit]** `backend/routes/opportunities.js:1133` — CSV export interpolates `safeWhereClause` into the SQL string; the clause is built only from hardcoded fragments with user values bound via `?`, so it is not injectable (the `safeWhereClause`/`audit:allow` naming is deliberate). The export route is correctly `requireAuthenticatedUser` + `isAdminUser` gated (lines 1088-1092).
- Positives: limit is hard-capped via `MAX_LIMIT` (line 407), offset floored at 0, geo-index fallback handles schema drift, and trust/compliance filtering is consistent with discovery/matching.

### backend/routes/profiles.js
- **[nit]** `backend/routes/profiles.js:135-167` — `router.param('id', …)` centrally re-validates profile access on every `:id` route (good IDOR defense); the precheck soft-deletes 404 and falls back to ownership-by-userId. Robust. Note the broad `catch` calls `denyAuth` on any precheck error, so a transient DB fault denies rather than 500s — intentional.
- **[nit]** `backend/routes/profiles.js:1356,1481,1499` — `GET /:id/readiness` and `/readiness/detailed` rely solely on the `router.param('id')` access gate (no in-handler authz), which is correct given the param middleware, but they also leak `error.message` to the client on 500 (lines 1492, 1506).
- **[nit]** `backend/routes/profiles.js:197-198` — `multer` filename uses `file.originalname.split('.').pop()` for the extension with no sanitization of the original name; the generated `${unique}.${extension}` prefix is random so path traversal is not possible, but a crafted extension is stored verbatim. Low risk (random basename, image-only filter).
- Positives: list endpoint is rate-limited (`listProfilesLimiter`) and create is rate-limited (`createProfileLimiter`); admin vs. accessible-id scoping is enforced; profile creation runs inside `withTransaction`; SQL is parameterized.

### backend/routes/notifications.js
- **[nit]** `backend/routes/notifications.js:35-38, 99-102, 141-143` — Each handler probes `SELECT 1 FROM notifications LIMIT 1` in a try/catch to detect a missing table, treating ANY error (not just "no such table") as "table absent" and returning empty/404/ok. A transient DB error is thus masked as "no notifications," which could hide real failures. Minor.
- Otherwise clean: every route checks `requireAuthenticatedUser` then `userId`, all queries are `user_id`-scoped (lines 44, 108, 150), updates verify ownership and 404 on 0 rows changed. Parameterized SQL.

### backend/routes/savedGrants.js
- **[nit]** `backend/routes/savedGrants.js:171, 215, 252, 285` — All four handlers return `err.message` directly to the client on 500, leaking internal error text (table/column names on schema drift). Diverges from the gated-error convention.
- **[nit]** `backend/routes/savedGrants.js:33-41` — `resolveActiveProfileId` honors a client-supplied `?profile_id=`/`X-Profile-Id` with no verification that the authenticated user may use that profile. Saves/lists are still constrained by `user_id` in the WHERE clause (lines 107, 240, 274), so a forged profile_id only scopes within the caller's own rows — not a cross-tenant leak, but the profile value is otherwise untrusted.
- Positives: profile-scoped saves (RC-14), `ON CONFLICT … WHERE profile_id IS NOT NULL` upsert is correct, schema-drift fallback to a minimal projection avoids 500s, parameterized SQL throughout.

### backend/routes/preferences.js
- **[nit]** `backend/routes/preferences.js:214-225` — `PUT /` builds the UPDATE column list dynamically, but every key is filtered against `allowedFields = Object.keys(DEFAULT_PREFERENCES)` before being interpolated, so only whitelisted column names reach the SQL — not injectable. Values are bound via `?`.
- **[nit]** `backend/routes/preferences.js:251-261` — `POST /reset` does `DELETE` then `INSERT` without a transaction; a failure between the two leaves the user with no preferences row (the GET handler self-heals by recreating defaults, so impact is limited).
- Clean otherwise: all routes check `req.ctx?.userId` → 401, all queries `user_id`-scoped, dialect-aware `::jsonb` casts, custom_preferences merged not replaced.

### backend/routes/stats.js
- **[nit]** `backend/routes/stats.js:96` — `opportunitiesFound` hardcodes `is_active = 1` rather than using a dialect-aware boolean (`sqlBool`), unlike the rest of the file. On Postgres `is_active = 1` may error or mis-evaluate against a boolean column; verify the column type. Other aggregates correctly scope by accessible profile/org ids.
- Positives: admin sees DB-wide totals, non-admins are scoped via `inClause` which returns `1 = 0` (honest zeros) for empty access sets — no data leak; rate-limited via `standardRateLimiter`; parameterized SQL.

### backend/routes/outreachLogs.js
- **[nit]** `backend/routes/outreachLogs.js:62-68` — `GET /` returns an empty 200 when no profile context resolves, but the client can supply `?profile_id=`/`X-Profile-Id`; `ensureProfileAccess` (lines 34-58) does properly validate ownership/admin before returning rows, so there is no IDOR. Good.
- Clean: create validates `funder`/`method` against an allowlist, parses `occurred_at`, scopes every operation through `ensureProfileAccess`; delete re-checks access on the row's `profile_id` (lines 220-224). Parameterized SQL, dialect-aware insert.

### backend/routes/sourceDirectory.js
- **[nit]** `backend/routes/sourceDirectory.js:79-82, 94-97, 160-163, 224-226, 240-243` — Every catch returns `error?.message || String(error)` to the client (internal-error leakage). Low severity but consistent across the file.
- **[nit]** `backend/routes/sourceDirectory.js:141, 203` — The `name`-required validation is implemented via an IIFE that `throw`s *inside* the `.run(...)` argument list, which is caught by the outer try and surfaces as a 500 rather than a clean 400. Should validate before the INSERT/UPDATE and return 400.
- Positives: every route is `requireAuthenticatedUser`-gated and organization-scoped via `ensureOrganizationAccess` / `getAccessibleOrganizationIds` (lines 39, 54-62, 92, 173, 236) — proper tenant isolation and IDOR protection. Parameterized SQL.

### backend/routes/version.js
- **[nit]** `backend/routes/version.js:74` — `GET /` is public and exposes commit SHA, branch, environment, and Node version. Standard for a deploy-version endpoint but is unauthenticated infrastructure disclosure; acceptable, noted.
- **[nit]** `backend/routes/version.js:47-49` — Falls back to `execSync('git …')` at runtime if env SHAs are absent; safe here (no user input in the command) but shelling out from a request path is a smell. Result is cached after first call.

### backend/routes/programs.js
- **[nit]** `backend/routes/programs.js:41,98` — `buildFilters` accepts/threads a `dialect` param that is never used (LIKE applied unconditionally); dead plumbing.
- **[nit]** `backend/routes/programs.js:71-77` — Search LIKE does not escape `%`/`_`; parameterized so no injection, just over-broad matching.
- **[nit]** `backend/routes/programs.js:103,117,190` — `${table}` interpolated into SQL, but `table` comes only from `tableForTrack()` (hardcoded literals or throw) — not injectable. Noted.

### backend/routes/reminders.js
- **[nit]** `backend/routes/reminders.js:173` — `fetchReminderSnapshot` injects scoping via `String.replace('WHERE m.completed', …)`, which is tightly coupled to exact SQL text (differs between sqlite/postgres branches). Fragile; prefer building the WHERE clause structurally.
- Otherwise clean: auth enforced (line 191), admin vs. non-admin scoping correct (204-208), stack traces gated behind `NODE_ENV === 'development'` (216-224), correct async/await.

### backend/routes/services.js
- **[important]** `backend/routes/services.js:88,286` — `POST /purchases` and `POST /hourly/time-entry` are state-mutating, money-adjacent endpoints with no rate limiting; `/purchases` performs `MILESTONE_PHASES.length` sequential round-trips plus catalog seeding (middleware) on every call — abusable.
- **[important]** `backend/routes/services.js:39-48` — `GET /catalog` has no `ensureAuth`, unlike every sibling data route. Likely intentional (public pricing) but confirm intent.
- **[nit]** `backend/routes/services.js:168-184` — `req.db.transaction(() => { insertPurchase.run(...) })` uses the synchronous better-sqlite3 transaction API (same pattern as stripeWebhook.js); the un-awaited `.run()` is correct for sqlite but would not sequence/commit correctly if `req.db` is the async Postgres adapter. Verify the transaction shim handles the pg dialect; otherwise this milestone-purchase write is non-atomic on Postgres.
- **[nit]** `backend/routes/services.js:134-135` — Missing milestone price returns 500 for a config/data condition; should be 409/422.
- **[nit]** `backend/routes/services.js:19-28` — Catalog-seed middleware runs `seedServiceCatalogFromExtract(req.db)` on every request to the router; expensive idempotent work on the hot path.

### backend/routes/serviceApplication.js
- **[critical]** `backend/routes/serviceApplication.js:104,178` — `POST /` (contact_admin) and `POST /submit` have NO authentication and NO rate limiting; they write rows to `service_applications` (unbounded) and trigger outbound email via `sendServiceApplicationEmail` (lines ~148, ~237). Unauthenticated email-send + DB-write = spam/email-bomb and storage-exhaustion vector. Needs rate limiting / CAPTCHA.
- **[important]** `backend/routes/serviceApplication.js:167-170,249-252,313-316,388-391` — Multiple handlers leak `error.message` to the client (can expose SQL/table internals in production).
- **[important]** `backend/routes/serviceApplication.js:307` — `JSON.parse(app.selected_services || '[]')` per row with no try/catch; one malformed stored value throws and 500s the whole admin `/list` (and leaks the parse error).
- **[important]** `backend/routes/serviceApplication.js:269,280` — `/list` pagination uses bare `parseInt(limit)`/`parseInt(offset)` with no bounds/NaN guard; unbounded result sets, diverges from `validatePagination` convention.
- **[nit]** `backend/routes/serviceApplication.js:262,327,401,439` — Inline `!req.ctx || !req.ctx.isAdmin` admin checks repeated in four handlers instead of shared middleware; works but risks a future handler being missed.

### backend/routes/sam.js
- **[nit]** `backend/routes/sam.js:203,266` — `Number.isFinite(body.maxFixes) ? body.maxFixes : 10` accepts negatives/huge values unclamped, passed to `runSam`. Admin-only, low risk.
- **[nit]** `backend/routes/sam.js:159-166` — Loopback probe forwards `ADMIN_TOKEN`/`ANYA_ADMIN_TOKEN` + caller Authorization to `host`; well-guarded by `isLoopbackHttpHost` + `adminOnly`. Sensitive surface, no bug found.
- Clean: every non-health route is `adminOnly`, repair-safe is env+admin double-gated, errors are generic (no stack leak), `/runs` limit clamped.

### backend/routes/samOnboardingAudit.js
- **[nit]** `backend/routes/samOnboardingAudit.js:46,61,71,83,93,103` — Error responses return `err?.message` to the client (internal-error leakage on admin routes).
- Auth correct: `router.use` guard runs `requireAuthenticatedUser` (401) then `isAdminUser` (403) for all routes.

### backend/routes/onboarding.js
- **[important]** `backend/routes/onboarding.js:142-187,210-268,277-578` — Intentionally public endpoints with NO rate limiting. `/start` inserts an `onboarding_sessions` row per call (unbounded resource creation); `/complete` triggers user/credential creation + OTP email send (lines ~332, ~521) for any attacker-supplied email — unauthenticated email-bombing / account-spam vector. The IP is hashed for audit (line ~161) but never used to throttle.
- **[nit]** `backend/routes/onboarding.js:567-569` — `preview_code` (the real 6-digit OTP) is returned in the response when `NODE_ENV !== 'production'`; correct gating but leaks live codes on any non-prod deployment that forgets `NODE_ENV=production`. Same `NODE_ENV` dependency for stack detail (184, 575).
- Positives: parameterized SQL, sessions loaded by UUID, ordered/completed-session guards return 409.

### backend/routes/schoolPortal.js
- **[historical finding; remediated]** School-portal partner-key administration now authorizes only through canonical `req.ctx.isAdmin === true`; the raw-role shortcut was removed.
- **[important]** `backend/routes/schoolPortal.js:176-203` — `GET /students/:external_student_id` returns full merged profile PII but, unlike `/matches` (lines ~217-223), does NOT check `link.consent_status === 'revoked'`. A partner whose student revoked consent can still read the full profile. Inconsistent consent enforcement.
- **[nit]** `backend/routes/schoolPortal.js:124-168` — `/students/sync` iterates `records` with no upper bound on array length; each element triggers a DB merge. Add a cap.
- **[nit]** `backend/routes/schoolPortal.js:325` — Several admin handlers have no try/catch; a DB error becomes an unhandled rejection relying on Express's default handler.
- Positives: partner routes `requireSchoolPartner`-gated, `findLink` scoped by `school_partner_id` (no cross-partner IDOR), API keys hashed and returned once, revoke is partner+key scoped.

### backend/routes/studentPortals.js
- **[historical finding; remediated]** `studentPortals.js` handles admin solely through `req.ctx.isAdmin`; non-admin access requires an actual `Set` containing the profile. A `null`/non-Set accessibility result no longer acts as a second allow-all branch.
- **[nit]** `backend/routes/studentPortals.js:185-199` — `/classify-preview` only enforces `userMayAccessProfile` when `profile.id` is present; a caller can pass a profile object with no `id` to bypass the access check. Preview-only/non-persisting, low impact.
- **[nit]** `backend/routes/studentPortals.js:141-181` — `/link-student-portal` trusts caller-supplied `body.opportunity`/`body.profile` over DB rows when present; the access check only validates `profileId`, not that `body.profile` matches it. Integrity smell.
- Positives: every route calls `requireAuthenticatedUser` + `userMayAccessProfile`; writes go through `withProfileScope`; create-time enums validated.

### backend/routes/organizations.js
- **[nit]** `backend/routes/organizations.js:20,45` — `ensureAuth` applied router-wide via `router.use(ensureAuth)` AND redundantly re-listed on each route. Dead duplication.
- **[nit]** `backend/routes/organizations.js:91-95` — Inner try/catch logs then re-throws straight into the outer catch which also logs; double-logging, inner block adds nothing.
- **[nit]** `backend/routes/organizations.js:100-102` — `GET /` runs `mergeProfileSectionsIntoOrg` per row (2 queries each) — N+1 fan-out, bounded by pagination.
- Positives: list/get/update/delete call `ensureOrganizationAccess` (tenant IDOR protection); UPDATE/INSERT use `sanitizeColumns` against an allowlist + parameterized placeholders; sort/order whitelisted via `resolveOrgListSort`.

### backend/routes/nfPrograms.js
- **[nit]** `backend/routes/nfPrograms.js:99-114` — `tableForTrack` interpolates the table name into SQL, but `table` derives only from `normalizeTrack` (returns `TRACK_A`/`TRACK_B`/null) and is re-validated against `ALLOWED_TABLES` — not injectable.
- Clean: filters parameterized, limit clamped 1–500, offset ≥ 0.

### backend/routes/opportunityHelpers.js
- **[nit]** `backend/routes/opportunityHelpers.js:2-3` — Creates `routeLogger` that is never used (dead). Pure helper module, no Express routes.
- **[nit]** `backend/routes/opportunityHelpers.js:118-125` — `dedupeKeyFromRow` computes `deadlineIso` eagerly even when a URL key is returned early — wasted work on the common path; not a bug.
- Logic correct: `parseLooseDate` returns null for undated strings (recall-preserving), `isExpiredOpportunity` exempts directory/rolling/ongoing and compares in UTC.

### backend/routes/vnextApplications.js
- **[important]** `backend/routes/vnextApplications.js:125-145` — The Postgres-branch INSERT uses `?` placeholders mixed with `${nowExpr}` interpolation and `ON CONFLICT … DO NOTHING`. The rest of the codebase uses explicit `$1` for pg paths; if the pg adapter does not rewrite `?` → `$n`, this INSERT throws at runtime on Postgres. Verify the adapter.
- **[nit]** `backend/routes/vnextApplications.js:23-36` — `vnextEnabled` calls `isFeatureEnabled(req.db, …)` without `await`; if that function is async the flag is always truthy (a Promise) once env is unset — a potential feature-gate bypass. Confirm it is synchronous.
- Positives: every handler calls `requireAuthenticatedUser` + `requireVNext`; reads/writes go through `ensureProfileAccess` on the row's `profile_id` (good IDOR protection); parameterized SQL.

### backend/routes/profileTypes.js
- **[nit]** `backend/routes/profileTypes.js:53,69` — Both routes are public (no `ensureAuth`) but return only static registry metadata (no DB/user data) with public `Cache-Control`. Intentional and safe.

### backend/routes/pricing.js
- **[important]** `backend/routes/pricing.js:14-16,200` — `/recommend` is documented as called by Anya/intake on completion, but it sits under `router.use(requireAdmin)` (line ~91). If Anya/intake is a non-admin/system caller, those calls are 403'd — a likely functional break (stale comment or broken integration). No security hole; it is locked down.
- **[nit]** `backend/routes/pricing.js:60-88` — `GET /my-estimate/:profileId` authenticates the user but does NOT call `ensureProfileAccess(:profileId)`; it fetches `listQuotes(..., { limit: 1 })` then `.find(q => q.profile_id === req.params.profileId)`. Low impact (returns only a non-binding message + catalog version, and `limit:1` rarely matches) but diverges from the profile-scoping convention.
- **[nit]** `backend/routes/pricing.js:97-102` — `POST /discount-rules` is an admin no-op that echoes `req.body`; dead/placeholder code in production.
- Price-manipulation: clients cannot set prices (server derives quotes via `buildRecommendedQuote`); all mutation endpoints admin-gated. No abuse path found.

### backend/routes/robert.js
- **[nit]** `backend/routes/robert.js:140-147` — All eight admin run-control endpoints (trigger expensive crawl/AI runs via `runRobert`) are admin-gated but not rate-limited; an admin-token leak allows unbounded expensive runs.
- **[nit]** `backend/routes/robert.js:63-79` — `adminOnly` compares a static env token via `timingSafeEqual` (constant-time, length-guarded — good); leaks only token length on mismatch, negligible.
- Positives: user-facing recommendation routes use `requireAuth` + `ensureProfileAccess` on the recommendation's own `profile_id` (no cross-profile IDOR); `/recommendations/stream` registered before `/:id`; errors funneled through `handleError` (masks secrets, truncates, no stack leak); parameterized SQL via the service layer.


---

# Backend Services Audit — Loose files g–o (`backend/services/*.js`, maxdepth 1)

Read-only audit. Scope: top-level service files in `backend/services/` whose filename starts with letters g–o. Subdirectories excluded.

Severity legend: **critical** (exploitable / data-loss / cross-tenant), **important** (real bug or security gap, conditional on caller), **nit** (minor / cosmetic / latent trap).

---

### backend/services/geoCrawlRunStore.js

- **[important]** `backend/services/geoCrawlRunStore.js:390` — `findCrawlerJobByGeoRunId` builds the Postgres LIKE pattern via string interpolation `` const likePat = `%"geo_run_id":"${id}"%` `` then binds it (`.get(likePat)`). Bound, so not classic injection, but `id` is not escaped for LIKE metacharacters (`%`, `_`); an `id` containing `%` broadens the match. SQLite branch (line 446) has the same unescaped-LIKE issue.
- **[nit]** `backend/services/geoCrawlRunStore.js:18-180` — `ensurePromise` once-guard has a (effectively zero) race window: ordering relies on single-threaded async execution where `ensured=true` (line 170) is set immediately before the promise is cleared (line 172).
- **[nit]** `backend/services/geoCrawlRunStore.js:335` — `appendGeoCrawlEvent` logs `zip` and free-form `message` at warn level when `runId` is missing; borderline geo PII in logs.

### backend/services/githubSyncVehicles.js

- **[important]** `backend/services/githubSyncVehicles.js:29-39` — `fetchVehicleOpportunities` queries `grant_opportunities` though the file/JSON output is named `vehicle_opportunities` (`data/vehicle_opportunities.json`). Table-name mismatch suggests a copy/paste bug; confirm intended table. No tenant/profile scoping — writes last-100 rows of (presumably global) data to a GitHub repo file; confirm none are profile-scoped/PII.
- **[important]** `backend/services/githubSyncVehicles.js:147` — GitHub PUT failure embeds the full raw response body into the returned message: `` `GitHub API error ${response.status}: ${responseBody}` ``. Unbounded body can leak repo internals if surfaced to client/insecure log.
- **[nit]** `backend/services/githubSyncVehicles.js:166-182` — `scheduleDebouncedVehicleSync` debounce is process-local (`pendingSyncTimer`, `lastSyncAt`). Multiple worker processes each commit independently, defeating the one-commit-per-5-min guarantee and risking GitHub 409 (stale `sha`).
- **[nit]** `backend/services/githubSyncVehicles.js:151` — `lastSyncAt` only updates on success; repeated failures compute debounce delay of 0 each time, so a failing sync retries with no backoff.

### backend/services/grantApplicationApproachAdvisor.js

- **[important]** `backend/services/grantApplicationApproachAdvisor.js:206-239` — Prompt injection into persisted data: untrusted crawled opportunity/grant fields (`description`, `contact_info`, titles, URLs) are fed into the LLM prompt, then `JSON.parse(text)` of model output is persisted to the `grants` table. `application_url`/`portal_url` are re-validated via `normalizeUrl` (good), but `contact_email`, `contact_name`, `contact_phone`, and `application_method` are persisted unvalidated — attacker-chosen contact info could become the grant's official application path.
- **[nit]** `backend/services/grantApplicationApproachAdvisor.js:158-162` — `analyzeAndPersistGrantApplicationApproach` loads grant/funding opportunity with no profile/tenant scoping (`SELECT * FROM grants WHERE id = ?`); relies on the background-task caller to authorize `grantId`.
- **[nit]** `backend/services/grantApplicationApproachAdvisor.js:239` — model output only loosely bounded (`.slice(0, 10)` on steps); acceptable.

### backend/services/grantsDotGovCrawler.js

- **[important]** `backend/services/grantsDotGovCrawler.js:78` — on a 0-result response logs the entire upstream body: `console.warn('[GrantsGov] search2 returned 0 results; full response:', JSON.stringify(body, null, 2))`. Unbounded log dump on every empty keyword search (20 keywords × pages); noisy, not sensitive.
- **[nit]** `backend/services/grantsDotGovCrawler.js:152-164` — `cryptoSafeId` is a weak non-crypto hash (`hash * 31 + charCode`) despite the name; collisions for opps lacking both `oppNumber` and `oppId` produce duplicate `grants-gov-<hash>` IDs.
- **[nit]** `backend/services/grantsDotGovCrawler.js:130-131` — `parseAmount(opp?.awardFloor) || null`: a legitimate award floor of `0` becomes `null` (0 is falsy). Minor data-fidelity loss.
- **[nit]** `backend/services/grantsDotGovCrawler.js:74` — `hitsNode` shape heuristic is brittle; guarded downstream at line 254 (`!data.oppHits`), so handled.

### backend/services/hamiltonApplicationAgent.js

- **[important]** `backend/services/hamiltonApplicationAgent.js:122-125` — `loadProfile` calls `await withProfileScope({ bypass: true }, async () => null)` (a no-op whose return is discarded) then runs `SELECT * FROM profiles WHERE id = ?` outside any scope. Profile/opportunity/document loads (`loadProfile`/`loadOpportunity`/`loadDocuments`) have no org/tenant guard; only `runHamiltonCycle:330` checks `task.profile_id` vs `profileId`. Relies entirely on the caller passing a correct `profileId`.
- **[important]** `backend/services/hamiltonApplicationAgent.js:380-396, 401-415, 426-440` — `adapter.inspectRequirements(ctx)`, `fillApplication(ctx)`, and `submitApplication(ctx)` are called without `await`. If any adapter method is async, `result` is a Promise and all downstream logic (`result.outcome`, `result.requirements.filter`) operates on a Promise, silently misbehaving. Correctness bug if the adapter contract permits async.
- **[nit]** `backend/services/hamiltonApplicationAgent.js:473-475` — `result.requirements.filter(...)` assumes `requirements` is always an array; an adapter omitting it would throw uncaught. `(result.requirements || [])` would be safer.
- **[nit]** `backend/services/hamiltonApplicationAgent.js:42` — `TASK_STATUSES` imported but never used — dead import.

### backend/services/hourlyRounding.js

- _No issues found._

### backend/services/housingScholarshipCrawler.js

- **[important]** `backend/services/housingScholarshipCrawler.js:611-642` — `isLiveUrl` fetches catalog URLs with `redirect: 'follow'` and no host allow-listing. URLs are a hardcoded curated catalog (low risk today), but it is a general outbound-fetch-on-any-URL sink that follows redirects — an SSRF sink if ever reused with caller-supplied URLs.
- **[nit]** `backend/services/housingScholarshipCrawler.js:709` — success counted when `result.inserted || result.id`; a skipped result with a truthy `id` would over-count `inserted`.
- **[nit]** `backend/services/housingScholarshipCrawler.js:700` — `last_verified_at` stamped even when `validateUrls` is false; the verification gate (opportunityInserter.js:292-294) likely strips it absent proof — harmless dead value.

### backend/services/itemCatalogService.js

- **[important]** `backend/services/itemCatalogService.js:324-330` — `inferNeedsWithAI` interpolates profile-derived `contextSummary` (user-supplied goal/intent text) directly into the LLM `userPrompt` with no delimiting/escaping. Prompt-injection vector; impact limited (output is suggestion names for display) but text is unbounded/unsanitized.
- **[nit]** `backend/services/itemCatalogService.js:533, 540-550` — two `SELECT ... LIMIT 800` scans of `item_catalog`/`funding_opportunities` with no profile scoping in `discoverNewCatalogItems` (admin/global by design; confirm route enforces admin auth).
- **[nit]** `backend/services/itemCatalogService.js:55, 105-116, 364-381` — catalog read/seed/suggest queries not tenant-scoped (`item_catalog` appears global by design); `suggestItemsForProfile` scopes only via `buildProfileContext`.
- **[nit]** `backend/services/itemCatalogService.js:96-98, 510-523, 597-625` — multiple `try {} catch {}` blocks silently swallow per-row insert/update errors; schema drift / constraint violations during discovery are invisible.

### backend/services/itemCrawler.js

- **[nit]** `backend/services/itemCrawler.js:143-150` — dynamic `keywordConditions` are parameterized correctly (bound `?`), and LIKE metacharacters are escaped at line 130, but the SQL lacks an `ESCAPE '\'` clause so the backslash escaping is not honored — `%`/`_` in keywords still act as wildcards. Functional nit, not injection.
- **[nit]** `backend/services/itemCrawler.js:69` — `processItemCrawlerJob` queries `funding_opportunities` with no profile/tenant filter (table appears global).
- **[nit]** `backend/services/itemCrawler.js:57-64` — `loadJSON` returns `[]` on parse failure; assumes a direct-array JSON shape. If `item_funding_sources.json` is an object (`{sources:[...]}` like the gift crawler), iteration silently yields nothing. Verify shape.

### backend/services/itemGiftCrawler.js

- **[nit]** `backend/services/itemGiftCrawler.js:128-184` — upsert loop has no per-row try/catch around `await upsertFundingOpportunity`; a single throwing row aborts the whole job, unlike the sibling `itemCrawler.js:228-301`. Inconsistent error isolation.
- **[nit]** `backend/services/itemGiftCrawler.js:169-170` — persists source-provided `contact_info` with `profile_id: profileId`; `profileId` may be `null` (fallback chain line 75), inserting a null-profile directory row that may not be the intended association.
- **[nit]** `backend/services/itemGiftCrawler.js:95` — passes `{ profile: null }` to `scoreOpportunity` when no profile; throws if `scoreOpportunity` dereferences `profile.*` unguarded. Verify null-safety.

### backend/services/jobBackpressure.js

- **[important]** `backend/services/jobBackpressure.js:205` — `getJobsReadyForRetry` uses `dlq.resolved = FALSE` (and `markExhaustedJobs` relies on Postgres boolean semantics) with no `db.dialect` guard, diverging from the pattern in linkVerificationService.js:228-229 / localCrawler.js:131. On SQLite (test/dev), `resolved = FALSE` won't match `0` rows, silently returning zero retry-ready jobs.
- **[important]** `backend/services/jobBackpressure.js:187` — `now` is built by string-munging an ISO timestamp and compared to `next_retry_at` with `<=`, assuming an exact `YYYY-MM-DD HH:MM:SS` text format. `scheduleJobRetry`/`incrementRetryCount` pass a `Date` (line 163); any format/timezone divergence makes the lexicographic comparison wrong. No try/catch here, so a query error is an unhandled rejection.
- **[nit]** `backend/services/jobBackpressure.js:143` — logs raw `errorForDecision` text which can contain PII/secrets from upstream error messages; also inconsistent use of `console.*` despite importing structured `log`.
- **[nit]** `backend/services/jobBackpressure.js:228-233` — `markExhaustedJobs` uses `retry_count > MAX` while `shouldRetryJob` stops at `>= MAX` (line 48); a job at exactly `retry_count === MAX` and `status='queued'` is never retried *and* never marked `failed` — off-by-one, can linger in `queued`.

### backend/services/knowledgeBaseProcessor.js

- **[important]** `backend/services/knowledgeBaseProcessor.js:84` — Prompt injection: raw `extractedText` from an uploaded KB doc is concatenated into the user message (`Analyze this document:\n\n${textToAnalyze}`) with no delimiting. A malicious doc can override system instructions and emit attacker-chosen `funding_source_urls` that flow downstream; URL-scheme validation (line 265) does not stop syntactically-valid hostile https URLs.
- **[important]** `backend/services/knowledgeBaseProcessor.js:165-219, 226-240` — No profile/tenant scoping: `processPendingKBDocuments` selects `documents WHERE type='knowledge' AND processing_status IN ('pending')` across all tenants, and `extractFundingOpportunitiesFromKB` reads every analyzed KB doc with no tenant filter. Cross-tenant leak if invoked per-request rather than as a single trusted background job.
- **[important]** `backend/services/knowledgeBaseProcessor.js:97` — `JSON.parse(analysisText)` is only caught by the outer try/catch and never schema-validated; `metadata.document_type`, `funding_source_urls`, etc. are trusted as-is downstream (lines 246-298).
- **[nit]** `backend/services/knowledgeBaseProcessor.js:65` — `db.prepare('SELECT 1')` is prepared but never executed; on async drivers it may not validate the connection, so the "fail fast before spending tokens" intent may not hold.
- **[nit]** `backend/services/knowledgeBaseProcessor.js:273,294` — mojibake in warning strings (`'â funding_urls...'`), encoding issue in log/audit text.

### backend/services/linkVerificationService.js

- **[critical]** `backend/services/linkVerificationService.js:101-119` — SSRF: `checkUrl` does `fetch(url, { redirect: 'follow' })` on URLs from untrusted ingested/KB-extracted data with no allow-list and no block on loopback/link-local/RFC1918 hosts. `shouldSkipUrl` only filters a configured skip list and placeholders — it does not block `http://169.254.169.254/`, `http://localhost`, etc. A crafted `application_url` can probe internal services (and follow redirects to them).
- **[important]** `backend/services/linkVerificationService.js:231-288` — Concurrency hazard: each batch fans out with `Promise.all` over rows, all awaiting `update.run`/`recordVerificationEvent`/`hide.run`/`deactivate.run` on the same shared prepared statements/connection concurrently. Fine on sync better-sqlite3, but on an async/pooled Postgres driver interleaving concurrent `.run()` on one shared statement is a correctness/connection-state hazard; the hide+deactivate pair (lines 278-279) is not transaction-wrapped.
- **[nit]** `backend/services/linkVerificationService.js:174,184` — `last_verified_at < ?` compares against an ISO-8601 string; correct only because writes use `new Date().toISOString()` (line 239). Mixing with any non-ISO writer breaks the cutoff filter.
- **[nit]** `backend/services/linkVerificationService.js:336-338` — `getLinkHealthSummary` is not `async` and returns `db.prepare(...).all()` directly; on async dialects the caller gets a Promise, inconsistent with awaited usage elsewhere.

### backend/services/localCrawler.js

- **[important]** `backend/services/localCrawler.js:164-204` — Dedup keys only on `title`; a file opp and a DB opp (or two distinct programs) sharing a title collide and the later is dropped even when application_url/sponsor differ — silent data loss, no logging of the dropped duplicate.
- **[nit]** `backend/services/localCrawler.js:24-31, 121-126` — `loadJSON` catches and returns `[]` (never throws), so the caller's try/catch at 123-126 is dead; a corrupt `local_opportunities.json` silently yields zero file opps with only a `console.warn`.
- **[nit]** `backend/services/localCrawler.js:216-244` — `scoreOpportunity` (non-authoritative ranking score) is used to gate `filteredOpps`/`topOpps` before pipeline insertion via a threshold filter, a soft divergence from the matchingEngine contract that score must not be an acceptance gate (re-routed through `computeMatchDecision` at line 302, so soft).
- **[nit]** `backend/services/localCrawler.js:172,191` — mojibake in skip warnings (`"â missing application_url"`).

### backend/services/matchDecisionEngine.js

- _No issues found._ (Pure re-export shim; every named export exists in matchEngine.js.)

### backend/services/matchEngine.js

- **[important]** `backend/services/matchEngine.js:43` — Dead imports: `DECISION_ACCEPT_MIN` and `DECISION_CONFIDENCE_MIN` imported from `../config/matchThresholds.js` but never referenced (decisioning uses only `ACCEPT_SCORE`/`REVIEW_SCORE`); likely an abandoned confidence gate.
- **[important]** `backend/services/matchEngine.js:2047` — `results._relaxed = relaxed` sets an expando property on an Array; any consumer that spreads/maps/JSON-serializes `results` silently drops `_relaxed`, losing the "threshold relaxed" signal on the wire.
- **[nit]** `backend/services/matchEngine.js:1626-1628` — `scoreOpportunity` mutates the caller-supplied `profileContext` (`profileContext.profileNorm = ...`). Intentional memoization across the loop (lines 2019-2022) but an undocumented input side effect and a race hazard if the same context is scored concurrently.
- **[nit]** `backend/services/matchEngine.js:2260-2265` — `computeMatchDecision` detects "already normalized" via `rawProfile?.entityType !== undefined` / `rawOpportunity?.entityTypesAllowed !== undefined`; raw data that happens to carry those fields bypasses normalization silently, producing inconsistent scoring.
- **[nit]** `backend/services/matchEngine.js:758` — `calculateDeadlineUrgency` treats an unparseable deadline (`NaN` date) the same as "no deadline" (returns 0 urgency) rather than flagging an invalid date string.
- **[nit]** `backend/services/matchEngine.js:907` — `MATCHING_ENGINE_FACET_DEBUG` path logs full opportunity title and facet reasons via `log.info`; increases log volume with opportunity/profile-derived text if enabled in prod.

### backend/services/matchingEngine.js

- _No issues found._ (Deprecated shim delegating to `scoreOpportunity`; behavior matches its documented contract.)

### backend/services/medicalNecessity.js

- **[critical]** `backend/services/medicalNecessity.js:40-46, 282-309` — No tenant/ownership scoping on PHI. `extractMedicalProfile` runs `SELECT * FROM profiles WHERE id = ?` and `generateMedicalNecessityDocument` runs `SELECT * FROM funding_opportunities WHERE id = ?` / `SELECT * FROM grants WHERE id = ?` (lines 301-307) using only raw IDs with no owner/tenant predicate. If IDs come from a request without a route-layer authorization check, any caller can extract another user's full medical/disability profile and generate a medical-necessity letter (IDOR on PHI).
- **[important]** `backend/services/medicalNecessity.js:340-343, 489-499` — Prompt injection of PII into the LLM: `buildDocumentPrompt` interpolates raw profile free-text (conditions, physician name), `additionalContext` from `options` (line 498, attacker-controllable), and opportunity title/description (untrusted ingested data) directly into the OpenAI user message with no sanitization — a meaningful injection surface for a document a physician is told to sign.
- **[important]** `backend/services/medicalNecessity.js:48, 59, 349` — PII-in-logs exposure: `console.error` calls log full DB errors alongside `profileId`; member/insurance IDs are assembled (lines 540-541) and flow into the prompt. One `console`-level change from leaking diagnoses/member IDs; ensure none reach logs.
- **[nit]** `backend/services/medicalNecessity.js:66-69` — `JSON.parse(r.data)` guarded by try/catch (good) but on failure silently skips the section, so corrupt `health_medical` makes the engine behave as if there are no conditions, surfacing later as the confusing "No medical conditions" error (line 295-297).
- **[nit]** `backend/services/medicalNecessity.js:139,144` — `medHist.primary_condition.toLowerCase()` / `sc.toLowerCase()` assume strings; a non-string entry from malformed JSON throws, crashing `extractMedicalProfile` (no try/catch in `extractConditions`).

### backend/services/missionAuditService.js

- **[nit]** `backend/services/missionAuditService.js:19` — `REPO_ROOT = path.resolve(process.cwd())` ties the audit to process CWD; on the Railway backend deploy (no `src/`), `walk()` scans whatever the runtime CWD is, producing noisy/empty results. `missionHealthService.js` pins via `GRANTFLOW_REPO_ROOT` instead.
- **[nit]** `backend/services/missionAuditService.js:152` — dynamic-SQL detector only matches `` db.(prepare|get|all|run)`...` `` on one line; multi-line template SQL or concatenation is undetected. Heuristic gap (acknowledged narrow design).
- **[nit]** `backend/services/missionAuditService.js:173-187` — duplicate tool-registration detection only inspects the same/previous line for `registerTool(`; registrations with `name:` further below are uncounted.

### backend/services/missionHealthService.js

- **[important]** `backend/services/missionHealthService.js:232-236` — `events24h` ORs two dialect-specific clauses in one statement: `WHERE created_at >= datetime('now','-1 day') OR created_at >= NOW() - INTERVAL '1 day'`. One side always throws (SQLite has no `NOW() - INTERVAL`, Postgres has no `datetime()`); `safeGet` wraps it as `{ __error }` and the `.catch(() => null)` never fires (safeGet doesn't reject), so the 24h-events metric is effectively always `null` in production.
- **[nit]** `backend/services/missionHealthService.js:65-79, 239` — `safeAll` returns `[{ __error: ... }]` on failure, a sentinel callers must special-case; only `funnel` (line 259) does, so `coverage_by_source` (line 239) would surface an `{__error}` object straight into the API payload on failure.
- **[nit]** `backend/services/missionHealthService.js:110-114` — `detectModuleUsage` cache key is `JSON.stringify({serviceFiles, consumerFiles})`; object key stability depends on property order, causing silent cache misses.

### backend/services/nationalJobRouter.js

- _No issues found._

### backend/services/needsBasedQueryExpander.js

- **[important]** `backend/services/needsBasedQueryExpander.js:526` — Rule `high_school_college_bound_tennessee` checks `s.applicantTypes?.has(...)` (plural) but `extractSignals` only exposes `applicantType` (singular, line 957), so `s.applicantTypes` is always `undefined` and `?.has(...)` short-circuits. The fallback `s.applicantType === 'student'` compares a `Set` to a string and is always false. The entire applicant-type condition is dead — a real logic bug producing missed TN student-program matches (Tennessee Promise/TSAA/Reconnect).
- **[nit]** `backend/services/needsBasedQueryExpander.js:614` — singular/plural drift (`s.applicantType?.has('youth')` works but the codebase mixes singular/plural freely); a latent trap for future rules.
- **[nit]** `backend/services/needsBasedQueryExpander.js:17-26` — `isTruthy()` (line 17) and `includes()` (line 23) helpers are never called/exported — dead code.

### backend/services/nextStepGuidance.js

- **[nit]** `backend/services/nextStepGuidance.js:218-220` — `buildProfileOnlyGuidance` iterates `coverage.suggestions` with no upper bound (the per-match path slices to 3 at line 79); a profile with many gaps emits an unbounded step list. Minor UX.

### backend/services/opportunityInserter.js

- **[important]** `backend/services/opportunityInserter.js:502-506, 723-732` — The existing-record lookup (`WHERE source = ? AND source_id = ?`) and cross-source URL-dedup (`WHERE source_url = ? OR application_url = ?`) are global, not `profile_id`-scoped, yet the row carries `profile_id` (line 569/803). A profile-scoped opportunity from one tenant can match/update or be deduped against another profile's row sharing the same source_id/URL — tenant-scoping gap on the write path if isolation is intended.
- **[important]** `backend/services/opportunityInserter.js:829-951` — The INSERT uses `@named` params and a Postgres-specific `ON CONFLICT (source, source_id) WHERE source IS NOT NULL ... DO UPDATE` partial-index conflict target, while the UPDATE path (lines 579-673) uses positional `?` params against the same `db.prepare` abstraction. The partial-index conflict clause is a SQLite-dialect risk; confirm the SQLite adapter rewrites it.
- **[nit]** `backend/services/opportunityInserter.js:444-458` — verification-event audit write wrapped in `try {} catch {}` with an empty body; any failure other than missing-table is silently swallowed.
- **[nit]** `backend/services/opportunityInserter.js:413-415, 566` — `reality_reasons` is JSON-stringified at line 413 then re-passed through `serializeRealityReasons()` at line 566; harmless redundant double-encoding guard.

### backend/services/opportunityMatcher.js

- **[important]** `backend/services/opportunityMatcher.js:192` — `SELECT * FROM exclusion_rules WHERE action IS NOT NULL` is not profile/tenant-scoped; exclusion rules apply globally to every profile's matching. If rules are meant per-profile/org, suppression leaks across tenants (could be intentionally global — confirm).
- **[nit]** `backend/services/opportunityMatcher.js:191-194` — `catch { /* table may not exist yet */ }` swallows all errors from the exclusion-rules query, not just missing-table; a malformed row or DB error silently disables exclusion suppression with no log.
- **[nit]** `backend/services/opportunityMatcher.js:288-298` — pipeline idempotency matches on `(funding_opportunity_id = ? OR title = ?)`; title-only matching can falsely treat two distinct opportunities sharing a title as duplicates and skip the save.
- **[nit]** `backend/services/opportunityMatcher.js:217` — `exclusion?.decision === 'WATCH'` -15 penalty is silently skipped whenever the rules query failed (default `{decision:'ALLOW'}` from the catch path).

### backend/services/opportunityNormalizer.js

- **[nit]** `backend/services/opportunityNormalizer.js:482-492` — `requiresWomen` passes an array of `RegExp` objects to `matchesAnyPattern`, which calls `containsSearchPhrase` doing `String(phrase).toLowerCase()` + `.includes()`. A RegExp stringifies to e.g. `/\bfemale\s+students?\b/i`, so `.includes()` looks for that literal slash-delimited string and never matches — the regex women-detection patterns are effectively dead (only the explicit flag and needs-based fallback work).
- **[nit]** `backend/services/opportunityNormalizer.js:369-370` — `NEED_ALIAS_MAP[cat?.toLowerCase()]` silently drops non-string category entries (filtered out by `.filter(Boolean)`); safe but lossy on malformed JSON.

### backend/services/opportunityRealityGate.js

- **[nit]** `backend/services/opportunityRealityGate.js:121-128` — `isOfficialHost` treats any `*.gov`/`*.mil` host as official (intended-but-broad trust assumption); logic is otherwise sound (`grants.gov.evil.com` correctly excluded).
- **[nit]** `backend/services/opportunityRealityGate.js:341,347` — `'link_marked_broken'` can be pushed twice for directory rows, duplicating the reason in `reasons[]`. Cosmetic.

### backend/services/opportunityScope.js

- **[important]** `backend/services/opportunityScope.js:98-113` — `appendWhere` decides WHERE-vs-AND with `/\bWHERE\b/i.test(sql)` against the *entire* SQL string, and `tailRx` matches the first `ORDER BY/GROUP BY/LIMIT` anywhere. For composed SQL with a subquery/CTE WHERE (but no outer WHERE), it appends ` AND ...` to a query with no outer WHERE (syntax error), or splices the scope clause into the middle of a subquery. Safe only for flat SELECTs.
- **[nit]** `backend/services/opportunityScope.js:70-75` — when no `profileId` is given, forces `profile_id IS NULL` (safe public-only default), but any caller that forgets to pass `profileId` silently hides all profile-owned rows with no signal — a foot-gun.

### backend/services/opportunityTrust.js

- **[nit]** `backend/services/opportunityTrust.js:219-223` — `JSON.parse(opp.reality_reasons)` falls back silently on malformed JSON (acknowledged in comment); the malformed-data case is invisible (no warn/metric).
- **[nit]** `backend/services/opportunityTrust.js:385-393` — when `persistedRealityStatus === 'allowed'|'downgraded'`, the code resurrects `display = true` based on the insert-time verdict, which can override a *fresh* time-dependent `expired` hide — an opportunity that has since expired could be force-displayed because the stored verdict predates the deadline passing.

### backend/services/opportunityValidationLayer.js

- **[important]** `backend/services/opportunityValidationLayer.js:219` — `WHERE is_active = ${activeVal}` interpolates `activeVal` (`'TRUE'`/`'1'`) directly into SQL. Value is derived from `db.dialect` (not user input) so not injectable, but it is string-interpolated SQL that violates the parameterized/`toDbBoolean` house style (and is exactly what the mission audit flags).
- **[nit]** `backend/services/opportunityValidationLayer.js:300` — comment says "passes the REVIEW threshold (score >= 25)" but the filter is `s.score >= 5`; stale comment, effective floor is far more permissive.
- **[nit]** `backend/services/opportunityValidationLayer.js:391` — `const result = assertMatchingReturnsResults(...)` assigned but never used (function throws on failure). Dead assignment.
- **[nit]** `backend/services/opportunityValidationLayer.js:19-38` — `isValidRealUrl`, `isLoanLike`, `isMatchingFunds`, `_isPlaceholderUrl`, `extractHostname` imported but never referenced. Dead imports.

### backend/services/opportunityValidator.js

- **[important]** `backend/services/opportunityValidator.js:264-269` — `checkUrlDuplicate` hardcodes `WHERE is_active = 1`. On Postgres `is_active` is boolean, so `= 1` raises `operator does not exist: boolean = integer`, caught at line 280 and logged — URL dedup is silently disabled on every Postgres call (Railway production). Dialect bug.
- **[nit]** `backend/services/opportunityValidator.js:264-279` — even when working, dedup only scans `LIMIT 500` active rows and compares in JS; duplicates beyond the first 500 rows are missed.
- **[nit]** `backend/services/opportunityValidator.js:236-247` — `hasActionableDirectoryLink` returns `true` as its final fallback (line 247), so the earlier `.gov/.edu/.org`/known-directory checks are redundant dead branches — every non-search-engine URL is "actionable."

---

## Summary

Files reviewed: 31 loose service files (g–o). Severity counts: **3 critical**, **23 important**, **~40 nit**.

**Critical:**
1. `linkVerificationService.js:101-119` — SSRF: `fetch(url, { redirect: 'follow' })` on untrusted ingested URLs with no internal-host block (169.254.169.254 / localhost / RFC1918 reachable).
2. `medicalNecessity.js:40-46, 282-309` — IDOR on PHI: profile/grant/opportunity loaded by raw ID with no owner/tenant predicate; another user's full medical profile can be extracted and turned into a physician-signable letter.
3. (PHI/PII exposure also flagged in `medicalNecessity.js` prompt construction and logging, lines 340-343 / 48-59.)

**Top recurring important themes:**
- Dialect bugs that silently no-op in production Postgres: `opportunityValidator.js:264` (URL dedup disabled), `missionHealthService.js:232` (24h metric always null), `jobBackpressure.js:205` (SQLite retry query no-op).
- Missing profile/tenant scoping on write/dedup/exclusion paths: `opportunityInserter.js:502/723`, `opportunityMatcher.js:192`, `knowledgeBaseProcessor.js:165-219`, `hamiltonApplicationAgent.js:122`.
- Prompt-injection of untrusted crawled/uploaded text into LLM calls, some persisted: `grantApplicationApproachAdvisor.js:206` (persists unvalidated contact_*), `knowledgeBaseProcessor.js:84`, `medicalNecessity.js:340`, `itemCatalogService.js:324`.

Also notable: `hamiltonApplicationAgent.js:380/402/426` calls adapter methods without `await` (correctness landmine if any adapter is async), `needsBasedQueryExpander.js:526` has a dead applicant-type condition (`applicantTypes` plural + `Set === 'student'`) causing missed matches, and `opportunityScope.js:98` `appendWhere` is unsafe for subquery/CTE SQL. No SQL injection via user input was found — all genuinely dynamic SQL values are parameterized; the only string-interpolated SQL is dialect-derived boolean literals.


---

# Backend Services Audit — matching / pricing / profile* / documentIngestion / seed

Read-only audit of `backend/services/{matching,pricing,profile,profileIntelligence,profileSignals,documentIngestion,seed}/`. Findings are tagged `[critical|important|nit]` with real file:line references.

---

## matching/

### backend/services/matching/qualityGate.js

- **[important]** `backend/services/matching/qualityGate.js:89` — `stripReferralQuery` is called with a synthetic record `{ url: record?.source_url ?? record?.application_url ?? record?.url }`. When those are all undefined the function returns `null`, silently nulling `normalized.source_url` even though the broader `pickUrl` chain (which also checks `apply_url`/`evidence_url`) had found a usable URL. The two URL-resolution paths diverge and can drop a valid source URL.
- **[nit]** `backend/services/matching/qualityGate.js:73` — `ARTICLE_PATH_RX` is only tested against `url.pathname`, but its character class includes `?#&` delimiters that never appear in a pathname; those alternation branches are dead at the only call site.

### backend/services/matching/reasons.js

- **[nit]** `backend/services/matching/reasons.js:32` — `/\bkeyword|intent|need alignment\b/` has misplaced word boundaries: alternation precedence makes it `(\bkeyword)|(intent)|(need alignment\b)`, so `intent` matches unanchored substrings (e.g. "intentional" trips KEYWORD_MATCH).
- **[nit]** `backend/services/matching/reasons.js:79` — `.filter((code) => MATCH_REASON_CODE_SET.has(code))` is dead/defensive: every code in the set was added from `MATCH_REASON_CODES` literals, so the filter never removes anything.

### backend/services/matching/resultEnricher.js

- **[important]** `backend/services/matching/resultEnricher.js:104-120` — Directory records that would be hard-rejected are converted REJECT→REVIEW and kept (`if (directory && preserveDirectories) { decision = { ...decision, decision: 'REVIEW', ... } }`) with no cap/limit, so a flood of low-trust directory rows can dominate results; `canonicalizeOpportunityList` (line 198) sorts by `match_score` only with no trust/decision tiebreaker.
- **[nit]** `backend/services/matching/resultEnricher.js:159-166` — Trust fields use `opportunity.<field> ?? trustMeta.<field>`, preferring a possibly-stale pre-existing value over the freshly recomputed trust assessment (e.g. `trust_tier: opportunity.trust_tier ?? trustMeta.trust_tier`).

### backend/services/matching/professionalDevelopmentPolicy.js

- **[important]** `backend/services/matching/professionalDevelopmentPolicy.js:249-258` — Cross-category score cap compares `capped !== opp.match_score` where `capped` is a Number and `opp.match_score` may be a string from a DB row (`Number(opp.match_score ?? 0)`), so an already-capped `"25"` rebuilds the object needlessly; also an unscored `undefined` match_score is coerced to 0 then written back as `match_score: 0`.
- **[nit]** `backend/services/matching/professionalDevelopmentPolicy.js:63-74` — `parseCategories`: a string that `JSON.parse`s to a non-array (e.g. `"42"` → `42`) falls past the `Array.isArray` block and returns `[]` without the comma/pipe split fallback (which runs only in `catch`).
- **[nit]** `backend/services/matching/professionalDevelopmentPolicy.js:151` — `programCategories: [...new Set([...expandedCats, ...PD_CATEGORY_CODES])]` always appends the full constant `PD_CATEGORY_CODES`, making per-query `expandedCats` nearly always redundant.
- **[nit]** `backend/services/matching/professionalDevelopmentPolicy.js:268` — `recordLowCoverageEvent` catch logs every failure as "table may not exist yet"; real DB errors (connection loss, constraint violation) are masked behind the benign message while the event is returned as if persisted.

(SQL in this file at lines ~294-307 is parameterized `db.prepare(...).run(...)`; no injection.)

---

## pricing/

### backend/services/pricing/pricingEngine.js

- **[important]** `backend/services/pricing/pricingEngine.js:71,86,131-133` — All money math runs in floating-point dollars (`round2` = `Math.round(n*100)/100`) rather than the integer-cents convention defined in `pricingTypes.toCents/fromCents`. Subtotals, totals, and `base_price*quantity` accumulate float dollars; persisted to `*_cents` only later via `toCents`. Functionally close but diverges from the stated "money as integer cents" invariant and is susceptible to accumulation drift on large multi-line quotes.
- **[nit]** `backend/services/pricing/pricingEngine.js:189-193` — `roundToFriendlyDollars` is only used to build a client-facing estimate string; values < 200 round to nearest 25, fine, but the message at line 186 uses `start.toLocaleString()` with no currency/locale guard (acceptable for USD-only).

### backend/services/pricing/chargeResolver.js

- **[important]** `backend/services/pricing/chargeResolver.js:332-339` — Quote line-item selection uses a fuzzy substring match on the first 6 chars of the service name (`String(li.service_name).toLowerCase().includes(String(catalogService?.name||'').toLowerCase().slice(0,6))`). Two catalog services sharing a 6-char prefix (e.g. "Standard Foundation…" vs another "Standard…") would cross-attribute line-item subtotals into the chargeable base. Prefer matching on `service_key`.
- **[important]** `backend/services/pricing/chargeResolver.js:341-345` — Dead branch: `out.pricing_model === 'milestone' ? expectedDollars : expectedDollars` — both arms are identical, so the ternary has no effect (likely intended to differ).
- **[nit]** `backend/services/pricing/chargeResolver.js:54-58` — `dollarsToCents` returns `0` for non-finite input rather than signaling an error, so a malformed catalog dollar value silently becomes a $0 charge component (mitigated downstream by the catalog-drift guard).
- **[nit]** `backend/services/pricing/chargeResolver.js:314-316` — Milestone split duplicates the `Math.round(totalCents * 0.4)` literal for kickoff and draft in two places (here and lines 370-372); the 40/40/20 split is correct (submission = remainder) but the magic factors are repeated and should be a shared constant to avoid drift with `PAYMENT_TERMS`.

### backend/services/pricing/discountEngine.js

- **[important]** `backend/services/pricing/discountEngine.js:238` — `const approvalNeeded = rule.requires_admin_approval || requireAdminApproval || !autoEnabled`. With defaults (`requireAdminApproval=true`), every recommended discount is forced to `requires_admin_approval=true` and `approved=false` — which is the intended conservative posture, but it means the `autoEnabled`/`rule.requires_admin_approval=false` auto-apply path is effectively unreachable unless `PRICING_REQUIRE_ADMIN_APPROVAL_FOR_DISCOUNTS=false` is also set. Worth confirming this is intended (the discount can never auto-apply on default config).
- **[nit]** `backend/services/pricing/discountEngine.js:314-316` — `fixed` discounts ignore `applies_to_services` weighting: a fixed-amount rule uses `Number(rule.value)` regardless of which line items it applies to, only later clamped to `applicableSubtotal` (line 319). Correct for a flat $ off, but the `applicableSubtotal>0` gate at line 312 still requires the filtered subtotal be positive.
- **[nit]** `backend/services/pricing/discountEngine.js:316` — `Number.isFinite(rule.max_amount) && rule.max_amount > 0`: a `max_amount` of exactly `0` is treated as "no cap" (skips the clamp), which is the right behavior here but is implicit; `null` is the documented "no cap" sentinel.

### backend/services/pricing/pricingRules.js

- **[important]** `backend/services/pricing/pricingRules.js:82,90` — Budget-band boundaries: `annualBudget < small_max` → SMALL else `annualBudget <= mid_size_max` → MID_SIZE. A budget exactly equal to `small_max` (250000) is classified MID_SIZE while a budget equal to `mid_size_max` (2000000) is MID_SIZE — asymmetric `<` vs `<=` at the two boundaries. Confirm intended; the mid-band reason string at line 94 also mislabels the lower bound as `small_max` rather than the actual SMALL→MID cutover.
- **[nit]** `backend/services/pricing/pricingRules.js:222` — `.sort((a, b) => b - a)[0] || null`: if the largest matched amount is `0` it would already be filtered by `n > 0` (line 221), so fine, but `|| null` would also coerce a legitimate falsy first element.
- **[nit]** `backend/services/pricing/pricingRules.js:368` — Fallback hourly quantity `Number(intakeAnswers.estimated_hours) > 0 ? … : 1` trusts a client-supplied `estimated_hours` as the billed quantity with no upper bound; combine with hourly pricing and this is a client-influenced amount (mitigated because the quote is admin-review-flagged on the fallback path, line 373).

### backend/services/pricing/pricingCatalog.js

- No issues found. Catalog is frozen, prices are finite literals, `getServicePrice` returns `null` on unknown category, `catalogIsEthical()` bans contingent/percentage language.

### backend/services/pricing/pricingTypes.js

- **[nit]** `backend/services/pricing/pricingTypes.js:254-258` — `toCents`/`fromCents` correctly use `Math.round`; the rest of the pricing layer (`pricingEngine`, `chargeResolver`, `discountEngine`) does float-dollar math and only converts at the persistence boundary, so these safe helpers are under-used (see pricingEngine finding).

### backend/services/pricing/clientCategoryClassifier.js

- **[nit]** `backend/services/pricing/clientCategoryClassifier.js:46` — `toCatalogCategory` returns `'small'` for any unrecognised input (`CATEGORY_LABEL_MAP[normalized] || 'small'`), silently defaulting an unknown/garbage category to a chargeable tier instead of surfacing it. Callers in `chargeResolver` separately validate via `isCatalogCategory`, but a direct caller could get a silent downgrade.

### backend/services/pricing/quoteBuilder.js

- **[important]** `backend/services/pricing/quoteBuilder.js:257-283` — `editLineItem` builds the column list from caller-supplied `updates` keys (whitelisted to `['service_name','client_category','base_price','quantity','reason']`, good) but `base_price`/`quantity` are written with `values.push(updates[k])` un-coerced — a string `"500"` from the admin form is stored raw, while the recomputed `subtotal` (line 273) uses `Number(...)`. Mixed types in `base_price` vs `subtotal` can desync; coerce on write.
- **[nit]** `backend/services/pricing/quoteBuilder.js:41` — `makeId` uses `Date.now()` + 6 random base36 chars; collision-resistant enough for low volume but not guaranteed unique under burst inserts (no DB unique-constraint retry shown here).
- **[nit]** `backend/services/pricing/quoteBuilder.js:165-166` — `getQuote` orders line items / discounts by `created_at`, but `decodeQuote` (line 305) does not expose `created_at` ordering guarantees to the caller; harmless.

### backend/services/pricing/pricingAccessGate.js

- **[important]** `backend/services/pricing/pricingAccessGate.js:343` — `acceptAgreement` updates with `WHERE profile_id = ? AND user_id IS ?` and binds `userId || null`. SQL `IS` is null-comparison; for a non-null `userId` `user_id IS '123'` is not valid equality semantics in SQLite/PG the way `=` is — this only matches rows where `user_id` is NULL (when `userId` is null) and is unreliable for non-null ids, so a legitimate agreement acceptance can update zero rows. Should be `user_id = ?` (or `user_id IS NOT DISTINCT FROM ?` in PG).
- **[nit]** `backend/services/pricing/pricingAccessGate.js:157` — `agreementAccepted = Boolean(agreement?.accepted) || Number(agreement?.accepted) === 1` is redundant (`Boolean(1)` already true; `Boolean('0')`/`Boolean('1')` both true for string values, so a string `'0'` would read as accepted). If `accepted` can be the string `'0'`, this misreports acceptance.
- **[nit]** `backend/services/pricing/pricingAccessGate.js:38-89` — `ALWAYS_ALLOWED_ROUTES` includes `/Admin` and `/Settings` as prefix-allowed for unpaid users; `isAlwaysAllowedPath` matches `path.startsWith('/Admin/')`, so any `/Admin/*` route bypasses the gate. Correct only if `/Admin` itself enforces admin auth server-side.

### backend/services/pricing/profilePricingInitializer.js

- **[nit]** `backend/services/pricing/profilePricingInitializer.js:253-261` — `rebuildPgFields` re-numbers `$1..$N` via a stateful `i++` inside `.replace(..., () => …)`; correct but fragile, and only exercised when `isPg(db)` (tests use SQLite so this path is largely untested per the code comment).
- **[nit]** `backend/services/pricing/profilePricingInitializer.js:58` — `makeId` same `Date.now()`+random collision caveat as quoteBuilder.
- **[nit]** `backend/services/pricing/profilePricingInitializer.js:116` — `decideInitialAccessStatus` treats `Number(quote?.total||0) <= 0` as a free package → `ACTIVE_PAID` (grants access without payment/agreement). Correct for genuinely $0 quotes, but if a total were ever negative due to over-applied discounts it would also grant free access; the engine clamps total to `>= 0` (pricingEngine:86), so mitigated.

### backend/services/pricing/stripePriceVerifier.js

- **[nit]** `backend/services/pricing/stripePriceVerifier.js:204` — Amount mismatch check `Number(priceData.amount_cents) !== dbAmt` compares integer cents (good), but `dbAmt = Number(r.amount_cents)` is unguarded for `NaN`; a non-numeric `amount_cents` makes `NaN !== NaN` true and reports an `amount_mismatch` with confusing detail rather than a clear data-integrity error.
- **[nit]** `backend/services/pricing/stripePriceVerifier.js:233-241` — `verifyStripePrice` returns `null` when no Stripe client (no key, not mock); `chargeResolver` treats absent verification as "skip Stripe-side check", so a misconfigured prod (missing key, mock off) silently bypasses Stripe unit-amount verification rather than blocking checkout.

### backend/services/pricing/serviceSlugAliases.js

- No issues found. `resolveCanonicalServiceSlug` returns `null` on unknown slugs (explicit failure), map is frozen and exhaustive.

### backend/services/pricing/samPricingAuditor.js

- **[important]** `backend/services/pricing/samPricingAuditor.js:115,127-128` — Quote-math audit sums money in float dollars (`round2(lineItems.reduce((s,li)=>s+Number(li.subtotal||0),0))` and the discount reduce), diverging from the integer-cents convention the gate auditor uses. Can both miss real mismatches and raise false positives from float drift.
- **[important]** `backend/services/pricing/samPricingAuditor.js:149` — Discount-cap check `if (approvedDiscount > cap + 0.01)` uses an arbitrary float epsilon, allowing a discount to exceed the cap by just under a cent unflagged; integer-cent comparison would be exact.
- **[nit]** `backend/services/pricing/samPricingAuditor.js:116,131` — `Number.isFinite(quote.subtotal)`/`quote.total` guards skip the audit entirely for numeric strings from some DB drivers rather than coercing or flagging.
- **[nit]** `backend/services/pricing/samPricingAuditor.js:216-221` — Budget classification boundary (`< small_max` vs `<= mid_size_max`) mirrors the asymmetric boundary in `pricingRules.js`; confirm canonical cutover.

### backend/services/pricing/samPricingGateAuditor.js

- **[important]** `backend/services/pricing/samPricingGateAuditor.js:133` — `n.admin_email.toLowerCase() !== adminNotificationEmail()` compares a non-trimmed stored email against the trimmed `adminNotificationEmail()`, so whitespace in the stored value triggers a false CRITICAL `wrong_admin_notification_target`. Use `isAdminNotificationTarget` on both sides.
- **[nit]** `backend/services/pricing/samPricingGateAuditor.js:146` — Missing-notification check is skipped whenever `profilePricing.created_at` is falsy, so rows without `created_at` evade the `admin_notification_missing` audit.
- **[nit]** `backend/services/pricing/samPricingGateAuditor.js:108` — Cent math is correct but `Number(... || 0)` lacks `Number.isFinite` guards; a non-numeric `total_cents` coerces to `NaN` and yields a confusing mismatch finding.

### backend/services/pricing/samPricingStripeAuditor.js

- **[important]** `backend/services/pricing/samPricingStripeAuditor.js:206` — Re-tag logic keys off categories `'quote_math_drift'`/`'unapproved_discount_in_total'` that `auditQuote` never emits (it emits `subtotal_mismatch`/`total_math_mismatch`/`discount_applied_without_approval`), so genuine quote-math and unapproved-discount violations are never surfaced as CRITICAL in the Stripe report — a silent coverage gap.
- **[important]** `backend/services/pricing/samPricingStripeAuditor.js:231` — Frontend-tamper whitelist uses `('individual','small','mid','large')` but the canonical category is `mid_size` (`CLIENT_CATEGORIES.MID_SIZE='mid_size'`). Every legitimate `mid_size` purchase is flagged CRITICAL `frontend_category_tampered`, while a non-canonical `'mid'` passes — inverted for the mid tier.
- **[nit]** `backend/services/pricing/samPricingStripeAuditor.js:348-354` — Summary `counts` reducer seeds only `{critical,high,medium,info}`; `low`-severity findings (a valid severity) are counted under an unseeded key and disappear from dashboards reading the four known keys.
- **[nit]** `backend/services/pricing/samPricingStripeAuditor.js:107,141` — `resolveAllCatalogCharges`/`verifyStripePriceMapping` awaited without try/catch; a single fetch rejection aborts the whole audit and loses already-computed findings.

### backend/services/pricing/pricingNotificationService.js

- **[important]** `backend/services/pricing/pricingNotificationService.js:143` — `flushQueuedOnLogin` UPDATE is scoped only by `WHERE id = ?`, omitting the `AND admin_email = ?` tenant guard used by `markDelivered`/`dismiss`. Not currently exploitable (preceding SELECT filters by `admin_email`) but diverges from the scoping convention and would update cross-tenant rows if the SELECT changed.
- **[nit]** `backend/services/pricing/pricingNotificationService.js:141-145` — Per-row sequential UPDATEs inside `withProfileScope` are non-atomic; a mid-loop failure leaves some rows delivered and others queued with no rollback. A single set-based UPDATE would be atomic.
- **[nit]** `backend/services/pricing/pricingNotificationService.js:38` — `decodeNotification` swallows `JSON.parse` errors to `null` with no logging; malformed `payload_json` is silently dropped.

---

## profile/

### backend/services/profile/canonicalSignals.js

- **[important]** `backend/services/profile/canonicalSignals.js:163,165,169` — `Number(householdIncome) || null` converts a legitimate `0` to `null` (`0 || null` → `null`); a household income / annual budget / requested amount of exactly `0` is meaningful and gets dropped. Use an explicit `Number.isFinite` check.
- **[nit]** `backend/services/profile/canonicalSignals.js:166` — `householdSize` is passed through un-coerced (no `Number(...)`) unlike the other numeric fields; a JSON string `"3"` survives as a string.
- **[nit]** `backend/services/profile/canonicalSignals.js:130` — `state` truncated via `.slice(0,2)` without validation; `"Kentucky"` becomes `"KE"` (wrong code). Diverges from `profileTaxonomy.normalizeState`'s proper name→code map.

### backend/services/profile/profileTaxonomy.js

- **[important]** `backend/services/profile/profileTaxonomy.js:509-516` — `resolveGeo` county-failure path logs `'ZIP code lookup failed:'` but the failing call is `resolveCountyForZip` (message copy-pasted from the state lookup at line 503), masking the true failing call.
- **[nit]** `backend/services/profile/profileTaxonomy.js:689` — `general_assistance` with zero text tokens still yields ~0.26 confidence with no evidence; evidence-free categories arguably should floor lower.
- **[nit]** `backend/services/profile/profileTaxonomy.js:1041` — Multi-word auto-derived keywords (e.g. "small business") are forced into hard `mustTerms`, which can over-constrain crawler queries.
- **[nit]** `backend/services/profile/profileTaxonomy.js:785` — `signalCoveragePct = canonicalPresent.length > 0 ? Math.max(1, pct) : 0` forces coverage to `1` when sections are present but zero fields mapped, reporting non-zero coverage for an empty extraction.

---

## profileSignals/

### backend/services/profileSignals/index.js

- **[important]** `backend/services/profileSignals/index.js:114` — `deriveIntents` reads `analysis.organization?.type`, but the canonical field is `orgType` (see `canonicalSignals.CanonicalOrganization.orgType`). Unless upstream carries a legacy `type` key, the church/faith-based/nonprofit org-based intent branch never fires — a silent feature gap.
- **[nit]** `backend/services/profileSignals/index.js:522` — Unconditional `log.info(...)` with derived intents on every profile load; noisy on batch crawls, includes derived data — consider debug level.
- **[nit]** `backend/services/profileSignals/index.js:439` — `hasNarrative` only checks `barriers_faced`/`special_circumstances`; a profile with `primary_goal`/`mission` only reports `hasNarrative:false` (debug snapshot only).

---

## profileIntelligence/

### backend/services/profileIntelligence/index.js

- **[important]** `backend/services/profileIntelligence/index.js:35,752-759` — `PRIMARY_TYPE_TO_ENTITY` collapses `student → 'individual'`, so `entityType` is never the string `'student'`; downstream `entityType === 'student'` guards (e.g. needsInference) are effectively no-ops and rely entirely on the separate `isStudent` boolean. Confirm intent.
- **[nit]** `backend/services/profileIntelligence/index.js:807` — `financialFlags: new Set(hardshipFlags)` is a misleading alias — it only ever contains hardship flags; church/nonprofit consumers read `intel.financialFlags` expecting budget signals.
- **[nit]** `backend/services/profileIntelligence/index.js:734` — `state` is upper-cased but not normalized via a name→code map; `"Ohio"` → `"OHIO"` then fails 2-letter `oppState === profileState` comparisons in relevanceScorer/eligibilityFilter, silently breaking geography matching for non-abbreviated states.

### backend/services/profileIntelligence/feedbackLoop.js

- **[important]** `backend/services/profileIntelligence/feedbackLoop.js:235-237` — `feedback_adjustment_delta` is computed as `Math.round(adjusted_score) - scoreResult.total_score`, while `match_explanation` (line 237) recomputes `Math.round(adjusted_score - scoreResult.total_score)`. For fractional scores these two "delta" values can disagree by 1.
- **[nit]** `backend/services/profileIntelligence/feedbackLoop.js:200,209` — `scoreResult.matched_needs.filter(...)` assumes `matched_needs` is always an array; a partial caller object lacking it throws. A `?? []` guard would match the file's otherwise-careful null handling.

### backend/services/profileIntelligence/needsTaxonomy.js

- **[important]** `backend/services/profileIntelligence/needsTaxonomy.js:857` — `resolveNeedFromSynonym` constructs a `new RegExp` per synonym/label on every call with no caching; called per story keyword via `inferFromExplicitKeywords`, this is O(keywords × synonyms) regex compilation — a hot-path cost on large profiles.
- **[nit]** `backend/services/profileIntelligence/needsTaxonomy.js:859` — Tie-break uses `sl.length > bestMatchLength` (strictly greater), so equal-length synonyms from different codes resolve to whichever appears first by object-key order — deterministic but arbitrary/undocumented.

### backend/services/profileIntelligence/needsInference.js

- **[critical]** `backend/services/profileIntelligence/needsInference.js:332` — `inferIndividualHardshipNeeds` checks `(hardshipFlags ?? new Set()).has('food_insecurity')`, but `extractHardshipFlags` (index.js) never adds a `'food_insecurity'` flag (it emits `low_income`, `financial_hardship`, `medical_hardship`, …). The flag-based food branch is dead; food needs fire only via the keyword regex. Producer/consumer name mismatch.
- **[important]** `backend/services/profileIntelligence/needsInference.js:308-309` — Destructures `enrolledPrograms` from `intel`, but `buildProfileIntelligence` never sets it (it lives in profileSignals as `assistancePrograms`); always `undefined` — dead destructure.
- **[nit]** `backend/services/profileIntelligence/needsInference.js:664` — `inferEnergyEfficiency` destructures `entityType` but never uses it (dead destructure).
- **[nit]** `backend/services/profileIntelligence/needsInference.js:433` — `(disabilityFlags ?? new Set())` is dead — the destructure default at line 407 already guarantees a Set.
- **[nit]** `backend/services/profileIntelligence/needsInference.js:448` — Stray leftover edit-marker comment "Remove unused helper function - use inline null checks instead".

### backend/services/profileIntelligence/relevanceScorer.js

- **[critical]** `backend/services/profileIntelligence/relevanceScorer.js:549-571` — `scoreOpportunity` builds `profileData` from `intel` fields that `buildProfileIntelligence` never produces (`intel.isSenior`, `intel.isCaregiver`, `intel.hasDisability`, `intel.medicalConditions`, `intel.emergencyContext`, `intel.businessFlags`, `intel.familyFlags`). All are `undefined`, so the disability/senior/caregiver/medical/business/family rules in `applyRelevanceFilter` are silently disabled for every profile (the intel object exposes `disabilityFlags`, `militaryFlags`, etc., not these names).
- **[important]** `backend/services/profileIntelligence/relevanceScorer.js:142,601` — Need matching uses `fullText.includes(synonym)` with no word boundary, while `eligibilityFilter.extractOppNeedCodes` (line 139) uses `\b`-anchored regex on the same taxonomy. Short synonyms ("van", "PPE", "lift", "shop", "store") substring-match inside unrelated words, inflating `need_fit`/`matched_needs`. The two modules disagree on matching semantics.
- **[important]** `backend/services/profileIntelligence/relevanceScorer.js:589-613` — `needFitScore` recomputes matched-needs inline and then calls `scoreNeedFit` which recomputes the same matching internally; the inline version adds a need on `exampleMatch` alone (line 607) whereas `scoreNeedFit` weights example matches at 0.5 and does not add them, so reported `matched_needs` includes needs that contributed only 0.5 to the score.
- **[important]** `backend/services/profileIntelligence/relevanceScorer.js:228` — `states.map(s => s.toUpperCase())` without String coercion; a non-string element in `states_supported` throws inside the `try` (line 224) and is swallowed to a geography score of `0` — malformed data silently zeroes geography fit.
- **[nit]** `backend/services/profileIntelligence/relevanceScorer.js:220` — `oppState.includes(profileState)` substring-matches a 2-char code; a comma-list opp state can over-match fragments. Prefer exact/token match.

### backend/services/profileIntelligence/eligibilityFilter.js

- **[critical]** `backend/services/profileIntelligence/eligibilityFilter.js:162,170` — `checkGeography` computes `oppState = String(opportunity.state || opportunity.states_supported || '').toUpperCase()` then `.includes(String(profileState))` — when `states_supported` is a JSON-array string like `'["TX","NY"]'`, the substring test runs against raw JSON text and is order-dependent/fragile (a profile state that is a substring of the JSON punctuation can false-pass/fail). The correct array parsing below (line 175) runs only after this.
- **[important]** `backend/services/profileIntelligence/eligibilityFilter.js:336,345,354,363` — Requirement detection runs unanchored regex (e.g. `/veteran only|must be a veteran/`) against untrusted crawled `description` text with no negation handling; a description quoting "this grant is NOT veteran only" still trips `requires_veteran` and hard-rejects an eligible profile.
- **[important]** `backend/services/profileIntelligence/eligibilityFilter.js:392` — `requiresDisaster` regex includes the bare token `/fema/`; any passing mention of FEMA ("unlike FEMA grants…") hard-fails opportunities as `requires_disaster_context`. Over-broad hard blocker.
- **[nit]** `backend/services/profileIntelligence/eligibilityFilter.js:269` — `isLoan` falls back to anchored `/^loan$/i`; descriptive types like `"microloan"`/`"loan guarantee"` slip past the loan hard-filter unless the `is_loan` flag is set.

### backend/services/profileIntelligence/searchPlanGenerator.js

- **[nit]** `backend/services/profileIntelligence/searchPlanGenerator.js:205` — Comment "Skip donor lanes for government entities" is mis-positioned; this line skips the DENOMINATION lane (`!intel.isChurch`), the government skip is line 206.
- **[nit]** `backend/services/profileIntelligence/searchPlanGenerator.js:316` — `truncated = deduped.length - Math.min(deduped.length, maxPlans)` is a redundant computation used only for a debug log; the real slice (line 321) is independent.
- **[nit]** `backend/services/profileIntelligence/searchPlanGenerator.js:182` — `buildExclusions` pushes `'public_facility_only:false'` into the `exclusions` array, but it is semantically an inclusion hint; a consumer treating `exclusions` as filter-out terms would invert the intent.

(No SQL, no LLM-prompt interpolation of profile/document text, and JSON.parse of external input is consistently try/catch-guarded across the profileIntelligence files.)

---

## documentIngestion/

### backend/services/documentIngestion/index.js

- No issues found. Pure re-export barrel.

### backend/services/documentIngestion/detectFileType.js

- **[important]** `backend/services/documentIngestion/detectFileType.js:5-40` — File-type detection trusts the client-supplied `mimeType`/`fileName` extension only; there is no magic-byte/content sniffing, so a renamed/spoofed file (e.g. an executable named `.pdf`, or a PDF claiming `text/plain`) is routed to the wrong parser. There is also no per-file size cap enforced here or in `extractText`/`extractTextWithFallback` (only a post-extraction `clampText` of 250k chars and a PDF page cap) — oversized uploads / zip-bomb-style DOCX (XML expansion) are read fully into a buffer via `fsp.readFile` before any limit applies. Size/type limits must be enforced at the upload/route layer; nothing in this service guards against an oversized or content-spoofed file.
- **[nit]** `backend/services/documentIngestion/detectFileType.js:33` — `safeMime.startsWith('image/')` accepts any image subtype (e.g. `image/tiff`, `image/svg+xml`) but only jpg/jpeg/png are actually OCR-supported downstream; an SVG (XML) routed as an image would be handed to the OCR provider.

### backend/services/documentIngestion/extractText.js

- **[important]** `backend/services/documentIngestion/extractText.js:66` — Copy-paste bug: the PDF branch's read-error warning says `'DOCX file read error: ...'` (should be PDF). Misleads debugging of failed PDF reads.
- **[important]** `backend/services/documentIngestion/extractText.js:49,66` — DOCX and PDF `fsp.readFile(...).catch(...)` handlers push a warning then `throw err`, so a read failure rejects the whole `extractText` call (unhandled at this layer) rather than returning the graceful empty-text result the text/image branches use — inconsistent error handling; callers not wrapping in try/catch get an unhandled rejection.
- **[nit]** `backend/services/documentIngestion/extractText.js:7` — `clampText` truncates to 250k chars with an ellipsis but does not record a "truncated" warning in meta, so downstream consumers cannot tell a document was cut off.

### backend/services/documentIngestion/extractTextWithFallback.js

- **[important]** `backend/services/documentIngestion/extractTextWithFallback.js:99-106` — OCR PDF page cap defaults to 40 (`OCR_PDF_MAX_PAGES`) and DPI 150; both are env-overridable with no hard upper bound, so a hostile env or very large PDF can rasterize an unbounded number of high-DPI pages (CPU/memory/temp-disk exhaustion). The `pdftoppm` exec has a 120s timeout (pdftoppm.js:80) but per-page OCR after rasterization is unbounded in aggregate.
- **[nit]** `backend/services/documentIngestion/extractTextWithFallback.js:139,144` — `ocr_confidence` sentinel of `-1` is set when OCR ran but no finite confidence was returned; `scoreExtraction` later treats `ocr_confidence` via `clamp01` so `-1` clamps to 0 — functional, but a `-1` confidence leaking to other consumers is a magic value.
- **[nit]** `backend/services/documentIngestion/extractTextWithFallback.js:159` — Mojibake in a warning string (`"scanned image with unrecognised content"` preceded by a corrupted dash byte); cosmetic.

### backend/services/documentIngestion/scoreExtraction.js

- **[nit]** `backend/services/documentIngestion/scoreExtraction.js:72` — `score += (clamp01(ocrConf) - 0.75) * 0.4` can push score below earlier method baselines; the final `clamp01` bounds it, but the centering constant `0.75` is a magic number duplicated with the strong-OCR threshold logic (line 57).
- **[nit]** `backend/services/documentIngestion/scoreExtraction.js:6-13` — `isMostlyWhitespace` is duplicated verbatim from `utils.js` rather than imported; divergence risk if one copy changes.

### backend/services/documentIngestion/utils.js

- **[nit]** `backend/services/documentIngestion/utils.js:8-11` — `sha256File` reads the entire file into memory via `fsp.readFile` to hash it; for large uploads a streaming hash would avoid a full-buffer load (ties into the missing size-cap concern).

### backend/services/documentIngestion/heuristics.js

- **[important]** `backend/services/documentIngestion/heuristics.js:102` — Two-digit year handling in `parseDateToISO` hardcodes the `19` century: `if (year.length === 2) year = '19' + year`. A DOB/effective date of `06/19/26` becomes `1926`, not `2026` — systematically wrong for 2000s two-digit years on benefit/insurance documents.
- **[important]** `backend/services/documentIngestion/heuristics.js:140-572` — This module extracts and emits raw PII (Medicaid/Medicare member IDs, recipient numbers, DOB, full name, EIN/UEI/CAGE) from uploaded documents into the profile. Identifiers like `member_id`/`group_id` are highly sensitive; ensure downstream storage/logging redacts them. No leakage bug in this file itself, but it is the PII-extraction surface and the extracted values flow into profile fields and (potentially) LLM prompts — flag for PII-handling review at the consumer.
- **[nit]** `backend/services/documentIngestion/heuristics.js:40` — `extractLabeledValue` builds `new RegExp` from `labelRegex.source` with a permissive `[^\n\r]{2,80}` capture; an attacker-controlled document with a crafted "Mission:" / "Address:" line can inject up to 80 chars of arbitrary text into a profile field that may later be fed to an LLM (prompt-injection vector at the consumer, not here).
- **[nit]** `backend/services/documentIngestion/heuristics.js:357,360` — EIN/UEI fallbacks (`extractFirstMatch(source, /\b([0-9]{2}-[0-9]{7})\b/)`, `/\b([A-Z][A-Z0-9]{11})\b/`) match any 9-digit-dashed or 12-char alnum token even without a label, so an unrelated number on the document can be mis-captured as an EIN/UEI.

### backend/services/documentIngestion/pdf/pdftoppm.js

- **[important]** `backend/services/documentIngestion/pdf/pdftoppm.js:31-47` — `resolveBinary` returns the binary name even when the `-h` probe fails with a non-ENOENT error ("other errors still indicate binary exists"). If `pdftoppm` exists but is broken/misconfigured, the later conversion exec will fail; acceptable, but it can also return a candidate that is not actually runnable. The `pdfPath` is passed to `execFile` (not a shell) so there is no shell-injection, which is correct.
- **[nit]** `backend/services/documentIngestion/pdf/pdftoppm.js:80` — `maxBuffer: 10MB` on the exec captures stdout/stderr; `pdftoppm -png` writes images to disk (prefix), so stdout stays small — fine, but a very chatty stderr could still hit the buffer cap and reject.

### backend/services/documentIngestion/ocr/index.js

- No issues found. Deterministic provider selection with explicit throws on unknown/unimplemented providers.

### backend/services/documentIngestion/ocr/providers/tesseract.js

- **[nit]** `backend/services/documentIngestion/ocr/providers/tesseract.js:53` — `worker.recognize(filePath)` is passed a path with no validation that the file is a supported raster image; a non-image path yields undefined behavior (documented in the comment but not guarded).
- **[nit]** `backend/services/documentIngestion/ocr/providers/tesseract.js:38` — Mojibake in a warning string (corrupted dash before "OCR quality may be degraded"); cosmetic.

### backend/services/documentIngestion/ocr/providers/awsTextract.js

- **[important]** `backend/services/documentIngestion/ocr/providers/awsTextract.js:54-66` — `DetectDocumentTextCommand` is sent with `Document: { Bytes: bytes }` (synchronous, single-page) with no file-size guard; Textract's synchronous API rejects images > 10MB / 5MB depending on type. Combined with the missing upstream size cap, oversized images produce an API error that is caught and returned as an empty-text warning (graceful) but wastes an API call.
- **[nit]** `backend/services/documentIngestion/ocr/providers/awsTextract.js:77` — Average LINE confidence divides by `confs.length` after filtering for finite values; if all lines lack confidence, `confs.length === 0` short-circuits to `null` (no divide-by-zero) — correct, noted as verified.

### backend/services/documentIngestion/documentExtractStore.js

- **[important]** `backend/services/documentIngestion/documentExtractStore.js:240-354` — `tryReuseExtractByHash` copies a previously-extracted `text`/`ocr_text` from ANY `document_extracts` row with a matching `file_hash`, with no tenant/profile scoping (the code comment explicitly notes it "ignores document_id uniqueness"). If two different tenants upload byte-identical files, one tenant's extracted document text (incl. PII member IDs from heuristics) is copied into the other's extract row. Content is identical by hash, but this is a cross-tenant content-reuse path that should be scoped or gated.
- **[nit]** `backend/services/documentIngestion/documentExtractStore.js:29` — Mojibake in the `console.warn` ("â hash-reuse will be unavailable"); cosmetic.
- **[nit]** `backend/services/documentIngestion/documentExtractStore.js:18-20` — `getDocumentExtract` runs `SELECT *` with `LIMIT 1` and no tenant scoping; relies entirely on `document_id` being globally unique. Consistent with the rest of the store but unscoped.

---

## seed/

### backend/services/seed/seedNationalPrograms.js

- **[important]** `backend/services/seed/seedNationalPrograms.js:136` — `inserted: insertedIds.length` reports `0` on every re-seed because `bulkUpsertFundingOpportunities` returns IDs only for newly inserted rows (`opportunityInserter.js:1219`), while upserts/updates return `inserted:false`. The docstring frames re-runs as benign, but a caller logging "0 inserted" as failure will be misled.
- **[important]** `backend/services/seed/seedNationalPrograms.js:119` — Only a null/undefined `db` guard (`if (!db)`); a wrong-typed `db` passes and fails deep inside the bulk transaction, flattened to a string at line 142.
- **[nit]** `backend/services/seed/seedNationalPrograms.js:122,131` — `skipUrlVerification` is computed and passed but the inserter gates URL probing on `opts.skipVerification`/`opts.verifyUrls`/`URL_VERIFICATION_ENABLED` (`opportunityInserter.js:77-81`), never reading `skipUrlVerification` — the flag is dead/ignored.
- **[nit]** `backend/services/seed/seedNationalPrograms.js:96` — `is_national: program.isNational !== false` defaults a missing flag to `true`, silently marking a state-specific program (non-null `state`) as national.
- **[nit]** `backend/services/seed/seedNationalPrograms.js:103` — `eligibility_criteria` and `application_note` both populated from the single `program.applicationNote` field, conflating two distinct concepts.

### backend/services/seed/seedScholarships.js

- **[important]** `backend/services/seed/seedScholarships.js:173` — Same misleading `inserted: 0`-on-re-seed semantics as the national-programs seed.
- **[nit]** `backend/services/seed/seedScholarships.js:155` — Same null-only `db` guard.
- **[nit]** `backend/services/seed/seedScholarships.js:159` — Same dead `skipUrlVerification` flag.
- **[nit]** `backend/services/seed/seedScholarships.js:142-143` — `max_amount` and `priority` are added to the canonical object but the inserter has no such columns (it uses `amount_max`); both are silently dropped on insert.
- **[nit]** `backend/services/seed/seedScholarships.js:107-109` — Eligibility lines interpolate raw `minGPA`/`minACT` into free text without type validation; a non-scalar source value stringifies to `[object Object]`. Not a SQL-injection risk (bound as a parameter downstream).

(Both seed files contain no SQL of their own; all persistence delegates to the parameterized `bulkUpsertFundingOpportunities`. No hardcoded secrets, no tenant-scoping issue — these are global curated catalog rows.)


---

# Backend Services Audit — Loose service files p–z (`backend/services/*.js`, maxdepth 1)

Scope: top-level `.js` files in `backend/services/` whose filename starts with letters p–z (case-insensitive). Subdirectories excluded. 46 files reviewed function-by-function.

Severity legend: **critical** (data loss / security / correctness that breaks core behavior) · **important** (real bug or risk, narrower blast radius) · **nit** (style, dead code, minor robustness).

---

### backend/services/pipelineAutomation.js
- **[important]** `backend/services/pipelineAutomation.js:539-548` — The status `UPDATE` and the audit-event write are not transactional. The grant status is updated, then `recordAutomationEvent` runs separately; if the event insert throws a non-FK error it propagates and aborts the loop after the status was already committed, leaving an advanced grant with no audit trail.
- **[nit]** `backend/services/pipelineAutomation.js:476,494,515` — Several `handoffReason`/`aiSummary` strings contain mojibake (`â`) where an em-dash was intended, e.g. `'Both OpenAI and Anthropic failed â manual review required.'`. Cosmetic, but these strings are persisted to `grant_pipeline_events`.
- **[nit]** `backend/services/pipelineAutomation.js:301,328` — `PROCESSABLE_STATUSES` is expanded into the `IN (...)` list via `statusPlaceholders` (parameterized — safe), but the same list is also spread into `.all(...)` 3+ times; fine, just verbose and easy to desync if the array changes.

### backend/services/pipelineDismissals.js
- **[nit]** `backend/services/pipelineDismissals.js:305-308` — `clearDismissal` builds the DELETE with `OR`-joined identity conditions (`fingerprint`, `opportunity_id`, `lower(title)`). A title-only match can clear tombstones for a *different* opportunity that happens to share a title for the same profile, re-surfacing a deliberately-dismissed source. Documented trade-off (recall over suppression) but worth flagging.
- **[nit]** `backend/services/pipelineDismissals.js:84-92` — Partial unique index creation is wrapped in try/catch and only `log.warn`-ed on failure; the dedup then silently relies on the runtime pre-check, which has a TOCTOU window between `findDismissal` and `INSERT` (the catch at 204-212 handles it, so net-safe).

### backend/services/pipelineGoalCleanupService.js
- **[important]** `backend/services/pipelineGoalCleanupService.js:434` — `buildSelectSql` scopes by `WHERE g.profile_id = ? OR (g.organization_id IS NOT NULL AND g.organization_id = ?)`. The org branch is keyed on `profile.organization_id`, so a profile with an org id will pull in *every* grant sharing that org id — including grants belonging to other profiles in the same org — and may then DELETE them (when `dryRun=false`) attributed to this profile's audit. Cross-profile deletion within an org.
- **[important]** `backend/services/pipelineGoalCleanupService.js:558-566` — In non-dry-run mode, each removed item is deleted in its own statement with a per-row try/catch; there is no transaction wrapping the per-profile removal set, so a mid-loop failure leaves a partially-purged pipeline.
- **[nit]** `backend/services/pipelineGoalCleanupService.js:507` — `selectStmt.all(profile.id, profile.organization_id || '__none__')` passes the literal sentinel `'__none__'`; harmless but relies on no real org id ever equaling that string.

### backend/services/pipelineLifecycleService.js
- **[nit]** `backend/services/pipelineLifecycleService.js:314-315` — Dead code: `const { createRequire } = await import('module')` then `const require = createRequire(import.meta.url)` — `require` is never used below (the inline comment itself says "delete this line entirely"). The comment also contains mojibake.
- **[nit]** `backend/services/pipelineLifecycleService.js:93,145,199` — Status/notes updates build the note via SQL string concatenation of the `deadline` column (`... || deadline || ...`). These are column references (not user input) so no injection, but appending an unbounded `notes || ' | ' || ...` on every run can grow `notes` without limit across repeated passes.
- **[nit]** `backend/services/pipelineLifecycleService.js:41` — `isExpired` compares `deadlineStr.slice(0,10) < today()` as strings; correct only when deadline is ISO `YYYY-MM-DD`. A `MM/DD/YYYY` deadline would mis-sort. (Archive query at line 75 uses the same string `<` comparison.)

### backend/services/portalCheckService.js
- **[critical]** `backend/services/portalCheckService.js:117-125,151-162,198-204,248-255` — SSRF. `fetchUrlOnce` issues server-side GETs to URLs pulled directly from the `university_applications` profile section (`app.portals.*_url`). `isValidUrl` only checks the protocol is http/https — no block on `localhost`, `127.0.0.1`, `169.254.169.254` (cloud metadata), private/link-local ranges, or non-standard ports. Redirects (`res.headers.location`) are followed with the same lack of validation. Response bodies are captured/stored, making this a blind-SSRF + metadata-exfiltration vector.
- **[important]** `backend/services/portalCheckService.js:432-466,693-719` — No authorization check that the caller owns `profileId` before fetching every portal URL attached to that profile. Auth must be enforced upstream; nothing here guards it.
- **[important]** `backend/services/portalCheckService.js:502-509` — `syncAwardToProfile` runs the insert only inside `guardProfileSectionForWrite(...).then(...)`; if the guard rejects, the award write is silently skipped (surfaced only as a caught warning at the caller), so award sync can fail without signal.
- **[nit]** `backend/services/portalCheckService.js:122-124` — Redirect handling recurses (`resolve(fetchUrlOnce(res.headers.location, ...))`) with no depth/loop cap and re-applies the full timeout per hop → unbounded total time on a redirect loop.
- **[nit]** `backend/services/portalCheckService.js:130-132` — On exceeding the 512KB cap, `req.destroy()` is called but the `'end'` handler never fires; the promise settles only via the `error`/timeout path.
- **[nit]** `backend/services/portalCheckService.js:70` — `detectScholarshipAmount` falls back to the largest dollar figure on the page when no award keyword is near an amount, mis-detecting tuition/fees as scholarship awards.

### backend/services/privateFoundationCrawler.js
- **[nit]** `backend/services/privateFoundationCrawler.js:631` — Geographic match uses `geographicScope.toLowerCase().includes(profileState)` (substring); a 2-letter state code can substring-match unrelated scope strings. Latent because registry scopes are single-state or `'national'`.
- **[nit]** `backend/services/privateFoundationCrawler.js:653-658` — `areaLower.split('_')[0]` is dead: line 648 already replaced `_` with spaces, so `split('_')` never splits. Intended first-token extraction never happens.
- **[nit]** `backend/services/privateFoundationCrawler.js:713-715` — DB dedup failure swallowed by a bare `catch {}` with no log, diverging from the structured-logging used elsewhere.
- **[nit]** `backend/services/privateFoundationCrawler.js:629-635,685-693` — Geographic check duplicated between `scoreFoundation` and the main loop (redundant double-filtering).

### backend/services/productionReadinessChecks.js
- No issues found. Pure, env-only checks with explicit level semantics; no DB/SQL/IO.

### backend/services/profileCoverage.js
- No issues found. Pure coverage computation; `coverage = weighted > 0 ? weightedPresent/weighted : 0` guards divide-by-zero; missing fields reduce score without disqualifying (matches mission rule).

### backend/services/profileDedupeService.js
- **[important]** `backend/services/profileDedupeService.js:494-496` — `columnExists` SQLite branch validates `table` against an `ALLOWED_TABLES` allowlist before interpolating into `PRAGMA table_info(${table})` — good — but note `tableName` flows from caller-supplied `repoints`/merge config, so the allowlist is load-bearing; any new repoint target must be added to the list or the column check silently returns false and the repoint is skipped (data left on the loser).
- **[important]** `backend/services/profileDedupeService.js:846,899-917` — `audit_logs` update and insert are wrapped in `try {} catch {}` that swallows all errors silently; a failed audit write during a real (non-dry-run) merge leaves no trace of a destructive profile merge.
- **[nit]** `backend/services/profileDedupeService.js:795` — Active-application guard `status IN (?, ?, ?)` checks only `'submitted','under_review','approved'`; other in-flight statuses (e.g. `pending`) would not block a merge that deletes the loser profile.
- **[nit]** `backend/services/profileDedupeService.js:391-401` — Winner-scoring weights are magic numbers (`sectionCount*50`, `billingCount*40`, etc.) with no named constants; correct but brittle and untestable in isolation.

### backend/services/profileEnrichment.js
- **[important]** `backend/services/profileEnrichment.js:144-152` — `invokeJsonWithFallback` is handed the entire profile payload (display name, signals, existing section data — potential PII) as the prompt with no scrubbing; relies solely on the system-prompt instruction "Never fabricate … sensitive personal identifiers." PII still leaves the system to the LLM provider.
- **[nit]** `backend/services/profileEnrichment.js:187` — Stray comment `// Remove this entire forEach block as it's redundant with the for loop below` references a block that no longer exists — leftover TODO noise.
- **[nit]** `backend/services/profileEnrichment.js:222` — Persisted log note contains mojibake (`â`) where an em-dash was intended.

### backend/services/profileFieldUsageRegistry.js
- No issues found. Pure data registry; correctly enforces `must_not` / `raw_external_use_allowed:false` invariants.

### backend/services/profileGapAnalyzer.js
- **[important]** `backend/services/profileGapAnalyzer.js:275` — `potentialProgramsUnlocked` math is a confused no-op: `totalRequired = g.missingFields.length + (spec.requiredFields.length - g.missingFields.length)` algebraically equals `spec.requiredFields.length`, so the verbose expression reduces to `missingFields/requiredFields` and the comment's "weight by proportion of missing fields" intent is not what the code does (a fully-empty section yields ratio 1.0, not a partial weight).
- **[nit]** `backend/services/profileGapAnalyzer.js:275` — If `SECTION_SPECS.find(...)` ever returned undefined, `undefined - missingFields.length` yields `NaN` silently rather than throwing.
- **[nit]** `backend/services/profileGapAnalyzer.js:179-187` — `countFilledFields` and `totalFieldCount` are dead code (never called).

### backend/services/profileHelpers.js
- **[important]** `backend/services/profileHelpers.js:1224` — `if (financialSection.annual_income && !financial.householdIncome)` couples two distinct fields, so annual-income poverty inference is skipped whenever a household income is already present, even when annual income is the more accurate per-applicant figure.
- **[nit]** `backend/services/profileHelpers.js:1764` — `nowYear - parseNumber(founding_year)`: when `founding_year` is non-numeric, `parseNumber` returns `null`, so `age = nowYear - null = nowYear`; the later `if (age !== null …)` guard is dead because `age` can never be null here.
- **[nit]** `backend/services/profileHelpers.js:169,321-326,502,539,1081` — `console.warn` used for diagnostics instead of the module `log` (createLogger) used elsewhere in the same file; inconsistent (no PII leaked — ids/messages only).
- **[nit]** `backend/services/profileHelpers.js:1846-1851,1930-1938` — Semicolon-prefixed ASI guards with skewed indentation; functionally correct but confusing.

### backend/services/profileNeedsInterpreter.js
- **[important]** `backend/services/profileNeedsInterpreter.js:576-590` — `interpretProfileNeedsFromDb` runs `SELECT * FROM profiles WHERE id = ?` and `SELECT … FROM profile_sections WHERE profile_id = ?` with no tenant/owner scoping. Parameterized (no injection) but allows cross-tenant profile reads if callers don't pre-authorize `profileId`.
- **[nit]** `backend/services/profileNeedsInterpreter.js:514` — Missing-ZIP detection checks only `zip` keys (`p?.zip`, `basic_information.zip`, `location_focus.zip`); profiles that store `postal_code`/`zip_code` instead will false-positive as "ZIP missing", producing a spurious next-step prompt.

### backend/services/profileNormalizer.js
- **[important]** `backend/services/profileNormalizer.js:847-851,1189-1192` — Income parsing uses `Number(fa.annual_income ?? fa.household_income ?? 0)`; a formatted value like `"$24,000"` becomes `NaN`, so low-income/below-poverty checks silently fail. `profileHelpers.parseNumber` strips formatting — divergent parsing of the same field between the two normalizers.
- **[nit]** `backend/services/profileNormalizer.js:382,88` — Document need-signal scan matches the 2-letter token `'ce'` (→ `professional_development`) as a discrete token; OCR noise / stray "CE" headers will add a false `professional_development` need despite the discrete-token guard.
- **[nit]** `backend/services/profileNormalizer.js:297,545` — `normalizeNeedCategory` returns the raw key (`?? key`) when not in the alias map, so arbitrary tag strings become "canonical" need categories — unbounded vocabulary pollution of `needCategories`.

### backend/services/profileOrganizationSync.js
- **[nit]** `backend/services/profileOrganizationSync.js:204` — `organization_type: p.applicant_type === 'organization' ? 'organization' : p.applicant_type ?? ''` — the ternary precedence is fine, but a falsy-but-defined `applicant_type` (e.g. `''`) falls through to `''`; minor.
- **[nit]** `backend/services/profileOrganizationSync.js:301-305,420-425` — `syncOrganizationToProfileSections` rethrows on the timestamp-update failure (425) while `fillMissingProfileSectionsForProfile` swallows the same failure (303-305); inconsistent error posture for the identical write.

### backend/services/profileReadinessService.js
- **[nit]** `backend/services/profileReadinessService.js:579` — `const earned = present + (phone ? 1 : 0) + (website ? 1 : 0)` where `present` is a boolean — relies on `true → 1` coercion; fragile/confusing (should be `(present ? 1 : 0)`).
- **[nit]** `backend/services/profileReadinessService.js:51` — `const stmt = await db.prepare(...); profile = await stmt.get(...)` two statements on one line; awaits `db.prepare` (sync in better-sqlite3) — harmless but inconsistent with the rest of the file.
- **[nit]** `backend/services/profileReadinessService.js:85,316` — `row.data ? JSON.parse(row.data) : {}` is wrapped in try/catch (safe), but the first function uses raw `JSON.parse` while other services in this package use `safeParseJSON`; convention divergence.

### backend/services/profileRevalEngine.js
- **[nit]** `backend/services/profileRevalEngine.js:25` — `Math.abs(Number(f.new)) > 10 || Math.abs(Number(f.old) - Number(f.new)) > 5`: when `f.new`/`f.old` are non-numeric, `Number(...)` is `NaN` and both comparisons are false, so a geo change with non-numeric values is silently classified as no-geo-shift.
- **[nit]** `backend/services/profileRevalEngine.js:66` — Persisted/inline comment contains mojibake (`â`).

### backend/services/profileSectionsManager.js
- No issues found. Correct dialect-aware placeholders (`$n` for Postgres, `?` for SQLite), guarded JSON parsing, divide-by-zero guard at line 155 (`totalKeys === 0 ? 0 : …`).

### backend/services/profileTypeRegistry.js
- No issues found. Pure, frozen data registry; alias index built lazily; `resolveProfileType` returns null (not throw) for unknown types per the documented contract.

### backend/services/purgeDiffUtils.js
- **[nit]** `backend/services/purgeDiffUtils.js:141,154,164` — `tokenDiffRatio` / `jaccardSimilarity` / `jaroWinkler` appear unused by the in-package consumers; likely dead exports.
- **[nit]** `backend/services/purgeDiffUtils.js:49,70` — Doc says `max(totalA, totalB, 1)` but code uses `Math.max(tokensA.length, tokensB.length)` without the `,1` floor; safe only because both-empty / one-empty are guarded earlier — diverges from its own contract.

### backend/services/purgeMaterialChange.js
- **[important]** `backend/services/purgeMaterialChange.js:54,68` — Status/deadline change detection requires both old and new to be truthy (`if (prevStatus && currStatus && prevStatus !== currStatus)`); a real transition to/from empty/null (e.g. `"open"` → `""`, status cleared) is silently treated as no material change.

### backend/services/purgeVerification.js
- **[important]** `backend/services/purgeVerification.js:62-70` — Duplicated/dead fetch-availability guard: two consecutive `if (!fetch_)` blocks; the second (67-70) is unreachable. The first block's string literal contains mojibake (`â`) and is mis-indented.
- **[nit]** `backend/services/purgeVerification.js:198` — `extractTextSignals` strips tags but does not bound body size or decode entities; runs the full phrase scan over arbitrarily large `responseText`.
- **[nit]** `backend/services/purgeVerification.js:179-181` — `schema_date_modified` signal is recorded but never influences `statusHint`, contradicting its "weak positive signal" comment.

### backend/services/regionalPurgeService.js
- **[critical]** `backend/services/regionalPurgeService.js:339-347,368-369` — When `sourceUrl` is missing, the opportunity is unconditionally forced to `verified:true / statusHint:'closed' / verificationLevel:'primary'`, which transitions it straight to `SUPPRESSED` (`reason: no_source_url`). A simple data-completeness gap (no `source_url`) thus permanently suppresses a legitimate, possibly-active opportunity.
- **[important]** `backend/services/regionalPurgeService.js:249-270,287-307` — Queries use `?` placeholders while branching on `db.dialect === 'postgres'` only for the `is_active` *value*. Postgres `pg` requires `$1,$2,…` placeholders, so every prepared query here would fail against a real Postgres adapter — the service is effectively SQLite-only despite the dialect-aware code.
- **[important]** `backend/services/regionalPurgeService.js:287-307` — No profile/tenant scoping: `funding_opportunities` are selected and mutated by `state` + `suppression_state` only. Suppression is global and flips visibility for every profile/tenant referencing that opportunity (verify whether the table is intended to be global).
- **[important]** `backend/services/regionalPurgeService.js:350-355,383` — On the no-material-change path an HTTP probe is still performed with errors swallowed (`catch { /* non-fatal */ }`); a transient 404 from a non-authoritative mirror can flip suppression state, and probe failures never reach the audit trail.
- **[nit]** `backend/services/regionalPurgeService.js:472,526` — `persistSuppressionTransition` recomputes tier via `inferSourceTier(opportunity.source_url)` ignoring `opp.source_tier`, while `updateLastChecked` prefers the existing tier — inconsistent tier handling between write paths.

### backend/services/relevanceFilterRules.js
- **[important]** `backend/services/relevanceFilterRules.js:485-486,53` — `geographic_title_state_mismatch` compares `_normalizeState(profileState.toLowerCase())` to a title abbr; a profile state stored as a full name not present in `_STATE_ABBREVIATIONS` passes through unmapped and can false-positive a mismatch (hard-reject path).
- **[nit]** `backend/services/relevanceFilterRules.js:686,785-788,247` — Comment numbering inconsistency ("Rule 19 REMOVED" vs another rule labeled "19"), and `_hasConcreteDeadline` (line 247) is dead code with no rule referencing it.
- **[nit]** `backend/services/relevanceFilterRules.js:733,270` — `SSI`/`SSDI` tokens appear in multiple rules that could each reject the same opportunity with different reasons; rule precedence is undefined within this file.

### backend/services/requestIdErrorStore.js
- **[important]** `backend/services/requestIdErrorStore.js:40-48` — Stores full error `stack` (up to 8000 chars) + `message` in an in-process Map retrievable via `getRequestError`. Stack traces contain internal paths and can carry PII/secrets from error context; confirm the consumer endpoint scopes access (potential info leak if exposed to clients).
- **[nit]** `backend/services/requestIdErrorStore.js:34-38` — Each `recordRequestError` does an O(n) scan to evict expired entries and re-parses `Date` per entry; under error storms this is wasteful. Store numeric `occurred_at` ms once.

### backend/services/reverseLookupService.js
- **[important]** `backend/services/reverseLookupService.js:164-184,292-296` — Hardcoded `is_active = 1` / `is_national = 1` integer literals. SQLite-specific; on Postgres (production per CLAUDE.md) where these columns are boolean, `is_active = 1` will error or misbehave. Unlike sibling services, this one does not branch on `db.dialect`.
- **[nit]** `backend/services/reverseLookupService.js:259-261,128` — `findSimilarOrgsFunders` issues up to ~10 sequential ProPublica round-trips (each preceded by a 250ms sleep) with no overall timeout/cap → unbounded latency per profile.
- **[nit]** `backend/services/reverseLookupService.js:289-296` — `catalogEins` includes local-catalog eins that can never match the `source = 'propublica.990'` existence query, needlessly bloating the `IN (...)` parameter list.

### backend/services/reviewerAgent.js
- **[nit]** `backend/services/reviewerAgent.js:168-188` — Redundant `!== undefined` checks after values were already narrowed to `number | null` at 166; dead conditions.
- **[nit]** `backend/services/reviewerAgent.js:160` — `/^(.)\1{10,}$/` only flags whole-string single-char repeats; `"aaaaaaaaaaa more text"` passes the "empty-looking content" guard.
- **[nit]** `backend/services/reviewerAgent.js:195` — `100 * 365 * 24 * 60 * 60 * 1000` ignores leap years for the far-future sanity check (~25 days off over a century; immaterial).

### backend/services/savedGrantsSchema.js
- **[nit]** `backend/services/savedGrantsSchema.js:9,26` — `ensureSavedGrantsProfileColumn` takes `isPostgres` as a param while `ensureFundingOpportunityLinkStatus` re-derives `db?.dialect === 'postgres'`; minor inconsistency in dialect threading. All DDL is parameter-free constant SQL — no injection.

### backend/services/scheduledAutoDiscovery.js
- **[important]** `backend/services/scheduledAutoDiscovery.js:159,75,161` — Daily run guard mixes timezones: `now.getHours() !== CONFIG.hour` uses **local** server time, but `already_ran_today` (`utcDayStart()`) and `_lastBatchRunDate` (`now.toISOString().slice(0,10)`) use **UTC**. On servers offset from UTC, the dedupe key can be set on the wrong calendar day, skipping or double-firing a daily run.
- **[nit]** `backend/services/scheduledAutoDiscovery.js:70` — If `computeProfileDigest` returns null/empty (e.g. on error), profile-change detection is silently skipped without log.
- **[nit]** `backend/services/scheduledAutoDiscovery.js:144,173` — Raw `console.warn`/`console.error` instead of the module `log` logger.

### backend/services/schoolLookupFallback.js
- No issues found.

### backend/services/schoolPortalImportService.js
- **[important]** `backend/services/schoolPortalImportService.js:341-349` — `findImportedAwardIndex` falls back to `Number(entry.amount) === Number(award.amount)`; when both amounts are `null`, `Number(null) === Number(null)` is `0 === 0 → true`, so two distinct awards with no amount but equal titles collide/dedupe incorrectly.
- **[nit]** `backend/services/schoolPortalImportService.js:321,295` — Double JSON parse: `safeParseJSON(row.data, {})` then the already-parsed object is passed to `normalizeSectionData`, which re-checks for a string; the inner parse is redundant.
- **[nit]** `backend/services/schoolPortalImportService.js:469-502` — `upsertSchoolPortalAwardAsOpportunity` swallows all non-unique errors and returns `false` with no log, despite the doc comment claiming an operator-visible warning is emitted.
- **[nit]** `backend/services/schoolPortalImportService.js:407-427` — Writes scholarship metadata to the global `funding_opportunities` table with no tenant/profile scoping (intentional per comment — flag as a design decision, not a bug).

### backend/services/schoolPortalMerger.js
- **[critical]** `backend/services/schoolPortalMerger.js:326-338` — Email-match path returns the first profile for a matched user (`ORDER BY created_at ASC LIMIT 1`) and merges school-supplied education/demographic PII into it with no student/external-ID ownership or consent verification. If emails are reused or spoofed by a partner feed, this is cross-tenant data injection/leakage.
- **[important]** `backend/services/schoolPortalMerger.js:404-413` — Newly created profile is inserted with `user_id` NULL (owned by no user) but populated with PII (name/email/DOB via `basic_information`); orphan profiles may be mishandled by owner-scoped queries elsewhere.
- **[nit]** `backend/services/schoolPortalMerger.js:344-353` — The `json_extract` / `IFNULL` email lookup is SQLite-specific; on Postgres `json_extract` does not exist, so (wrapped in try/catch) it silently never matches, defeating the intended dedupe in a Postgres production deploy.

### backend/services/seasonalCrawlCalendar.js
- **[nit]** `backend/services/seasonalCrawlCalendar.js:375-383` — `isOpeningSoon` JSDoc says "within the next `withinDays` days" but the parameter and logic are month-based; stale doc.
- **[nit]** `backend/services/seasonalCrawlCalendar.js:388-395` — `isRecentlyClosed` checks `prevMonth === program.closeMonth`, but `isProgramOpenInMonth` treats `closeMonth` as inclusive (still open); off-by-one — it reports "recently closed" one month too early relative to the inclusive-close semantics.

### backend/services/serviceCatalogExtractParser.js
- **[nit]** `backend/services/serviceCatalogExtractParser.js:42-58` — `parseMoneyToCents` strips `/hr` and `$` then `Number()`s the remainder; a malformed `$85/mo` parses to a one-time `85`. Low risk given controlled input.
- **[nit]** `backend/services/serviceCatalogExtractParser.js:138` — Log line contains a mojibake (`â`) where an em-dash was intended.

### backend/services/serviceCatalogStore.js
- **[important]** `backend/services/serviceCatalogStore.js:409` — `if (ids.length > 1000) throw new Error('Too many IDs for query')` runs *after* `placeholders` is built and hard-throws inside `listServiceCatalog` rather than paginating/degrading; latent crash if the catalog ever exceeds 1000 active items.
- **[nit]** `backend/services/serviceCatalogStore.js:273,28` — Dynamic SQL fragments (`nowSqlLiteral`, `trueLit`, `placeholders`) are derived from dialect/array-length only, never user input — no injection. `SEED_TTL_MS` from env has no upper bound (a huge value disables re-seeding).

### backend/services/sharedGeo.js
- No issues found. Coordinate validation guards NaN/non-number; haversine math correct.

### backend/services/smartMatcherIntent.js
- **[important]** `backend/services/smartMatcherIntent.js:805-824` — `interpretWithOpenAI` sends the user's raw free-text funding request (possible PII) to OpenAI with no scrubbing, unlike the crawler path that uses `looksLikePiiTerm`. The system prompt instructs the model "No PII" but the *input* is unfiltered.
- **[nit]** `backend/services/smartMatcherIntent.js:373,27` — Comment says `MAX_TERMS=18` but the constant is `24`; stale comment.
- **[nit]** `backend/services/smartMatcherIntent.js:734,268` — `haystack` recomputed, duplicating the `detectPrimaryCategory` logic.

### backend/services/snapshotSerialization.js
- **[nit]** `backend/services/snapshotSerialization.js:49` — Legacy `{}`-serialized Sets are restored as empty Sets, discarding data if an old snapshot stored a populated plain object under a set key (documented as intentional for pre-fix snapshots).

### backend/services/sourceRegistry.js
- **[nit]** `backend/services/sourceRegistry.js:1298,1308` — Correlated subqueries reference the outer table by name (`crawler_source_runs.source_id`) rather than an alias; works in both dialects but fragile (wrapped in try/catch → degrades to empty map).
- **[nit]** `backend/services/sourceRegistry.js:1564-1572` — `looksLikePiiTerm` rejects `\d{6,}` runs, which also drops legitimate 6-digit CFDA/program numbers (recall-vs-PII trade-off).

### backend/services/stripeService.js
- **[important]** `backend/services/stripeService.js:155-169` — `recordStripeEventIfNew` provides idempotency only by inserting the event id; it does not wrap event *processing* in the same transaction, so a crash around the insert can cause double-processing or lost processing. Exactly-once depends on the webhook route doing insert+process atomically — verify upstream.
- **[important]** `backend/services/stripeService.js:88-135` — `createCheckoutSessionForPrice` accepts `customerId`/`metadata`/`priceId` from the caller with no in-service assertion that `customerId` belongs to the authenticated user; a route passing an attacker-influenced `customerId` could target another tenant's customer. Tenant scoping must be enforced by callers.
- **[nit]** `backend/services/stripeService.js:152` — `verifyAndConstructStripeEvent` correctly uses `stripe.webhooks.constructEvent(rawBody, sig, secret)` (signature verification present) — but it requires the **raw** body; verify the webhook route mounts a raw-body parser, or verification silently fails. No secret keys are logged (good).
- **[nit]** `backend/services/stripeService.js:72,131` — Logs Stripe `error.message`, which can occasionally echo request parameters (email/id fragments); low risk.

### backend/services/universityDocumentClassifier.js
- **[critical]** `backend/services/universityDocumentClassifier.js:71` — `.get(String(profileId).replace(/[^0-9]/g, ''))` strips all non-digit characters from the profile id before querying. Profile ids are hex strings (`lower(hex(randomblob(16)))`) containing a–f, so the lookup is mangled and almost always fails to match (or matches the wrong profile after digit-stripping), silently returning `[]` and breaking document→university classification for essentially all profiles.
- **[nit]** `backend/services/universityDocumentClassifier.js:83,87` — Parse/load failures logged via `console.error` and swallowed to `[]`, masking the line-71 bug.

### backend/services/zeroResultLadder.js
- **[nit]** `backend/services/zeroResultLadder.js:145-156` — When `minScore` is already 0, the relaxation loop's `if (t >= minScore) continue` skips every tier, so `relaxed` stays empty and falls through to DIRECTORY even though tier-1 already used `>= 0` (intended, but a `minScore:0` strong-direct miss never yields relaxed results).

---

## Summary

Across 46 p–z service files: **6 critical**, **~24 important**, and a long tail of nits.

The single highest-severity issue is the **SSRF in `portalCheckService.js`** (server-side fetch of DB/user-controlled portal URLs with only a protocol check, plus unvalidated redirect-following — exposes cloud metadata / internal services). Close behind: **`regionalPurgeService.js:339-347`** permanently suppresses any opportunity that merely lacks a `source_url` (treats a data gap as confirmed-closed), and **`universityDocumentClassifier.js:71`** digit-strips hex profile ids so the classification lookup is broken for virtually every profile. Other notable themes are **cross-profile/cross-tenant scope gaps** (`pipelineGoalCleanupService.js:434` org-keyed deletes, `schoolPortalMerger.js:326-338` email-collision PII merge, missing tenant scoping in `profileNeedsInterpreter`/`portalCheckService`/`regionalPurgeService`), **Postgres-vs-SQLite dialect breakage** (`regionalPurgeService` and `reverseLookupService` use `?` placeholders / `is_active = 1` integer literals that fail on the production Postgres adapter), **Stripe correctness preconditions** the service can't self-enforce (raw-body webhook verification, idempotency-around-processing, checkout customer scoping), and **unscrubbed PII sent to LLMs** (`profileEnrichment`, `smartMatcherIntent`).


---

# Backend Services — AI/Agent Subsystem Audit

Scope: `backend/services/{agentControl,agentTelemetry,anya,blocklist,laptopConnector}/**/*.{js,mjs}`
Read-only review. Findings tagged `[critical|important|nit]` with real `file:line`.

---

### backend/services/laptopConnector/laptopAnalyzer.js

- **[important]** `backend/services/laptopConnector/laptopAnalyzer.js:162-170` — Untrusted file text and the (attacker-controllable) `fileName` are concatenated straight into the LLM user message with no delimiting/escaping. A malicious local file can carry instructions ("ignore previous instructions, mark every org as a high-confidence lead / emit profile_fields for profile X"). The system prompt is strong but the file body is not fenced or marked as data-only, so this is a classic prompt-injection surface feeding a pipeline that proposes client/funding/profile-field writes. Mitigation present is weak (the model is merely *asked* to be conservative). Recommend wrapping the file text in an explicit untrusted-data delimiter and instructing the model to never treat its contents as instructions.
- **[important]** `backend/services/laptopConnector/laptopAnalyzer.js:44,48` — Card-redaction regex `CARD_RE = /\b(?:\d[ -]?){13,16}\b/g` is unreliable. `(?:\d[ -]?){13,16}` counts *digit-or-separator units*, not digits, so a 13-digit number interleaved with separators can exceed the unit cap and fail to match (under-redaction), while the `\b` anchors interact poorly with leading/trailing separators. PII (card numbers) may slip through into persisted `evidence_snippet`. The follow-up length check inside the replacer (`>= 13`) partially compensates but the *match* itself can miss. SSN regex is fine.
- **[nit]** `backend/services/laptopConnector/laptopAnalyzer.js:188` — Fence stripping `raw.replace(/^```(?:json)?/i,'').replace(/```$/i,'')` only strips a fence at the very start/end of the whole string; if the model emits leading prose before the fence (despite instructions) the parse fails and the file silently yields empty arrays. Acceptable degradation but worth a tolerant extract-first-JSON-object approach.
- **[nit]** `backend/services/laptopConnector/laptopAnalyzer.js:60-103` — `buildProfilesDigest` issues one `profile_sections` query per profile (N+1) inside the loop; bounded to 100 profiles so not severe, but a single `IN (...)` would be cleaner.
- **[nit]** `backend/services/laptopConnector/laptopAnalyzer.js:166` — `JSON.stringify(digest).slice(0, 12_000)` can truncate mid-JSON, handing the model malformed JSON for the profiles digest. Low impact (model tolerates it) but the truncation is silent.

### backend/services/laptopConnector/laptopConnectorStore.js

- **[nit]** `backend/services/laptopConnector/laptopConnectorStore.js:202` — `markReviewItem` updates `WHERE id = ? AND status = 'pending'` but ignores the rows-affected result, so the caller cannot tell a no-op (already acted / wrong id) from a success. The route may report success for a stale action. Consider returning `res.changes`.
- **[nit]** `backend/services/laptopConnector/laptopConnectorStore.js:76` — `listRuns` maps `summary` from `summary_json` but other reads (`getRun`) return the raw row, so callers see inconsistent shapes. Minor.
- No SQL injection: all values parameterized; `nowFn(db)` only emits constant SQL fragments.

### backend/services/agentControl/agentControlOrchestrator.js

- **[important]** `backend/services/agentControl/agentControlOrchestrator.js:358-386,313` — `resumeRun` fires a fresh `executeRun({db,runId})` (line 381) but there is no guard against an `executeRun` already in flight for the same run. Because execution is fire-and-forget and steps are picked by polling `listSteps`→`find(status==='queued')`, two concurrent `executeRun` loops (e.g. rapid resume, or resume racing a still-draining prior loop) can both grab the *same* next queued step and double-invoke an adapter (`adapter.start`). For Hamilton/John/Robert this means duplicated side effects (drafts, ingests). The lock guards cross-*run* concurrency, not two loops over one run. No per-run executor mutex exists.
- **[important]** `backend/services/agentControl/agentControlOrchestrator.js:668-672,786` — The stop/pause `signal` closures capture `emergency`/`stoppedRequested`/`pauseRequested` by closure, but these are only refreshed at the *top* of each while-iteration (`latestUnfulfilledStop` at line 606). During a long-running `adapter.start`, a newly-arrived stop/pause is NOT seen by `signal.shouldStop()` until the current step finishes, so adapters polling the signal mid-loop never observe an emergency stop that arrived after the step began. The comment at 784-785 claims the run is refreshed "during a long-running step" but the code only refreshes between steps. This weakens emergency-stop responsiveness.
- **[nit]** `backend/services/agentControl/agentControlOrchestrator.js:100-110` — `import { notify... }` statements appear after a function definition (`countAgentWork` at 79-99) mid-module. ESM hoists imports so it works, but it is misleading and diverges from the file's own convention of grouping imports at top.
- **[nit]** `backend/services/agentControl/agentControlOrchestrator.js:112-114` — `(process.env.AGENT_CONTROL_ADMIN_EMAIL || process.env.ADMIN_EMAIL || CANONICAL_ADMIN_EMAIL_DEFAULT).trim().toLowerCase()` is evaluated once at module load. An env change (or test that sets the env after import) won't take effect; the admin gate is frozen at import time. Same pattern duplicated in `samAgentAdapter.js:36`.
- **[nit]** `backend/services/agentControl/agentControlOrchestrator.js:209-210` — The friendly 409 pre-check only fires when `active.run_type === 'full_cycle'`; a non-full-cycle active run plus a new full_cycle relies solely on the lock. Intended per comments, noted for completeness.

### backend/services/agentControl/agentControlStore.js

- **[important]** `backend/services/agentControl/agentControlStore.js:715-770` — `acquireLock` is NOT atomic across its three steps (sweep → INSERT → conditional UPDATE) on SQLite without a surrounding transaction. The UNIQUE constraint on `lock_name` makes the INSERT the real mutex (good), and the takeover UPDATE is guarded by `expires_at < now`, so the window is small — but two workers can both pass the sweep, both fail the INSERT, and both attempt the expired-takeover UPDATE; the `WHERE ... expires_at < ?` guard means at most one UPDATE changes a row only if it was expired at *each* worker's `now`, so a brief double-takeover is theoretically possible if both read the same expired row before either writes. Owner-token fencing on release limits the blast radius. Low likelihood, but the "atomic takeover" comment overstates the guarantee.
- **[important]** `backend/services/agentControl/agentControlStore.js:39-159` — `ensureSchema` swallows *every* DDL error silently (`catch {}`) and caches success in a `WeakMap` keyed on `db` regardless of outcome (`schemaCache.set(db,true)` at line 42 runs *before* the DDL). If the first `ensureSchema` call partially fails, the cache marks it done and subsequent calls skip — a genuinely missing table never self-heals for the life of the process. Intentional "defensive net" per the header, but the cache-before-execute ordering means a transient DDL failure is sticky.
- **[nit]** `backend/services/agentControl/agentControlStore.js:259-299` — `setRunStatus` does a dynamic `import('./agentRunStateMachine.js')` on *every* call. Cheap after first load (ESM caches) but the per-call await adds latency to a hot path; a top-level import would be cleaner and the module is pure-data with no cycle risk.
- **[nit]** `backend/services/agentControl/agentControlStore.js:931-941` — `latestUnfulfilledStop` returns `null` when the last pause/resume is a `resume`, but an outstanding `graceful_stop` older than the resume is already handled earlier; correct, but the precedence (emergency>cancel>graceful>pause, resume cancels pause) is subtle and undocumented at the call site in the orchestrator.

### backend/services/agentControl/agentRunStateMachine.js

- **[nit]** `backend/services/agentControl/agentRunStateMachine.js:204-215` — `canDirectSet` intentionally does NOT enforce the full transition table for non-terminal→non-terminal moves (only the terminal-exit guard). This is documented, but it means the state machine's main value is just the terminal guard; illegal intermediate transitions (e.g. `paused`→`pausing`) pass. Acceptable given legacy callers, flagged so reviewers don't assume full enforcement.
- Otherwise clean: pure data, no I/O, terminal set matches `RUN_STATUSES`.

### backend/services/agentControl/agentControlTypes.js

- Clean. Pure constants + `resolveAgentsForRun`. Note `RUN_STATUSES` (12 entries) and `agentRunStateMachine.RUN_STATES` are duplicated lists that must be kept in sync manually — a drift risk but currently consistent.

### backend/services/agentControl/agentControlNotifications.js

- **[nit]** `backend/services/agentControl/agentControlNotifications.js:91` — `resolveAdminUserId(db)` result is used as `user_id` with no null check; if it returns null the INSERT (NOT NULL `user_id`) throws and is swallowed at line 114, silently dropping the admin notification. The lifecycle event still records elsewhere, so non-fatal, but admin may miss a failure/emergency-stop alert.
- **[nit]** `backend/services/agentControl/agentControlNotifications.js:101` — `severity` is folded into the `data` JSON but the table has no severity column; consumers must parse JSON to triage. Minor design nit.

### backend/services/agentControl/agentAdapters/baseAgentAdapter.js

- Clean abstract base. `makeSignal` correctly defaults all callbacks. No issues.

### backend/services/agentControl/agentAdapters/agentAdapterRegistry.js

- **[nit]** `backend/services/agentControl/agentAdapters/agentAdapterRegistry.js:22-30` — Lazy singleton `adapters` is module-global mutable state; `setAdapter` for tests mutates it and `resetRegistry` nulls it. Fine for tests, but a forgotten `resetRegistry` leaks a mock across test files. No production risk.

### backend/services/agentControl/agentAdapters/samAgentAdapter.js

- **[important]** `backend/services/agentControl/agentAdapters/samAgentAdapter.js:28-39` — `SAM_ADMIN_CTX` is a synthetic admin principal (`isAdmin:true`, `userId:'agent:sam'`) handed to Sam's tool path to bypass the auth gate. This is a deliberate privilege escalation for an internal agent. It is only reachable via the canonical-admin-gated orchestrator, so acceptable, BUT it means any future code path that can trigger a Sam run without re-checking `isControlCenterAdmin` inherits full admin tool access. The blast radius depends entirely on the orchestrator gate never being bypassed. Worth a comment/assertion that Sam runs are unreachable except through the gated `startRun`.
- **[nit]** `backend/services/agentControl/agentAdapters/samAgentAdapter.js:73` — `const dryRun = Boolean(options?.dry_run ?? true)` defaults Sam to dry-run when unset, but `DEFAULT_RUN_OPTIONS.dry_run` is `false`; since merged options always carry `dry_run:false`, the `?? true` fallback is dead in the orchestrator path and only matters if `start` is called directly. Minor inconsistency.

### backend/services/agentControl/agentAdapters/robertAgentAdapter.js

- **[nit]** `backend/services/agentControl/agentAdapters/robertAgentAdapter.js:47,108` — `signal?.shouldStop?.()` is checked before and after `runRobert`, but `runRobert` itself is a single un-cancellable `await` — a stop arriving mid-run is only honored after the whole Robert cycle completes. Consistent with the cooperative model but means Robert cannot be interrupted mid-cycle. Same pattern in yana/john adapters.
- **[nit]** `backend/services/agentControl/agentAdapters/robertAgentAdapter.js:86-87` — `configOverride` unconditionally sets `allowLiveWeb:true, allowSourceDiscovery:true` whenever `allow_robert_ingest` is true, overriding the env safe-defaults. Documented as intentional ("in-app authorization is authoritative"), but it does invert the `ROBERT_ALLOW_LIVE_WEB=false` env safety with a UI toggle — flagged since it weakens an env-level guardrail.

### backend/services/agentControl/agentAdapters/yanaAgentAdapter.js

- **[important]** `backend/services/agentControl/agentAdapters/yanaAgentAdapter.js:67-75,88` — `runYanaDiscovery` is awaited with NO try/catch (unlike sam/robert/john/hamilton which wrap their entry calls). If `runYanaDiscovery` throws, the exception propagates to `executeRun`'s per-step `try/catch` (line 685-701) so it won't crash the run — but the adapter's own `signal.recordEvent` failure/telemetry path (line 87-92) and the structured result envelope are skipped, and the message at line 90 dereferences `result.candidates_qualified` etc. assuming a result object exists. The divergence from the other adapters' defensive pattern is a real robustness gap.
- **[nit]** `backend/services/agentControl/agentAdapters/yanaAgentAdapter.js:88` — Event severity uses `'warning'` for failures, but the telemetry `SEVERITY_VALUES` set is `critical/high/medium/low/info` — `'warning'` is not a valid severity and will be coerced/dropped downstream (`recordEvent` in the store whitelists severities and falls back to `'info'`). Failure events thus lose their severity.

### backend/services/agentControl/agentAdapters/johnAgentAdapter.js

- **[important]** `backend/services/agentControl/agentAdapters/johnAgentAdapter.js:148` — Returns `status: 'completed_no_drafts'` when John produced nothing, but `'completed_no_drafts'` is NOT in `STEP_STATUSES` (`agentControlTypes.js:72-82`). The orchestrator's `setStepStatus` (`agentControlStore.js:457-461`) throws `setStepStatus: invalid status` on an unknown status — however the orchestrator maps adapter status via the `(() => {...})()` block (`orchestrator.js:703-709`) which only recognizes blocked/skipped/stopped/failed and defaults everything else to `'completed'`, so the invalid value is masked there. But the raw value is also stored in `result.summary`/events and any direct `setStepStatus` call with it would throw. Fragile coupling: the adapter emits a status the type system forbids.
- **[nit]** `backend/services/agentControl/agentAdapters/johnAgentAdapter.js:59,91` — Send-gating relies on `draftOnly: !allowSend` plus John's own `johnOutreachSafety`; double-lock is good. No issue, noted as a positive.

### backend/services/agentControl/agentAdapters/hamiltonAgentAdapter.js

- **[important]** `backend/services/agentControl/agentAdapters/hamiltonAgentAdapter.js:166-168,209` — On `signal.shouldPause()` the loop `break`s and sets `stopped=true`, then returns `status:'stopped'`. A pause is thus reported to the orchestrator as a *stop*, conflating pause with stop for Hamilton — already-processed tasks are fine, but the run's pause/resume semantics are lost (resume would re-run Hamilton from the queue rather than continuing where it paused). Diverges from the documented pause-vs-stop distinction.
- **[important]** `backend/services/agentControl/agentAdapters/hamiltonAgentAdapter.js:177-206` — Each `automateSingleSource` is awaited per task with userId `null` and `control_run_id` only; a single task throwing is caught (good), but there is NO `signal.heartbeat`/stop check *between* the network-heavy automation and the next iteration's top — a stop is only polled at loop top (167). For a long single-task automation this delays stop. Also `processed` is incremented only on success, so the heartbeat `remaining: tasks.length - processed` is wrong when failures occur (failed tasks never decrement remaining), making progress reporting drift.
- **[nit]** `backend/services/agentControl/agentAdapters/hamiltonAgentAdapter.js:209` — `const status = stopped ? 'stopped' : failed > 0 ? 'completed' : 'completed'` — the two `'completed'` branches are identical; dead ternary. A run where every task failed still reports `status:'completed'` (with `ok:true`), so a fully-failed Hamilton batch shows green. The `failed` count is in the summary but the top-line status hides it.

### backend/services/agentTelemetry/agentTelemetryStore.js

- **[important]** `backend/services/agentTelemetry/agentTelemetryStore.js:151-174` — SQLite insert path uses `INSERT ... ; SELECT id ... ORDER BY created_at DESC LIMIT 1` to recover the new id. Under concurrent inserts this can return a *different* row's id (race: another insert with a later `created_at` lands between). Telemetry is best-effort so impact is low, but the returned id is not reliably the inserted row's. Prefer `lastInsertRowid` / `RETURNING`.
- **[nit]** `backend/services/agentTelemetry/agentTelemetryStore.js:60-78` — `columnsFor` interpolates `tableName` directly into `PRAGMA table_info(${tableName})` for SQLite. It is guarded by `TABLE_NAME_RE` whitelist (line 61) so not injectable, but the pattern (string-interpolated identifier) recurs across the aggregator and relies entirely on that one regex check — worth centralizing.
- Positive: `tableExists`/`insertActivityEvent` validate agent names against `VALID_AGENTS` and table names against the identifier regex; parameterized values throughout.

### backend/services/agentTelemetry/agentTelemetryTypes.js

- Clean pure-data module. No issues.

### backend/services/agentTelemetry/agentTelemetryService.js

- **[nit]** `backend/services/agentTelemetry/agentTelemetryService.js:42-61` — `getSummary` uses `Promise.all` (line 44): one aggregator rejecting blanks the whole summary. `getHealth` (line 144) deliberately uses `Promise.allSettled` to avoid exactly this; `getSummary` did not get the same treatment, so the overview-cards endpoint is more fragile than the health endpoint. Inconsistent resilience.

### backend/services/agentTelemetry/agentTelemetryAggregator.js

- **[important]** `backend/services/agentTelemetry/agentTelemetryAggregator.js:862-877` — The synthetic-timeline fallback SELECTs `recipient_email` from `john_email_drafts` (line 864). It is not currently surfaced in the pushed `synth` object (only `organization_name` is), so no leak today — but the file header (lines 13-17) promises "Never returns email body content … Never returns Anya message content," and pulling `recipient_email` into scope is a latent PII-exposure footgun one careless edit away from leaking a recipient address into the timeline. Drop the column from the SELECT.
- **[nit]** `backend/services/agentTelemetry/agentTelemetryAggregator.js:33,36-49` — `redactSecrets` strips keys matching `secret|token|password|api[-_ ]?key|authorization|bearer` but does NOT redact values (e.g. a `details_json.note` containing a token-looking string, or `url` with embedded credentials). Key-only redaction; values can still carry secrets. Reasonable scope but documented protection is partial.
- **[nit]** `backend/services/agentTelemetry/agentTelemetryAggregator.js:259,283,etc.` — Time-column name (`tcol`/`ftcol`) is interpolated into SQL across many queries. Safe because it is chosen from a fixed `pickTimeCol` allowlist, but the volume of identifier interpolation is a maintenance hazard.

### backend/services/anya/anyaOnboardingFieldMap.js

- **[nit]** `backend/services/anya/anyaOnboardingFieldMap.js:1-763` — Pure declarative data; no I/O, no LLM calls, no injection surface. Sensitive fields (income, health, veteran, demographics) are consistently `sensitive:true` and `required:false` per the contract. No issues. (Note: the file map is *consumed* by Anya's prompt builder elsewhere — the actual prompt-injection risk lives in the consumer, not here.)

### backend/services/anya/anyaOnboardingIntakeContract.js

- **[nit]** `backend/services/anya/anyaOnboardingIntakeContract.js:99-281` — Pure constants/contract. `church.denomination` is `required:true` (question must be asked) yet sensitive/optional-answer — correctly documented inline. No correctness issues.

### backend/services/anya/anyaOnboardingQuestionTree.js

- **[nit]** `backend/services/anya/anyaOnboardingQuestionTree.js:92-99,101` — `ANYA_ONBOARDING_QUESTION_TREE` is built by calling `toNode(id)` (line 95/97) but `toNode` is a *function declaration* defined below at line 101; hoisting makes this valid, but the object literal also calls `BRANCH_SUBTREES` defined at line 87 — order-sensitive top-level init that works only due to hoisting/TDZ ordering. Fragile to reordering. No runtime bug today.
- Header claims "never stores or echoes the user's free-text answers" — confirmed: tree tracks only `question_id`/status, no answer storage. Good.

### backend/services/blocklist/ownerBlocklistService.js

- **[important]** `backend/services/blocklist/ownerBlocklistService.js:134-144,147-164` — Reads "fail open": `fetchByExact` and `loadFuzzyRules` return `null`/`[]` on any DB error (table not migrated), so `checkIdentity` returns `blocked:false`. For a *security denylist* enforced in auth/inbound/outreach, failing open means a DB hiccup or pre-migration state silently lets a blocked party through. The header documents this as intentional ("fail open for reads"), but for a blocklist a fail-*closed* (or at least loud) posture is the safer default; at minimum the open-fail should be logged/alerted, not silent.
- **[important]** `backend/services/blocklist/ownerBlocklistService.js:146-163` — `_fuzzyCache` is a 30s module-global cache with no tenant/scope key. In a multi-tenant DB this is fine only because the blocklist is explicitly OWNER-global (single canonical admin), but the cache is also not invalidated on `removeEntry` from *another* process — a removed block persists in-cache up to 30s across the fleet. `bustFuzzyCache` only clears the local process. Stale-block window noted.
- **[nit]** `backend/services/blocklist/ownerBlocklistService.js:113-116` — `last_name` fuzzy match tokenizes `name + org` and does `tokens.includes(ruleVal)`; a single-token surname rule like `'van'` (from a multi-word org seed) could over-match common words. The seed list uses real surnames so fine in practice, but admin-entered single common words would over-block.
- **[nit]** `backend/services/blocklist/ownerBlocklistService.js:301-325,232-247` — `recordHit`, `mirrorToOutreach`, `markUserBlockedByEmail` all swallow errors with a `console.warn`. For mirror-to-outreach a swallowed failure means a blocked party is NOT suppressed in John/Larry pipelines while the blocklist itself thinks enforcement is complete — a silent partial-enforcement gap. Consider surfacing mirror failures to the admin.

### backend/services/blocklist/gmailFilterSyncService.js

- **[important]** `backend/services/blocklist/gmailFilterSyncService.js:61-62` — `gmail.users.settings.filters.list(...)` is awaited with NO try/catch. An OAuth/refresh-token expiry, rate-limit (429), or network error throws an unhandled rejection out of `syncGmailFilters` to the route. Every other failure mode in this file degrades gracefully (`NOT_CONFIGURED`); the actual network call does not. A revoked refresh token will surface as a 500 / unhandled rejection rather than a clean "sync failed" result.
- **[nit]** `backend/services/blocklist/gmailFilterSyncService.js:77` — Filter `from` is split on `/\s+OR\s+|[,\s]+/i` and each token added as email or domain. Gmail `from:` criteria can contain display names, `-` negations, or quoted phrases; these would be added as bogus domain blocklist entries (e.g. a stray word becomes a blocked "domain"). `addEntry` normalizes but does not validate that a non-`@` token is a plausible domain, so junk tokens can pollute the denylist (and get mirrored into outreach suppression). Validate token shape before adding.
- **[nit]** `backend/services/blocklist/gmailFilterSyncService.js:54-57` — `OAuth2` constructed with client id/secret but no redirect URI; fine for refresh-token-only flow, noted.

---

## Summary

Reviewed 23 files. Counts: **0 critical, 14 important, ~22 nit.** No remote shell/`exec`/`child_process` or server-side filesystem execution exists in `laptopConnector/` (the connector runs on the laptop; the server only ingests text), so the highest-risk class was absent — but the analyzer is a live prompt-injection surface. Top 3 issues: (1) **laptopAnalyzer** injects untrusted local-file text + filename into the Claude prompt with no data-fencing, feeding a pipeline that proposes profile/lead/funding writes (`laptopAnalyzer.js:162-170`), and its card-redaction regex can under-redact PII (`:44`); (2) the **agentControl orchestrator** has no per-run executor mutex, so `resumeRun` re-kicking `executeRun` can run two loops over one run and double-invoke side-effecting adapters (`agentControlOrchestrator.js:358-386`), and stop/pause signals are only refreshed between steps, blunting emergency-stop responsiveness (`:606,668`); (3) the **owner blocklist fails open** on any DB read error and the **Gmail sync's actual API call is unguarded** (`ownerBlocklistService.js:134-164`, `gmailFilterSyncService.js:61`), meaning a security denylist can silently let blocked parties through or 500 the operator. Secondary themes: several adapters report a fully-failed batch as `completed`/green (hamilton `:209`, john invalid `completed_no_drafts` status), yana lacks the defensive try/catch its siblings have, and telemetry's `getSummary` uses `Promise.all` where `getHealth` correctly uses `allSettled`.


---

# Backend Services Personas — Read-Only Code Audit

Scope: all `.js`/`.mjs` files under `backend/services/` in the subdirectories
`college/`, `hamilton/`, `john/`, `larry/`, `robert/`, `sam/`, `yana/`,
`studentBridgeFunding/`. Findings are tagged `[critical|important|nit]` with a
real `file:line`. Conventions checked: parameterized `?` SQL, profile/tenant
scoping (`WHERE profile_id = ?`), dual Postgres/SQLite dialect handling.

---

## college/

### backend/services/college/collegeFundingMerge.js
- No issues found. (Pure module; FAFSA/federal compliance gate forcing `USER_CONFIRM` is sound.)

### backend/services/college/committedCollege.js
- **[nit]** `backend/services/college/committedCollege.js:107` — `uncommitArchived` restores status with `const restored = a.previous_status || 'planning'`; could resurrect a terminal/declined state to `planning`. Low impact since `commitToCollege` only archives non-terminal apps.
- **[nit]** `backend/services/college/committedCollege.js:169` — `aidReceived` sums `numOrNull(a?.amount)` with no guard against negative amounts; a malformed negative `amount` would distort `unmet_need`.

### backend/services/college/fafsaStatus.js
- No issues found.

---

## studentBridgeFunding/

### backend/services/studentBridgeFunding/calendar.js
- **[nit]** `backend/services/studentBridgeFunding/calendar.js:230` — `bridgeGapDays` measured to `refundEnd` (Sep 15) overstates the documented move-in→refund gap; internally consistent but diverges from stated intent.
- **[nit]** `backend/services/studentBridgeFunding/calendar.js:243` — `academicCycle` uses `(enrollmentYear + 1) % 100`; year 2099→2100 produces a misleading `2099-00`. Far-future cosmetic.

### backend/services/studentBridgeFunding/expander.js
- No issues found.

### backend/services/studentBridgeFunding/pipelineWriter.js
- **[important]** `backend/services/studentBridgeFunding/pipelineWriter.js:105-112` / `:196-227` — Dedup `SELECT id, status FROM grants WHERE profile_id = ? AND application_url = ? LIMIT 1` and the later `INSERT INTO grants` are non-atomic and not in a transaction. Concurrent crawler runs both pass the dedup and both INSERT, defeating the stated `(profile_id, application_url)` idempotency. Relies on a DB unique index this module does not establish.
- **[important]** `backend/services/studentBridgeFunding/pipelineWriter.js:36-77` — `ensureOrganizationForProfile` is racy and swallows the self-heal insert error (`} catch (err) { log.warn('Self-heal org insert failed (continuing with new org)', ...) }`), then creates a brand-new org and reassigns `UPDATE profiles SET organization_id`, orphaning the correct org under concurrent inserts.
- **[nit]** `backend/services/studentBridgeFunding/pipelineWriter.js:51-56` / `:68` — Self-heal `INSERT INTO organizations` uses `CURRENT_TIMESTAMP` literal instead of the `db?.dialect === 'postgres'` `now()` branching convention. Works in both dialects but diverges.
- **[nit]** `backend/services/studentBridgeFunding/pipelineWriter.js:193` — `ensureOrganizationForProfile` issues an `UPDATE profiles` side effect during what reads like a read path; callers may not expect a profile mutation.

### backend/services/studentBridgeFunding/schoolResolver.js
- **[nit]** `backend/services/studentBridgeFunding/schoolResolver.js:107` — `buildApplicationsList` drops apps with no `name` (`if (!name) continue`); a committed school stored with an id/status but blank name is excluded from resolution.
- **[nit]** `backend/services/studentBridgeFunding/schoolResolver.js:146` — `scored.sort((a, b) => b.score - a.score)` relies on V8 stable sort for the documented "first known school wins" tie-break; no explicit tie-break comment.

### backend/services/studentBridgeFunding/templates.js
- **[nit]** `backend/services/studentBridgeFunding/templates.js:401-403` / `:426-428` — A partial `school.portals` object (truthy but missing the specific key) bypasses `SCHOOL_FALLBACK_PORTALS` and falls through to the `school.website` branch; minor URL-derivation gap.

---

## john/
Note: John tables are intentionally **not** profile-scoped (single global outreach agent with a global suppression list; confirmed no `profile_id` column in `083_john_tables.sql`). All SQL is parameterized; `updateDraft` builds columns from a fixed allowlist.

### backend/services/john/johnAgent.js
- **[important]** `backend/services/john/johnAgent.js:219-223` — In `dryRun` mode, no-op leads are pushed into `summary.errors` (`{ lead_id, dry_run: true }`) while the run returns `ok: true`, conflating dry-run skips with real failures. `summary.drafts_created += 0` is dead arithmetic.
- **[nit]** `backend/services/john/johnAgent.js:107-110` — Run row is created (`startRun`) before `draftOnly` validation, so a validation throw leaves an orphaned RUNNING row until the catch finalizes it.
- **[nit]** `backend/services/john/johnAgent.js:178` — `getLatestAliasCheck(db).catch(() => null)` swallows read errors; a failed alias check is indistinguishable from "never ran."

### backend/services/john/johnAliasVerifier.js
- **[nit]** `backend/services/john/johnAliasVerifier.js:97-106` — A test draft is created in the live primary mailbox on every `verify-alias` run with no dedup; repeated admin clicks accumulate test drafts. (Secrets are masked via `maskSecrets` before persistence.)

### backend/services/john/johnDraftService.js
- **[important]** `backend/services/john/johnDraftService.js:106-112` — When `forcePolicyOverride=true`, rate-limit reasons (`DAILY_LIMIT_REACHED`/`HOURLY_LIMIT_REACHED`) are bypassed along with safety reasons; an override intended for content/policy can push past hard rate caps.
- **[important]** `backend/services/john/johnDraftService.js:76-80` / `:176` — Double-draft guard (`hasDraftForLead`) is read-time only with no DB uniqueness on `yana_lead_id`; concurrent manual + scheduled (or two manual) runs can both pass and create duplicate drafts. Header claims "never silently overwrites" but the guarantee is not transactional.
- **[nit]** `backend/services/john/johnDraftService.js:347-358` — `reviseDraftBody` re-runs safety with a hardcoded `recipient_email: 'placeholder@example.org'`, so suppression/recipient checks are not re-validated on revision.

### backend/services/john/johnEmailComposerAI.js
- **[important]** `backend/services/john/johnEmailComposerAI.js:109-150` / `:174` — Untrusted lead content (`facts.mission`, `facts.website_excerpt`, `focus_areas`, org name) is interpolated into the LLM prompt via `JSON.stringify(ctx)` with no sanitization — prompt-injection vector. Downstream `classifySubject`/`classifyBody` mitigate but won't catch all misleading injected copy; `website_excerpt` is length-capped (1500), not content-filtered.
- **[nit]** `backend/services/john/johnEmailComposerAI.js:39-45` — `aiModel(config)` ignores its `config` param and defaults to `'claude-sonnet-4-6'`, not a valid Anthropic model id; if env is unset the API call fails and silently falls back to template, masking a misconfiguration.
- **[nit]** `backend/services/john/johnEmailComposerAI.js:52-64` — `cachedClient` is module-level keyed on the first non-empty `ANTHROPIC_API_KEY`; a runtime key change leaves a stale client.

### backend/services/john/johnEmailTemplates.js
- No issues found.

### backend/services/john/johnEmailWriter.js
- **[nit]** `backend/services/john/johnEmailWriter.js:66-73` — On AI composer `{ ok: false }`, the writer silently falls back to template with no signal on the draft about which path produced it beyond `personalization.template`.

### backend/services/john/johnLeadInterpreter.js
- No issues found. (`selectContactPoint` validates email type before `.trim()`.)

### backend/services/john/johnOutlookProvider.js
- **[nit]** `backend/services/john/johnOutlookProvider.js:74-77` — Token response `await res.json()` is unguarded and `cachedToken` is set from `json.access_token` without verifying it exists; a malformed 200 caches `undefined` and may be served while `Date.now() < expiresAt`.
- **[nit]** `backend/services/john/johnOutlookProvider.js:179-202` — A non-alias draft that gets a transient 5xx is thrown immediately with no retry (the alias-rejected fallback only triggers when `requestedFromAlias`). Resilience gap.

### backend/services/john/johnOutreachSafety.js
- **[important]** `backend/services/john/johnOutreachSafety.js:229-241` / `:264` — `bodyHasOptOut` treats the bare word `'reply'` as satisfying the CAN-SPAM opt-out requirement; any body containing "reply" passes `MISSING_OPT_OUT`, so a non-compliant body can ship.
- **[nit]** `backend/services/john/johnOutreachSafety.js:140-161` — `maskSecrets` masks by key-pattern and JWT-like (`eyJ...`) strings; an opaque (non-JWT) token in a free-text Graph error body would not be masked.
- **[nit]** `backend/services/john/johnOutreachSafety.js:267-272` — Physical-address compliance is a substring `text.includes(addr)` check; whitespace/format normalization differences can spuriously block legitimate drafts (fails safe).

### backend/services/john/johnRateLimiter.js
- **[important]** `backend/services/john/johnRateLimiter.js:23-27` / `:75` — Rate counts (`countDraftsCreatedSince`) and the per-attempt re-check are non-transactional; concurrent manual + scheduled runs each read counts independently before inserting and can collectively exceed `maxDraftsPer24h`. `archived` drafts still consume daily quota.

### backend/services/john/johnRunStore.js
- **[important]** `backend/services/john/johnRunStore.js:251-260` — `countDraftsCreatedSince` compares an ISO-8601 string (`...T...Z`) against `created_at` whose SQLite column DEFAULT is `CURRENT_TIMESTAMP` (`YYYY-MM-DD HH:MM:SS`, space-separated). App inserts pass `nowIso()` so current rows compare correctly, but the format mismatch between schema default and app writes is fragile and would break `>=` string comparison for any default-valued row.
- **[nit]** `backend/services/john/johnRunStore.js:27-35` — `jsonIn` swallows `JSON.parse` errors and returns the raw string; corrupted columns yield a string where callers expect an object.
- **[nit]** `backend/services/john/johnRunStore.js:69-95` — `finishRun` `status = COALESCE(?, status)` with `patch.status || null`: an empty-string status silently keeps the old status. No live bug (callers pass real statuses).

### backend/services/john/johnScheduler.js
- **[important]** `backend/services/john/johnScheduler.js:80-91` / `:23` — The `running` overlap guard is a module-level boolean that protects scheduler-vs-scheduler only; manual `runJohn` API calls don't touch it, so manual + scheduled can run concurrently — the concrete path to the duplicate-draft / cap-overrun races above.
- **[important]** `backend/services/john/johnScheduler.js:130-134` — `tick(...).catch(() => {})` silently swallows all tick errors (including throws before `runJohn`'s try, e.g. `getJohnConfig`/`parseCron`), making scheduler malfunctions invisible.
- **[nit]** `backend/services/john/johnScheduler.js:88-91` — `minuteKey`/`cronMatches` use local server time with no TZ documentation; a server TZ change shifts the send window silently.

### backend/services/john/johnSuppressionService.js
- **[important]** `backend/services/john/johnSuppressionService.js:83-96` — `makeSuppressionChecker` pre-loads at most 1000 rows (`listSuppression({ limit: 1000 })`, ordered `created_at DESC`); suppressed recipients beyond the newest 1000 are silently not loaded into the `Set`, so `isSuppressed` returns false and John can draft to a suppressed address. This in-memory checker is the one used by the draft pipeline. Compliance gap.
- **[nit]** `backend/services/john/johnSuppressionService.js:45-55` — Duplicate detection matches `/UNIQUE|duplicate/i` against driver error text rather than the Postgres `code === '23505'`; brittle across driver versions.

### backend/services/john/johnTypes.js
- **[nit]** `backend/services/john/johnTypes.js:176` — `makeSafetyReport` sets `checked_at: new Date().toISOString()`, making this "no I/O" factory non-deterministic. Cosmetic.

### backend/services/john/johnYanaBridge.js
- **[important]** `backend/services/john/johnYanaBridge.js:139-143` — The candidate-stage suppression filter only checks `type: 'organization'`; a suppressed *email/domain* lead passes the filter, consumes a draft slot, and is only blocked later at the safety gate (producing a blocked draft row). Inconsistent with the header's "lead is not in the suppression list."
- **[nit]** `backend/services/john/johnYanaBridge.js:115-119` — The bridge trusts the source for the 24h daily-cap (documented) and does not re-enforce it; a non-Yana registered source could ignore the contract.
- **[nit]** `backend/services/john/johnYanaBridge.js:141` — `await hasDraftForLead(...)` inside the filter loop is an N+1 (up to ~200 serial queries per run).

---

## larry/
Note: `larry_*` tables have **no `profile_id`/org scoping anywhere** — verify whether this pipeline is intentionally single-tenant (see critical below).

### backend/services/larry/larryAgent.js
- **[critical]** `backend/services/larry/larryAgent.js:178` / `:194` — `phaseSend` approval relies on `attempts.find((a) => a.send_status === 'approved' || a.approved_at)`; when `cfg.requireApprovalToSend` is false, `evaluateSendGates` does not require `attempt.approved_by_user_id`. The send gate holds only because nothing currently sets `send_status='approved'` except the admin route — fragile for a safety-critical send path. Should explicitly require `attempt.approved_by_user_id` here.
- **[important]** `backend/services/larry/larryAgent.js:187-190` — `phaseSend` finds attempts only via `options?.attemptLookup`; the scheduler omits it (`deps.scheduledOptions || {}`), so every lead is blocked `no_drafts` — the FULL_CYCLE send phase is silently inert in the scheduled path.
- **[nit]** `backend/services/larry/larryAgent.js:127` — `phaseScoreAndPacket` calls `upsertLead` per prospect with no per-iteration try/catch; one DB error aborts the whole phase (discovery wraps persistence, scoring doesn't).
- **[nit]** `backend/services/larry/larryAgent.js:241` — `createdBy` falls back to `req?.ctx?.email`, persisting an email into a `created_by_user_id` column (PII/schema smell).
- **[nit]** `backend/services/larry/larryAgent.js:321-322` — `collectCountersForRun` reads `summary.phases.discover.candidates` which is absent on the skip path (`{ skipped: true }`); guarded by `?.` so `prospects_considered` is silently never set.

### backend/services/larry/larryContactVerifier.js
- **[important]** `backend/services/larry/larryContactVerifier.js:48-51` / `:100-103` — `webChecker`/`mxChecker` race against a `timeout()` that rejects but does not abort the underlying fetch (no `AbortController`). Combined with `prospect.website_url` being attacker-influenced and the only guard being `isPlaceholderUrl` (blocks `example.com`/`localhost`/`127.0.0.1`/`0.0.0.0` only), a prospect URL to `http://169.254.169.254/` or an internal RFC1918 host is fetched. SSRF defense is delegated to the adapter; this file does not validate the host.
- **[nit]** `backend/services/larry/larryContactVerifier.js:106` — `satisfiedSignals` is clamped here (`Math.min(... , scoreableSignals)`) but other branches add freely so `ratio > 1` elsewhere; inconsistent.

### backend/services/larry/larryFitScorer.js
- No issues found.

### backend/services/larry/larryLeadPacketBuilder.js
- **[important]** `backend/services/larry/larryLeadPacketBuilder.js:181` — `isPacketQualified` reads `packet?.packet_json?.contact_verification?.status`; the function is fed both in-memory packets (which carry `packet_json` only if round-tripped) and DB lead rows, and a missing `packet_json` is silently treated as unverified → disqualified. Dual-shape fragility.
- **[nit]** `backend/services/larry/larryLeadPacketBuilder.js:37-46` — `pickPitch` interpolates untrusted scraped `organization_name`/orgType/cityState into `recommended_pitch`, which flows into the email subject/plain-text body unescaped (see drafter).

### backend/services/larry/larryOutreachDrafter.js
- **[important]** `backend/services/larry/larryOutreachDrafter.js:101` / `:114-115` — The email `draft_subject` (`` `GrantFlow may help ${orgName} ...` ``) and plain-text `draft_text` embed untrusted scraped `orgName`/contact/pitch **without escaping** (HTML body is escaped via `escapeHtml`, subject/text are not). A malicious org name could inject header-breaking or misleading subject content; passed raw to the sender.
- **[nit]** `backend/services/larry/larryOutreachDrafter.js:97-99` — The body is sliced to `MAX_BODY_CHARS` before `inspectDraftQuality` re-checks `> MAX_BODY_CHARS`, making that branch unreachable for drafter output.

### backend/services/larry/larryOutreachSender.js
- **[important]** `backend/services/larry/larryOutreachSender.js:43` — `if (cfg.requireApprovalToSend && !attempt.approved_by_user_id)`: when `requireApprovalToSend=false` the env flag fully disables human approval for real outbound email, leaving only suppression/DNC/cap gates. Large blast-radius switch.
- **[nit]** `backend/services/larry/larryOutreachSender.js:156` — `success = providerResult?.ok !== false && !providerResult?.error` treats `undefined`/`{}` as success; an empty provider result is recorded as SENT with a null message id.
- **[nit]** `backend/services/larry/larryOutreachSender.js:28` / `:215` — `upsertRelationship` is imported but only `void`-referenced; dead import.

### backend/services/larry/larryProspectDiscovery.js
- **[important]** `backend/services/larry/larryProspectDiscovery.js:121` — `raw_payload: raw` stores the entire untrusted, unbounded raw record into `raw_payload_json`; any future LLM summarization of `raw_payload` inherits prompt-injection / stored-content-into-admin-console risk.
- **[nit]** `backend/services/larry/larryProspectDiscovery.js:53-56` — `planProspectFetches` dead branch: `if (!includeNational) return plan` returns the same `plan` as the fallthrough; `includeNational` does nothing.
- **[nit]** `backend/services/larry/larryProspectDiscovery.js:201-203` — `trustOrdered` recomputes `computeProspectTrustScore` twice per comparison inside the sort comparator.

### backend/services/larry/larryProspectSources.js
- **[nit]** `backend/services/larry/larryProspectSources.js:101-111` / `:124-135` — Two sources have `url: null`, so `safeDomain(null)` returns null and the domain rate-limit block (larryProspectDiscovery.js:158) is bypassed entirely for them.

### backend/services/larry/larryRelationshipTracker.js
- **[important]** `backend/services/larry/larryRelationshipTracker.js:42-47` — `recordOpenedRelationship` unconditionally sets `relationship_state: OPENED`, regressing a `replied`/`declined`/`do_not_contact` label back to `opened` if an open-tracking pixel fires late (the `do_not_contact` boolean is preserved, but `relationship_state` becomes inconsistent).
- **[nit]** `backend/services/larry/larryRelationshipTracker.js:98` — `String(prospect.primary_contact_email).split('@')[1]` is added to suppression without lowercasing here; relies on `addSuppressionEntry` lowercasing downstream.

### backend/services/larry/larryRunStore.js
- **[critical]** `backend/services/larry/larryRunStore.js` (entire file) — **No tenant/profile scoping on any query** (`listProspects`, `listLeads`, `getProspect`, `findProspectByIdentifiers`, `findSuppressionsForProspect`, `countSendsInWindow`, etc.). All `larry_*` data (prospects, leads, suppression list, shared daily send cap) is global. `grep profile_id` over the directory returns nothing. Flagging critical for verification of intended tenancy.
- **[important]** `backend/services/larry/larryRunStore.js:863` / `:877` — `recordDomainRequest` (SQLite branch) compares `window_start` (JS ISO string `...T...Z`) against `datetime('now','-1 hour')` (`... ...`, space, no `T`/`Z`). Lexical string comparison between the two formats is incorrect (`T` > space), so the hourly per-domain rate-limit window can fail to reset. Real dual-dialect correctness bug.
- **[important]** `backend/services/larry/larryRunStore.js:194-275` — `upsertProspectCandidate` reads via `findProspectByIdentifiers` then conditionally INSERTs (read-then-write); concurrent discovery runs can both miss and both insert duplicate prospects (no enforced unique constraint in code).
- **[important]** `backend/services/larry/larryRunStore.js:846-849` — `checkDomainRateLimit` mixes Node clock (`Date.now()-3600000`) with SQLite server time (`datetime('now',...)`) governing the same window; drift/TZ mismatch mis-counts the limit.
- **[nit]** `backend/services/larry/larryRunStore.js:42` — `genId` falls back to `Math.random()` IDs when `crypto.randomUUID` is absent (non-cryptographic, collision-prone).
- **[nit]** `backend/services/larry/larryRunStore.js:60-79` — `parseJsonColumns` swallows `JSON.parse` errors silently, returning a raw string where callers expect objects.

### backend/services/larry/larrySafety.js
- **[important]** `backend/services/larry/larrySafety.js:153-164` — `isPlaceholderUrl` (the only URL guard before web verification) blocks only `example.*`, `localhost`, and `127.0.0.1|0.0.0.0`; it misses `10.x`, `172.16-31.x`, `192.168.x`, `169.254.169.254` (cloud metadata), IPv6 `[::1]`/ULA, and hostnames resolving to internal IPs. SSRF gap on untrusted prospect URLs. The regex is also unanchored (substring match anywhere in hostname).
- **[important]** `backend/services/larry/larrySafety.js:131-137` — `maskSecretString` regex `(sk|pk|rk|api)[_-]?[A-Za-z0-9]{16,}` misses JWTs (`eyJ...`), AWS `AKIA...`, and Resend `re_...` keys; provider keys with other prefixes can leak through `maskSecrets`.
- **[nit]** `backend/services/larry/larrySafety.js:96` — `failOpen` (`YANA_LEADS_FAIL_OPEN`) is read but has no consumer in the larry directory (likely dead config).
- **[nit]** `backend/services/larry/larrySafety.js:259-262` — `classifyPhone` marks any 11–15 digit string `valid` (e.g. `99999999999999`).

### backend/services/larry/larryScheduler.js
- **[important]** `backend/services/larry/larryScheduler.js:91-100` — `isCronMinuteMatch` uses local server time (`getMinutes/getHours/getDate/getDay`), so cron semantics differ by deployment TZ with no documentation.
- **[nit]** `backend/services/larry/larryScheduler.js:163-185` — `runOnce` is guarded by a module-global `STATE.running` lock only; multiple instances/dynos each have their own lock and run discovery concurrently (no distributed lock), compounding the upsert race.
- **[nit]** `backend/services/larry/larryScheduler.js:189` — `runOnce(...).catch(() => {})` swallows startup-run errors with no log.
- **[nit]** `backend/services/larry/larryScheduler.js:194-205` — `setTimeout(tick, 60_000)` re-arming can drift / miss an exact-minute window on clock jumps with no catch-up.

### backend/services/larry/larryTypes.js
- **[nit]** `backend/services/larry/larryTypes.js:243` / `:261-262` — `makeLeadPacket`/`makeOutreachAttempt` coerce missing ids to empty string (`String(... ?? '').trim()`) rather than null; an empty-string id could pass a truthiness check a null wouldn't.

### backend/services/larry/larryUrgencyScorer.js
- **[nit]** `backend/services/larry/larryUrgencyScorer.js:64-70` — `detail` can be a boolean `true` (when the signal is boolean) and is rendered to humans/emails downstream.

---

## robert/
Note: all SQL is parameterized; dynamic `IN (...)` clauses build `?` placeholders (not values). Profile scoping is correct where data is returned; the one scoping concern is a misnamed *count*.

### backend/services/robert/robertAgent.js
- **[nit]** `backend/services/robert/robertAgent.js:111-113` — Dead branch: `if (dryRun && [INGEST, FULL_CYCLE].includes(chosenMode))` has an empty body (comment only).
- **[nit]** `backend/services/robert/robertAgent.js:138-141` — `recommendations_delivered/accepted/declined` counters are declared and persisted but never incremented in this path; always report 0.
- **[nit]** `backend/services/robert/robertAgent.js:466` — `fetchOpportunitiesByIds` builds an `IN (...)` of parameterized `?` from trusted ingest ids but never dedupes/caps the list (unbounded `IN`).

### backend/services/robert/robertCoverageAnalyzer.js
- **[important]** `backend/services/robert/robertCoverageAnalyzer.js:161-173` — `defaultQueryProfileMatchableCount` ignores `profileId` (`_profileId`) and counts ALL active non-hidden `funding_opportunities` globally (`WHERE COALESCE(is_active,1)=1 AND COALESCE(is_hidden,0)=0`), so `zero_result_risk` is driven by the global catalog, not anything profile-specific. Misleading metric (count only, no data leak).
- **[nit]** `backend/services/robert/robertCoverageAnalyzer.js:124-126` — `safeCall` swallows every error (`catch { return undefined }`) with no logging; a broken counts query silently reports zero matches forever.
- **[nit]** `backend/services/robert/robertCoverageAnalyzer.js:53` — `reviewMatches`/`review_matches_count` is hardcoded to 0 and never populated; dead/always-zero.

### backend/services/robert/robertFundingTraceBridge.js
- **[important]** `backend/services/robert/robertFundingTraceBridge.js:58-65` — `traceFundingIntoCandidates` passes free-text `entity` straight to `traceFunding`/reverse-lookup (USASpending/ProPublica) and into log lines (`entity="${trace.entity}"`) — log injection if entity contains newlines; outbound-call safety depends on downstream services.
- **[nit]** `backend/services/robert/robertFundingTraceBridge.js:101` — Caught upsert error logs `source.name` only; per-source failures are not surfaced in the returned summary.
- **[nit]** `backend/services/robert/robertFundingTraceBridge.js:320-322` / `:341` — `upsert` dep may be silently forwarded as `undefined` to a custom `autoSeed`.

### backend/services/robert/robertIngestionBridge.js
- No issues found.

### backend/services/robert/robertMatchBridge.js
- **[nit]** `backend/services/robert/robertMatchBridge.js:53` — `const result = fn(...)` without `await`; correct only if `computeMatchDecision` is never async — an injected async impl would read `result?.score` off a Promise and yield defaults.

### backend/services/robert/robertOpportunityExtractor.js
- **[important]** `backend/services/robert/robertOpportunityExtractor.js:17` — `extractDomain` imported but never used (`import { extractDomain, makeOpportunityCandidate } from './robertTypes.js'`). Dead import.
- **[nit]** `backend/services/robert/robertOpportunityExtractor.js:30-83` — Candidate URLs are validated against placeholder/search-engine filters but NOT against non-`http(s)` or private/loopback hosts; raw IP literals (`http://169.254.169.254/`, `http://10.0.0.5/`) pass extraction and propagate to the downstream injected `checkUrl` fetch.
- **[nit]** `backend/services/robert/robertOpportunityExtractor.js:66-70` — `raw_payload: raw` persists the entire untrusted source record (into `raw_payload_json` / `normalized.raw_source_payload`); prompt-injection vector if any downstream LLM consumes it.

### backend/services/robert/robertOpportunityNormalizer.js
- **[nit]** `backend/services/robert/robertOpportunityNormalizer.js:20` — `isNational` defaults to `true` when there's no state and `applicant_types` is empty/non-array; a county-only candidate is mislabeled national.

### backend/services/robert/robertProfileDemandPlanner.js
- No issues found. (Null handling on `applicantType` is correct via `?.` and `Array.includes(null)`.)

### backend/services/robert/robertRecommendationDelivery.js
- **[important]** `backend/services/robert/robertRecommendationDelivery.js:103-114` — `listRecommendationsSince` runs `db.prepare(...).all(...)` with no try/catch and no `withRobertSchema` self-heal; on a cold deploy where `robert_profile_recommendations` is missing, this throws an unhandled rejection up to the polling/SSE route.
- **[nit]** `backend/services/robert/robertRecommendationDelivery.js:64` — `immediate.slice(0, Math.max(1, remaining))` always returns ≥1 HIGH toast even when `remaining===0` / `daily_cap_reached: true`; contract inconsistency.

### backend/services/robert/robertRecommendationService.js
- **[important]** `backend/services/robert/robertRecommendationService.js:72-78` — The decision-gating chain proceeds to create a recommendation for `NEEDS_PROFILE_DATA` (no branch matches), and although priority resolves to LOW, the user-facing `toast_title`/`toast_body` are still populated — contradicting the comment's "no delivery toast" intent.
- **[nit]** `backend/services/robert/robertRecommendationService.js:102-104` / `:119` — The "daily cap" is enforced loosely in two places with different semantics (creation downgrades priority to LOW; delivery trims), softer than the name implies.

### backend/services/robert/robertRunStore.js
- **[important]** `backend/services/robert/robertRunStore.js:81-124` — `completeRun` is NOT wrapped in `withRobertSchema` (unlike `startRun`); in a missing-relation scenario it throws and (since the agent calls it via `safe()`) the run can finish work but never persist its final status, silently staying `running`.
- **[nit]** `backend/services/robert/robertRunStore.js:488-498` — `listRecommendationsForProfile` builds `IN (${placeholders})` from `statuses`; an empty `statuses: []` yields `IN ()`, a syntax error in both dialects. Callers pass non-empty defaults today.
- **[nit]** `backend/services/robert/robertRunStore.js:298-322` — `updateOpportunityCandidate` silently drops patch keys not in its fixed allowlist (no injection; just silent drop).

### backend/services/robert/robertSafety.js
- **[important]** `backend/services/robert/robertSafety.js:158-164` — `isPlaceholderUrl` (the primary URL gate before the injected fetch) blocks only `localhost`/`.local`/`example.*`/`test.*` by string; it does NOT block `169.254.169.254`, `127.0.0.1`, RFC1918, IPv6 `[::1]`, or raw-IP hosts. Core SSRF gap — defense fully delegated to the injected `checkUrl`.
- **[important]** `backend/services/robert/robertSafety.js:211-228` — `checkRateLimit` treats a rolled (>1h) window as unlimited but does NOT reset `request_count` (only `recordDomainHit` resets). A caller that reads but never records can bypass the per-domain hourly cap for the whole next hour (read/record TOCTOU).
- **[nit]** `backend/services/robert/robertSafety.js:166-176` — `isSearchEngineUrl` allowlist is incomplete (`google.co`/`yahoo.com` only; misses `google.de`, `.co.uk`, `ecosia`, `startpage`, `yandex`); bypassable.
- **[nit]** `backend/services/robert/robertSafety.js:188` — Loan/matching-funds scan reads `opp.eligibility`, but `verifyOpportunity` normalizes to `eligibility_bullets`, so eligibility text is not actually scanned in the verification path.

### backend/services/robert/robertScheduler.js
- **[important]** `backend/services/robert/robertScheduler.js:41-51` — The auto-seed sweep self-starts independent of `ROBERT_ENABLED` (default `ROBERT_AUTOSEED_ON_SCHEDULE=true`); 5 min after boot it calls `autoSeedWeakestProfiles` → `findSimilarOrgsFunders`/`traceFunding` (outbound USASpending/ProPublica) against all active profiles. Enabled-by-default network egress + reads of all profiles even when `ROBERT_ENABLED=false`.
- **[nit]** `backend/services/robert/robertScheduler.js:126-141` — `parseSchedule` collapses every cron to a flat 24h interval anchored to boot time; `0 3 * * *` runs every 24h from process start, not at 3am.
- **[nit]** `backend/services/robert/robertScheduler.js:84-119` — Interval ticks self-guard with `_running`/`_autoSeedRunning` and try/catch (no unhandled rejection), but a tick firing during an in-flight run is silently dropped with no log.

### backend/services/robert/robertSearchPlanner.js
- No issues found.

### backend/services/robert/robertSourceDiscovery.js
- **[important]** `backend/services/robert/robertSourceDiscovery.js:84-86` — The per-plan `searchProvider` call is wrapped in `try/catch` that swallows ALL errors (`results = []`, `err` unused, no log); a persistently failing/rate-limited provider yields zero candidates indefinitely with no diagnostics.
- **[nit]** `backend/services/robert/robertSourceDiscovery.js:87-95` — External provider results are filtered by `isPlaceholderUrl`/`isSearchEngineUrl`/trust but NOT by private-IP/scheme before becoming persisted source candidates (inherits the `isPlaceholderUrl` SSRF gap).

### backend/services/robert/robertSourceRegistry.js
- **[nit]** `backend/services/robert/robertSourceRegistry.js:31` — `computeSourceTrustScore` matches keywords via `domain.includes('grants.'|'opportunities.')`, granting trust 75 to any hostname containing the substring (e.g. `grants.evil.com`, `fakegrants.io`), above `minSourceTrust` (60). Trust-score gaming vector.
- **[nit]** `backend/services/robert/robertSourceRegistry.js:29` — `KNOWN_FOUNDATION.domains` lists `'kresge.org'` twice (duplicate).

### backend/services/robert/robertTypes.js
- **[nit]** `backend/services/robert/robertTypes.js:341` — `makeRecommendation` falls back unknown `toast_priority` strings to `NORMAL` silently; the factory also appears unused by the live path (recommendations built inline elsewhere) — likely dead code.

### backend/services/robert/robertVerification.js
- **[important]** `backend/services/robert/robertVerification.js:144-153` — Live link verification fetches an attacker-influenced (scraped) `opportunity.application_url || apply_url || source_url` via the injected `checkUrl` with no re-validation against private-IP/internal hosts beyond the upstream `isPlaceholderUrl` preflight (which misses IP literals/metadata). This is the actual outbound-fetch site; SSRF protection is entirely delegated to `checkUrl`.
- **[nit]** `backend/services/robert/robertVerification.js:128` — `reviewOpportunity`/`assessReality`/`validateOpportunity`/`enforceOpportunityPolicy` are called without `await`; if any became async, the security gates (`!policy.ok`, `validation.valid`) would read off a (truthy) Promise and always pass. Fragile assumption.

---

## sam/
Note: no SQL injection — dynamic SQL uses parameterized `?`/`$n`; interpolated identifiers are module-level constants. `samGit.js`/`samSafeFixes.js` correctly use `spawn(..., shell:false)` with whitelist exact-match and `--` separators (git); path traversal is blocked by `path.resolve` + `startsWith(REPO_ROOT)`.

### backend/services/sam/samAgent.js
- **[important]** `backend/services/sam/samAgent.js:108-118` — Repair-safe downgrades to advise via `runSam({ ...args, mode: ADVISE })` whenever `dryRun` is true (the default) — `if (mode === SAM_MODES.REPAIR_SAFE && (!authorisedByAdmin || dryRun))`. An authorised admin calling repair-safe with default `dryRun` silently never applies fixes, signalled only by `_downgradedFromRepair` buried in the summary (no top-level error).
- **[nit]** `backend/services/sam/samAgent.js:194-195` — `computeHealthScore(findings)` and `determineProductionReady(...)` each re-walk findings (the latter recomputes the score internally). Redundant.
- **[nit]** `backend/services/sam/samAgent.js:483-491` — `rollupChecks` never sets a 'pass' state for `readyz`/HTTP-derived fields, so a passing run still shows `readyz: 'unknown'`.

### backend/services/sam/samAuditStore.js
- **[important]** `backend/services/sam/samAuditStore.js:45-47` — The 4th secret pattern `/(["'])([A-Za-z0-9+/=]{40,})\1/g` over-masks any quoted 40+ char base64-ish string (hashes, fixtures, long paths) in persisted findings/stdout, corrupting audit evidence (safety-leaning false positive).
- **[nit]** `backend/services/sam/samAuditStore.js:50-57` — `maskSecrets` on objects does `JSON.parse(maskSecrets(JSON.stringify(input)))`; on a parse failure the `catch` returns the *unmasked* original (fails open rather than closed).
- **[nit]** `backend/services/sam/samAuditStore.js:149-168` — The `sam_findings` insert loop is wrapped in one try/catch swallowing ALL errors as "table missing on older DBs"; a constraint violation on row 3 silently aborts remaining inserts with no log.

### backend/services/sam/samDiagnostics.js
- **[important]** `backend/services/sam/samDiagnostics.js:137-146` — `samToolActor` forges `isAdmin: true, role: 'admin'` with `userId: 'system_admin_token'` when `ctx` is null. Safe only because `runSam` gates it; but `runDiagnostics`/`runToolCheck` are exported and, if invoked directly with an injected `invokeTool`, run every admin tool as a forged admin, bypassing the gate.
- **[important]** `backend/services/sam/samDiagnostics.js:167-178` — `isRuntimeUnavailableError` treats HTTP 401/403/404 and "not authori[sz]ed"/"forbidden"/"admin privileges" as benign environment limitations and downgrades them to INFO, so a genuine auth-guard regression — exactly what Sam exists to catch — is silently reclassified as a skip and excluded from severity counts.
- **[nit]** `backend/services/sam/samDiagnostics.js:204-206` — `dispatcher(...)` is called with a 5-arg signature; an arity mismatch in `anyaOrchestrator.invokeTool` silently drops the extra arg.

### backend/services/sam/samEscalation.js
- No issues found.

### backend/services/sam/samGit.js
- **[important]** `backend/services/sam/samGit.js:139` — `git checkout -b <branch>` runs with no prior verification that HEAD is the expected base (no `git fetch`/clean-tree/branch-exists check). If Sam runs while the repo is on an arbitrary branch, the fix branch is cut from there; a re-run with the same deterministic `runId` fails ("branch already exists").
- **[nit]** `backend/services/sam/samGit.js:92` — `defaultOpenPr` passes `title`/`body` to `gh pr create` via `spawn(..., shell:false)` as explicit `--title`/`--body` values; no shell/argument-injection risk. Noted for completeness.

### backend/services/sam/samSafeFixes.js
- **[important]** `backend/services/sam/samSafeFixes.js:294-309` — `runEslintCli` spawns `npx eslint --fix <file>` with `file` as a positional arg and no `--` terminator (`['eslint', '--fix', file]`); a leading-`-` path could be parsed as a flag (argument injection). Mitigated in practice by `isPathSafeForFix`'s allowed-root prefix check. Recommend `['eslint','--fix','--', file]`.
- **[important]** `backend/services/sam/samSafeFixes.js:166-185` — The npm-script-exists pre-check parsing (`args[args.indexOf('run')+1]?.replace(/^-s$/,'')` then `|| args[2]`) works only by luck for `npm run -s scan:secrets`; convoluted and brittle if a future whitelisted script omits `-s`. Not currently exploitable (command is whitelist-matched first).
- **[nit]** `backend/services/sam/samSafeFixes.js:248-263` — `isPathSafeForFix` correctly blocks absolute paths and `../` traversal via `path.resolve` + `startsWith(REPO_ROOT + path.sep)`. Solid (noting the guard is load-bearing).
- **[nit]** `backend/services/sam/samSafeFixes.js:271-272` — `regenerateReadinessLog`'s idempotency claim is stronger than the code: a ms-precision timestamp filename would overwrite if two calls land in the same ms with the same `check_id`.

### backend/services/sam/samPolicy.js
- **[nit]** `backend/services/sam/samPolicy.js:24-28` — The exported `readEnvBool` reads `process.env` directly and ignores any injected `env`, unlike `getSamPolicy`'s inner `read`; tests/callers can't override env via it.

### backend/services/sam/samRegistry.js
- **[nit]** `backend/services/sam/samRegistry.js:270-304` — The `agent.controlCenter.lockHygiene` INTERNAL check defines `async run({ db })`, but `samDiagnostics.runOneCheck` returns `{ ok:true, skipped:true }` for `CHECK_KIND.INTERNAL` and never invokes `check.run` — the lock-hygiene logic (including its `sweepExpiredLocks` self-heal) is dead code through Sam's path.
- **[nit]** `backend/services/sam/samRegistry.js:345-348` — `buildCommandWhitelist` produces `npm run -s <script>` which must stay byte-identical to the strings built in samAgent and exact-matched in `runWhitelistedCommand`, or all gates silently `skipped`. Fragile three-file coupling.

### backend/services/sam/samRepairPlanner.js
- No issues found.

### backend/services/sam/samScheduler.js
- **[important]** `backend/services/sam/samScheduler.js:82-110` — The `starting` guard is reset in `finally` before the fire-and-forget async run completes, so it only blocks synchronous re-entry; calling `startSamScheduler` twice overwrites `activeTimer` without clearing the first timer (`scheduleNext` leaks the prior `setTimeout`), double-arming the daily run.
- **[nit]** `backend/services/sam/samScheduler.js:75-80` — `msUntilNextDaily` uses `next.setHours(...)` (local time) while the env doc says "04:00 UTC"; fires at server local time, contradicting the contract.

### backend/services/sam/samTypes.js
- **[nit]** `backend/services/sam/samTypes.js:218-225` — `info` weight is 0, so unlimited INFO findings never lower the health score; combined with samDiagnostics downgrading real auth failures to INFO, a run with many INFO "skips" still reports `production_ready: true`, score 100. Internally consistent but compounds the masking concern.

### backend/services/sam/samOnboardingBranchTests.js
- No issues found.

### backend/services/sam/samOnboardingConversationAuditor.js
- **[important]** `backend/services/sam/samOnboardingConversationAuditor.js:188-241` — `persistRun` inserts the run row + N finding rows with no transaction; a finding-insert throw mid-loop leaves the run row committed/orphaned while `persisted=false`, an inconsistent partial state.
- **[nit]** `backend/services/sam/samOnboardingConversationAuditor.js:259` / `:275-278` — `ORDER BY severity` sorts the text column alphabetically, not by severity rank (info/low/medium interleave wrong).
- **[nit]** `backend/services/sam/samOnboardingConversationAuditor.js:48-64` — Postgres `tableExists` query omits a `table_schema` filter, so a same-named table in another schema is a false positive.
- **[nit]** `backend/services/sam/samOnboardingConversationAuditor.js:268-281` — `listFindings` binds `limit` as `?` (good) but never clamps it (unlike samAuditStore's `Math.min(100, ...)`).

### backend/services/sam/samOnboardingQuestionContract.js
- No issues found.

### backend/services/sam/samOnboardingReadinessAudit.js
- **[nit]** `backend/services/sam/samOnboardingReadinessAudit.js:82` — `compute(db, profileId)` runs under `withProfileScope({ bypass: true })` (cross-tenant by design for the admin auditor); ensure the route layer admin-gates `recentProfileIds` so non-admins can't enumerate other tenants' readiness.
- **[nit]** `backend/services/sam/samOnboardingReadinessAudit.js:151-157` — `auditRecentCompletions` awaits sequentially in a `for` loop over `profileIds` (slow but correct).

### backend/services/sam/samOnboardingTranscriptAuditor.js
- **[nit]** `backend/services/sam/samOnboardingTranscriptAuditor.js:73-81` — The events query has no SQL-level `LIMIT`; it pulls all events since the window and applies `limit` only in-memory, loading a large table slice on a high-traffic window. (Privacy redaction correctly excludes `details_json`.)
- **[nit]** `backend/services/sam/samOnboardingTranscriptAuditor.js:51` — Same missing `table_schema` filter in Postgres `tableExists`.

---

## yana/

### backend/services/yana/prospectExclusions.js
- No issues found.

### backend/services/yana/webSearchProvider.js
- **[important]** `backend/services/yana/webSearchProvider.js:107-120` — SSRF: `makeHtmlFetcher` fetches arbitrary (AI/search-influenced) URLs with `redirect: 'follow'` and only a scheme check (`if (!/^https?:\/\//i.test(url)) return ''`) — no host allowlist or private-IP/loopback/metadata block, and redirects are auto-followed past the initial check. The caller's `isExcludedUrl` is a domain denylist, not an SSRF guard (won't catch raw IPs/metadata).
- **[nit]** `backend/services/yana/webSearchProvider.js:38-47` — Throttle stamps `last` at dispatch, not completion, so a slow `fn()` doesn't extend spacing for the next call; the comment overstates the "runs after the previous settles" guarantee.
- **[nit]** `backend/services/yana/webSearchProvider.js:64` — `&count=${count}` interpolated unescaped into the URL (internal default 5; prefer `encodeURIComponent` if ever caller-supplied).

### backend/services/yana/yanaContactEnrichment.js
- **[important]** `backend/services/yana/yanaContactEnrichment.js:129-137` — Scraped homepage text (`htmlToText(html)`) becomes `excerpt` → `website_excerpt` → `public_evidence` and flows into John's AI outreach prompt with no sanitization/delimiting (length-capped 1200, not neutralized). Prompt-injection surface.
- **[nit]** `backend/services/yana/yanaContactEnrichment.js:30` — `JUNK_EMAIL_RE` matches `domain` and `godaddy` as bare substrings, wrongly discarding e.g. `team@mydomain.org` or `info@godaddyfoundation.org` (no word boundaries).
- **[nit]** `backend/services/yana/yanaContactEnrichment.js:31` — `EMAIL_RE` global regex reused across `matchAll` calls; combined with the substring junk filter, confirm intended behavior.

### backend/services/yana/yanaLeadDiscovery.js
- **[important]** `backend/services/yana/yanaLeadDiscovery.js:592-622` — `pushQualifiedToJohn` selects/updates with NO profile scoping (`WHERE qualification_status='qualified' AND COALESCE(pushed_to_john,0)=0`); in a multi-tenant DB this pushes every tenant's leads and enforces the rolling cap globally. Same global scope in `countLeadsPushedWithinWindow` (:554), `getYanaStatus` (:744), `listQualifiedLeadPackets` (:793-799). `profile_id` is stored but never filtered — potential cross-tenant leak.
- **[important]** `backend/services/yana/yanaLeadDiscovery.js:439` — `loadOwnOrgKeys` does `SELECT name, ein FROM organizations` across the whole table with no `profile_id`/`deleted_at` filter; the "don't prospect yourself" guard operates globally.
- **[nit]** `backend/services/yana/yanaLeadDiscovery.js:818` — `markQueuedForReview` returns `{ ok: true }` when `!leadId` (line 815) — a missing leadId silently reports success.
- **[nit]** `backend/services/yana/yanaLeadDiscovery.js:514` — `x.scored.source_urls.includes(...)` assumes `source_urls` is always an array (true today, but unguarded).

### backend/services/yana/yanaProspectSources.js
- No issues found.

### backend/services/yana/yanaScheduler.js
- **[important]** `backend/services/yana/yanaScheduler.js:43` / `:86-102` — Scheduler lock `_running`/`_stopped`/`_interval` are module-global singletons; `runYanaScheduledCycle` takes `db` per call but the lock is process-wide, and a second `startYanaScheduler` for another db `clearInterval`s the first's interval (line 97), silently killing the earlier schedule. Breaks under multi-db/multi-tenant.
- **[nit]** `backend/services/yana/yanaScheduler.js:98` — `setInterval` callback returns an un-awaited promise; safe today via internal try/catch but a synchronous throw before the try would be an unhandled rejection.

### backend/services/yana/yanaWebCrawler.js
- **[critical]** `backend/services/yana/yanaWebCrawler.js:297-319` / `:398-422` / `:431-439` — SSRF: `makeJsonFeedSource`/`makeCsvFeedSource` fetch `YANA_WEB_*_FEED_URL` directly, and crawled candidate websites are HEAD/GET-verified (`headCheck(site)`, `enrichOrgContact`) with no host validation against private/loopback/metadata ranges. Candidate `website` values come from fetched feed content (`org.website`, line 249), so a malicious/compromised feed can point Yana at `http://169.254.169.254/` or internal hosts. `normalizeWebsite` validates syntax only. Highest-risk SSRF path.
- **[important]** `backend/services/yana/yanaWebCrawler.js:148-177` — `insertOrganization` inserts crawled orgs with NO `profile_id`/tenant column; `organizationExists` (:140) dedupes across the whole `organizations` table ignoring `profile_id`. Crawled rows are tenant-less/global and then scored for every tenant.
- **[important]** `backend/services/yana/yanaWebCrawler.js:259-274` — `enrichOrgContact` persists scraped personal contact data (`contact_name`, `contact_title`, `email`, `phone`) into `organizations` from uncontrolled pages, despite the module's stated "ORGANIZATIONS ONLY / never harvest personal contact data" posture.
- **[nit]** `backend/services/yana/yanaWebCrawler.js:386` — `parseCsv` splits on `/\r?\n/` and the per-line quote-state machine won't handle embedded newlines inside quoted CSV fields; malformed multi-line rows.
- **[nit]** `backend/services/yana/yanaWebCrawler.js:305` — Candidate liveness HEADs (`headCheck(site)`) skip robots entirely (only `adapter.baseUrl` is robots-checked). Politeness gap.

---

## hamilton/
Note: Hamilton handles student funding portals, credentials, and payments — tenant isolation is critical. The dominant theme is **profile scoping enforced by convention (`WHERE id = ?` + a "callers must verify ownership" comment) rather than in-function guards**. Live TOTP/MFA automation is disabled by policy; saved post-2FA browser sessions are the supported path. E-signature and resolved-field stores are clean.

### backend/services/hamilton/applicationTaskStore.js
- **[important]** `backend/services/hamilton/applicationTaskStore.js:789-808` — `cancelApplicationTask` takes no `profileId`; UPDATE is `WHERE id = ?` only, so a forwarded attacker-controlled `taskId` can cancel another tenant's task.
- **[important]** `backend/services/hamilton/applicationTaskStore.js:502-575` — `updateApplicationTask` is keyed solely on `WHERE id = ?` with no profile scoping while writing whitelisted columns (`status`, `applicationId`, `portalUrl`, ...); cross-tenant writes possible if `taskId` isn't pre-verified.
- **[nit]** `backend/services/hamilton/applicationTaskStore.js:548-549` — Booleans written as `1`/`0` literals into Postgres `BOOLEAN` columns (`auto_submit_enabled`/`allow_auto_submit`); relies on the adapter coercing `1`/`0` for a BOOLEAN bind.
- **[nit]** `backend/services/hamilton/applicationTaskStore.js:226-229` — Postgres status CHECK constraint rebuilt via string interpolation of `TASK_STATUSES`; escaped and from a frozen constant (not exploitable), but the one place diverging from parameterized SQL.

### backend/services/hamilton/hamiltonAdminAccount.js
- **[nit]** `backend/services/hamilton/hamiltonAdminAccount.js:55-99` — `resolveAdminUserId` caches the first resolved id in a process-global `cachedAdminUserId` not keyed by `db`; in a multi-db process the first db's admin id is returned for others (sibling stores use a per-db WeakMap).
- **[nit]** `backend/services/hamilton/hamiltonAdminAccount.js:77-80` — `SELECT id FROM users WHERE role='admin' LIMIT 1` with no ordering; non-deterministic admin id under multiple admins.

### backend/services/hamilton/hamiltonApplicationPacketGenerator.js
- **[important]** `backend/services/hamilton/hamiltonApplicationPacketGenerator.js:476-535` — `insertDocumentRecord`/`generateAndSavePacket` write PII-laden `documents`/`profile_documents` scoped only by the passed `profileId` with no verification the caller owns it; an unverified profile persists a document under the wrong tenant.
- **[nit]** `backend/services/hamilton/hamiltonApplicationPacketGenerator.js:550-552` — Packets (DOCX/HTML/PDF with applicant PII) are written to a shared OS temp dir (`getPacketStorageDir()`) and never cleaned up; PII-at-rest concern.
- **[nit]** `backend/services/hamilton/hamiltonApplicationPacketGenerator.js:441-465` — `tryBuildPdfFromHtml` uses Playwright `setContent` on escaped profile HTML; `setContent` doesn't disable remote resource loading, but no `<img>/<link>` is emitted so not exploitable as written.

### backend/services/hamilton/hamiltonAttestationStore.js
- **[important]** `backend/services/hamilton/hamiltonAttestationStore.js:124-143` — `revokeAttestation` operates on `WHERE id = ?` with no ownership check, despite `getAttestationById`'s comment implying one happens before revoke. A route forwarding a user-supplied id can revoke any tenant's auto-tick authorization.

### backend/services/hamilton/hamiltonAuthBackupPlan.js
- No issues found.

### backend/services/hamilton/hamiltonAuthWatchService.js
- No issues found.

### backend/services/hamilton/hamiltonAuthorizationStore.js
- **[important]** `backend/services/hamilton/hamiltonAuthorizationStore.js:304-322` — `revokeAuthorization` is keyed on `WHERE id = ?` with no in-function ownership check; a forwarded user-supplied id can revoke any tenant's standing authorization.
- **[nit]** `backend/services/hamilton/hamiltonAuthorizationStore.js:200-208` — `ensuredAuthSchema` is a process-global boolean (line 32); concurrent test DBs can race (the sibling stores' WeakMap pattern would help).
- **[nit]** `backend/services/hamilton/hamiltonAuthorizationStore.js:366-369` — `getAutopilotRun`/`updateAutopilotRun` read/patch runs by id with no profile scoping (internal-only today, but the run ledger holds `confirmation_reference`/result data).

### backend/services/hamilton/hamiltonAutomationClassifier.js
- No issues found.

### backend/services/hamilton/hamiltonAutomationOrchestrator.js
- **[important]** `backend/services/hamilton/hamiltonAutomationOrchestrator.js:209-259` — `automateSingleSource` (top-level "Automate with Hamilton" entry) never verifies `userId` owns `resolvedProfileId`; `loadProfileBundle` (:100) is `WHERE id = ?` only, then it creates tasks, generates PII packets, and runs autopilot. The header's "rejects if the caller does not own it" guarantee is not enforced here — trusts the route.
- **[nit]** `backend/services/hamilton/hamiltonAutomationOrchestrator.js:692-700` — An unexpected throw from `runAutopilot`/`resolveBlocker` in the resolver loop isn't caught, leaving the autopilot_run row stuck at `running` and the task at `filling_portal` (no failed-state finalization).
- **[nit]** `backend/services/hamilton/hamiltonAutomationOrchestrator.js:266` — `classification.confidence.toFixed(2)` assumes a number (safe today; no guard if shape changes).

### backend/services/hamilton/hamiltonAutopilotEngine.js
- **[important]** `backend/services/hamilton/hamiltonAutopilotEngine.js:684-692` — Document-upload matching falls back to `documents[0]` (`}) || documents[0]`) when no input matches the document kind, so an unmatched file input is filled with an arbitrary authorized document — a transcript could be uploaded into a "tax return"/"recommendation letter" field. Wrong-document-submission risk on student funding portals.
- **[nit]** `backend/services/hamilton/hamiltonAutopilotEngine.js:564-568` — `browser = await chromium.launch(...)`/`newContext` are outside the `try/finally`; if `newContext`/`newPage` throws, `browser.close()` (in the later try's finally) never runs — leaked chromium process.
- **[nit]** `backend/services/hamilton/hamiltonAutopilotEngine.js:498` — Confirmation-reference regex `([A-Z0-9-]{6,})` matched against full page HTML; the first hit can capture an unrelated token (CSS class/asset hash).

### backend/services/hamilton/hamiltonBlockerClassifier.js
- No issues found.

### backend/services/hamilton/hamiltonBlockerStore.js
- **[important]** `backend/services/hamilton/hamiltonBlockerStore.js:284-304` — `getBlocker(db, id)` returns any blocker by id with no tenant check (and doesn't call `ensureSchema`); `recordResolution`/`resolveOpenBlockersForTask` key only on `blockerId`/`taskId`. Cross-tenant blocker resolution if ids aren't pre-verified.
- **[nit]** `backend/services/hamilton/hamiltonBlockerStore.js:188-189` — Booleans bound as integer `1`/`0` into Postgres `BOOLEAN` columns — the exact mismatch this same file fixes at lines 262-269 by binding a real boolean. Inconsistent within the file.

### backend/services/hamilton/hamiltonCredentialCsvImport.js
- **[important]** `backend/services/hamilton/hamiltonCredentialCsvImport.js:278-280` — On a `saveCredential` failure, the raw downstream error message is pushed verbatim into `result.errors` (`message: err?.message || String(err)`) and returned to the caller; if the error ever echoes the username/password/row content (DB constraint, encryption error), it leaks into the API response — undermining the header's "NEVER returns plaintext passwords."
- **[nit]** `backend/services/hamilton/hamiltonCredentialCsvImport.js:34` / `:58` — `MAX_CSV_BYTES` is enforced against `text.length` (UTF-16 code units), not bytes; multi-byte content can exceed the intended cap.
- **[nit]** `backend/services/hamilton/hamiltonCredentialCsvImport.js:255-260` — In-import dedupe key is `host::username` but `saveCredential` is idempotent on `(profile, host)` only; two rows with the same host/different usernames both call `saveCredential` and the second silently overwrites — possible silent credential loss for multi-account hosts, with no `skipped`/`error` recorded.

### backend/services/hamilton/hamiltonCredentialOwnerRouter.js
- **[nit]** `backend/services/hamilton/hamiltonCredentialOwnerRouter.js:92` — Host matching includes `h.includes(x)` (broader than the comment's "equals/subdomain"); rule host `"mit.edu"` would match `"summit.edu.evil.com"`/`"notmit.edu"`. Loosest possible host check in a module whose stated philosophy is conservative routing — can route a credential into the wrong vault.

### backend/services/hamilton/hamiltonCredentialSessionService.js
- **[important]** `backend/services/hamilton/hamiltonCredentialSessionService.js:210-218` — `markSessionUsed`/`markSessionExpired`/`revokeSession`/`getSessionById` operate on `WHERE id = ?` with no `profile_id`/`user_id` scoping despite the comment claiming callers enforce ownership; a forwarded id lets one tenant revoke/expire/read another's saved session.
- **[nit]** `backend/services/hamilton/hamiltonCredentialSessionService.js:120-122` — `safeStoragePath` disables path-traversal protection when `HAMILTON_BROWSER_STORAGE_DIR` is unset ("No restriction in test envs"); a misconfigured prod (missing env) stores an attacker-controlled `storageStatePath` verbatim and hands it to Playwright.
- **[nit]** `backend/services/hamilton/hamiltonCredentialSessionService.js:198` — `new Date(row.expires_at).getTime()` on a SQLite `DATETIME` like `2026-01-01 12:00:00` (space, no TZ) can yield `NaN`; the `Number.isFinite` guard then skips expiry, treating a stored session as non-expired.

### backend/services/hamilton/hamiltonESignatureService.js
- No issues found.

### backend/services/hamilton/hamiltonHardStopResolver.js
- **[important]** `backend/services/hamilton/hamiltonHardStopResolver.js:475-503` — `resolvePayment` calls `recordCharge` (increments `spent_cents`) with no transaction/lock around `canPayFor`→`recordCharge`; two concurrent blockers for the same authorization both pass `canPayFor` (stale `spent_cents`) and both record, overspending the authorization envelope. Reaches the same race as the payment service below.
- **[nit]** `backend/services/hamilton/hamiltonHardStopResolver.js:255` — `loadProfileMeta` failure returns `{ user_id: null }`, so `recordBlocker` writes `userId: null` (weakened tenant attribution).
- **[nit]** `backend/services/hamilton/hamiltonHardStopResolver.js:482` — `category` from untrusted `input.context.category` is unvalidated against `PAYMENT_CATEGORIES` and echoed into the escalation detail string (cosmetic; unknown category yields a safe `no_authorization` result).

### backend/services/hamilton/hamiltonNotifications.js
- **[important]** `backend/services/hamilton/hamiltonNotifications.js:133-159` — `ensuredNotifications` is a process-global boolean (not the per-db WeakMap the rest of the directory adopted with an explicit "concurrent in-memory DBs race" comment). In multi-DB/test contexts one DB marks the schema ready and a sibling fresh DB skips `CREATE TABLE`, causing "no such table: notifications."
- **[nit]** `backend/services/hamilton/hamiltonNotifications.js:331-336` — `whoMustAct` falls through to "Either the user or an admin can resolve this" when neither is required (misleading copy for a "nobody required" case).

### backend/services/hamilton/hamiltonPaymentAuthorizationService.js
- **[critical]** `backend/services/hamilton/hamiltonPaymentAuthorizationService.js:159-215` — Spend-cap enforcement is not atomic: `canPayFor` reads `spent_cents` and approves at line 174 (`if (auth.spent_cents + cents > auth.max_amount_cents) continue`); `recordCharge` later does `SET spent_cents = spent_cents + ?` (line 200) as a separate, unlocked statement. Two concurrent charges both read the stale `spent_cents`, both pass the cap, and both increment — overspending the pre-authorized envelope (the authorization bypass this service exists to prevent). Fix: a guarded `UPDATE ... WHERE id = ? AND spent_cents + ? <= max_amount_cents` checking `changes`.
- **[important]** `backend/services/hamilton/hamiltonPaymentAuthorizationService.js:187-215` — `recordCharge` takes only `authorizationId` and does NOT verify the authorization belongs to the caller's profile, nor re-check revoked/expired at charge time (`canPayFor` checks them, but `recordCharge` is independently exported and blindly increments any id).
- **[nit]** `backend/services/hamilton/hamiltonPaymentAuthorizationService.js:126-128` — The raw-card `/\d{13,19}/` guard only inspects `paymentMethodLabel`/`paymentMethodReference`; a raw PAN in `authorizationText`/`metadata` is stored unchecked.

### backend/services/hamilton/hamiltonPortalCredentialService.js
- **[important]** `backend/services/hamilton/hamiltonPortalCredentialService.js:442-460` — `getDecryptedCredential` selects all active creds for the profile and picks the first whose registrable domain matches, ordered only by `length(portal_host) DESC`; with multiple logins on one registrable domain it returns an arbitrary account (no exact `portal_host === host` preference), so Hamilton can type the wrong credentials.
- **[important]** `backend/services/hamilton/hamiltonPortalCredentialService.js:514-538` — `saveGeneratedCredential` checks existence with `WHERE profile_id = ? AND portal_host = ? AND status='active'`, but the UNIQUE index is on `(profile_id, portal_host, username)`. An active cred for the host under a different username is missed, so the INSERT proceeds and succeeds — creating a duplicate generated login for the host, contradicting the documented no-overwrite guarantee.
- **[nit]** `backend/services/hamilton/hamiltonPortalCredentialService.js:294-306` / `:494-501` — `getCredentialById`/`deleteCredential`/`markCredentialUsed` are `WHERE id = ?` only (ownership delegated to routes); a missed check is a cross-tenant credential read/delete.
- **[nit]** `backend/services/hamilton/hamiltonPortalCredentialService.js:596-612` — `revealPasswordOnceById` has a check-then-act gap: it reads `password_revealed_once_at` (null), decrypts, then marks; two concurrent reveals both pass the read and both return plaintext before either marks, defeating the at-most-once guarantee (the atomic marker's result isn't used to gate the return).

### backend/services/hamilton/hamiltonPortalPolicyRegistry.js
- **[important]** `backend/services/hamilton/hamiltonPortalPolicyRegistry.js:195-212` — `upsertPolicy` binds boolean columns with integer literals `1`/`0` (`automationAllowed ? 1 : 0`), but the Postgres columns are `BOOLEAN` (line 88). Postgres does not implicitly cast integer `1`/`0` to boolean in a parameterized bind, so policy writes throw on Postgres while passing on SQLite. Dual-dialect break.
- **[nit]** `backend/services/hamilton/hamiltonPortalPolicyRegistry.js:136-141` — Suffix-walk `for (let i = 1; i < parts.length - 1; ...)` never matches a bare 2-label `mtsu.edu` row (covered by the earlier exact-match query, so benign off-by-one).

### backend/services/hamilton/hamiltonPortalProviders.js
- **[nit]** `backend/services/hamilton/hamiltonPortalProviders.js:107-113` — Postgres `CREATE TABLE` emits `live_supported ${boolType} NOT NULL DEFAULT 0` with hardcoded `0`/`1` literals (not `defFalse`/`defTrue`); Postgres rejects `DEFAULT 0` on a BOOLEAN column, so schema creation would fail on Postgres.

### backend/services/hamilton/hamiltonPreflight.js
- **[nit]** `backend/services/hamilton/hamiltonPreflight.js:284-288` — `readAuthorizations` keeps a trailing `void isAuthorizationActive` purely to retain the import (acknowledged in comment); dead code.
- **[nit]** `backend/services/hamilton/hamiltonPreflight.js:75-92` — `listProfileDocuments` falls back from a `profile_documents` join to `SELECT * FROM documents WHERE profile_id = ?` inside a bare `catch`; a transient (non-missing-table) join failure returns a looser document set (both profile-scoped).

### backend/services/hamilton/hamiltonPreflightResolver.js
- **[important]** `backend/services/hamilton/hamiltonPreflightResolver.js:145-168` — `preflightAndResolveSource` calls `resolveBlocker` for every predicted blocker during preflight, and the payment path (`resolvePayment`) will actually `recordCharge` if `canPayFor` allows. So a *preflight* (conceptually a dry-run) can book real spend against a payment authorization before the user launches the run, under a synthesized `preflight_...` task id.
- **[nit]** `backend/services/hamilton/hamiltonPreflightResolver.js:247-253` — `financialReadiness(profile, classification)` ignores its second parameter (dead arg / signature mismatch).

### backend/services/hamilton/hamiltonResolvedFieldStore.js
- No issues found.

### Hamilton live TOTP/MFA automation
- Removed. Hamilton no longer stores or derives live TOTP/MFA codes; users clear 2FA themselves and save a trusted browser session when a portal supports it.

### backend/services/hamilton/studentFundingPortalLinker.js
- **[important]** `backend/services/hamilton/studentFundingPortalLinker.js:527` / `:648-670` — `linkOpportunityToPortal` wraps its writes in `withProfileScope({ bypass: true })`, disabling the DB-layer tenant guard, while read helpers query with a bare `WHERE profile_id = ?` and no `withProfileScope`. Correctness depends entirely on `effectiveProfileId` being trustworthy; an unvalidated `profileId` from a route can write a link into any profile.
- **[nit]** `backend/services/hamilton/studentFundingPortalLinker.js:312` — `safeProg.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')` has a malformed regex-escape character class; some metacharacters in a program/major name may not be escaped before `new RegExp(...)`, risking a throw or unintended match on crafted profile data (compare canonical `[.*+?^${}()|[\]\\]`).
- **[nit]** `backend/services/hamilton/studentFundingPortalLinker.js:40-85` — `ensuredLinkSchema` is a process-global boolean (same anti-pattern as hamiltonNotifications); multi-DB/test usage can skip `CREATE TABLE application_portal_links` on a sibling DB.

### backend/services/hamilton/studentPortalStore.js
- **[important]** `backend/services/hamilton/studentPortalStore.js:50-119` — `ensuredSchema`/`ensureSchemaPromise` are process-global, captured against the FIRST `db` (`if (ensuredSchema) return` before any per-db check). In multi-DB usage (concurrent in-memory test DBs, or DB-per-tenant) a second DB never gets `student_portals` created → "no such table." This is the exact race the other Hamilton stores fixed with a per-db WeakMap; this file (and `studentFundingPortalLinker`) was not migrated.
- **[nit]** `backend/services/hamilton/studentPortalStore.js:336-360` — `setStudentPortalActive`/`recordPortalCheck` don't validate `profileId`/`portalId` are non-null before the UPDATE (unlike `getStudentPortal`); both are profile-scoped so a null id matches nothing, but it diverges from the file's own convention.


---

# Backend Crawler / Ingestion Subsystem Audit

Read-only audit of `backend/services/{crawlers,connectors,geo,nationalCrawlerV2,nationalPrograms,sources,portalAdapters}`.
Findings tagged `[critical|important|nit]` with real `file:line`. Static data-only fixtures under `crawlers/data/**` were skimmed (no logic; noted at end).

---

## crawlers/ (core dispatch / fetch / parse)

### backend/services/crawlers/httpClient.js

- **[important]** `backend/services/crawlers/httpClient.js:130` — `headForVerification` uses `maxRedirects: 5` with no host validation. A crawled/verified URL that 30x-redirects to an internal host (`127.0.0.1`, `169.254.169.254`, RFC1918) will be followed. SSRF surface for any caller passing untrusted URLs (e.g. domainCorpusCrawler verifies arbitrary crawled `application_url`/`source_url`).
- **[important]** `backend/services/crawlers/httpClient.js:37` — Default `retries = 1` but `requestWithRetry` has no host/scheme allowlist anywhere; every caller can request arbitrary URLs. The 429 path only retries when `attempt < retries`; with the default of 1 retry, a 429 burst is given up after 2 attempts and `Retry-After` is ignored entirely (uses fixed exponential backoff).
- **[nit]** `backend/services/crawlers/httpClient.js:32` — `ENOTFOUND` is deliberately treated as non-retryable (commented out). Reasonable, but transient DNS (`EAI_AGAIN` is retried, `ENOTFOUND` is not) can split-classify the same flapping host. Minor.
- **[nit]** `backend/services/crawlers/httpClient.js:74` — On non-2xx, the body snippet (up to 200 chars of upstream response) is logged via `console.warn`. Crawled error pages may contain reflected/sensitive content; low risk but unsanitized upstream data into logs.

### backend/services/crawlers/robotsPolicy.js

- **[important]** `backend/services/crawlers/robotsPolicy.js:135` — `isUrlAllowed` derives `robotsUrl` from `parsed.origin` and calls the injected `fetchText`. The robots.txt fetch itself is unvalidated outbound and (depending on the injected fetcher) may follow redirects to an internal host — same SSRF class as the page fetch. Fail-open on error (line 140) is the documented convention but means a forced robots.txt failure disables robots enforcement.
- **[nit]** `backend/services/crawlers/robotsPolicy.js:26` — `patternToRegExp` builds a `RegExp` from origin-controlled robots paths. Escaping is reasonable, but `*`→`.*` on an adversarial robots.txt with many `*` can produce a pathological regex (ReDoS-ish). Origin-controlled input, low severity.

### backend/services/crawlers/grantsGovClient.js

- **[important]** `backend/services/crawlers/grantsGovClient.js:68,116` — Application URL fallback interpolates the opportunity `number` into a search URL: `...?query=${encodeURIComponent(String(number))}`. `encodeURIComponent` is applied (good), but the `id`-based branch `${GRANTS_GOV_DETAIL}${id}` (line 67/114) does NOT encode `id`. A malformed/garbage `id` from the upstream API is concatenated raw into the stored `url`/`application_url`/`source_url` written to the DB.
- **[nit]** `backend/services/crawlers/grantsGovClient.js:222-249` — `querySimplerAPI` always sends `page_offset: 1` and never paginates; only the first page (≤25 rows) is ever fetched per keyword. `searchGrants`/`searchGrantsBatch` likewise never advance offset — total coverage is silently capped at `MAX_ROWS_PER_QUERY` per query with no signal that more results exist (`hit_count`/total is logged but unused for paging).
- **[nit]** `backend/services/crawlers/grantsGovClient.js:329-343` & `408-421` — Two near-identical dedup blocks (compound `_api_source::source_id` key, else title) are copy-pasted between `searchGrants` and `searchGrantsBatch`; divergence risk.
- **[nit]** `backend/services/crawlers/grantsGovClient.js:196-198` — When `hitCount > 0` but 0 hits extracted, it logs a "PARSING BUG" error but still returns `ok:true, hits:[]` — the parse failure silently drops every record for that keyword rather than surfacing an error to the caller.

### backend/services/crawlers/domainCrawlerEngine.js

- **[important]** `backend/services/crawlers/domainCrawlerEngine.js:226-237` — `liveFetchers` are awaited sequentially in a `for` loop with a try/catch that swallows ALL errors silently (`catch (_) {}`, line 234). A fetcher that always throws (or hangs — there is no per-fetcher timeout here; timeout is only imposed by the caller `domainCorpusCrawler.withTimeout` around the whole crawler) drops all its records with zero diagnostics.
- **[nit]** `backend/services/crawlers/domainCrawlerEngine.js:262` — `pre_score_note` string contains a mojibake character (`â`) where an em-dash/arrow was intended — same UTF-8/encoding corruption that recurs across this codebase (also crawlerManager.js:746, benefitsGovConnector.js:148, stateWaiverBenefitsCrawler.js:48-53,79).
- **[nit]** `backend/services/crawlers/domainCrawlerEngine.js:266-269` — Top-level `catch` logs `console.error('Domain crawler error:', error)` and returns `[]`. A config/programming error inside `runDomainCrawler` is indistinguishable from "no results"; the corpus crawler counts this as a successful (empty) crawler run.

### backend/services/crawlers/domainCorpusCrawler.js

- **[important]** `backend/services/crawlers/domainCorpusCrawler.js:222-288` — URL verification only HEAD-checks `inserted.slice(0, VERIFY_URL_LIMIT)` (first 20). All remaining persisted rows keep `link_status: 'unverified'` yet are already written and active. Broken direct opportunities beyond the first 20 are not deactivated by this pass (relies on a separate recurring verifier).
- **[important]** `backend/services/crawlers/domainCorpusCrawler.js:251-252` — `headForVerification(url, { timeoutMs: 4000 })` is called per row inside the loop, but `url = row.application_url || row.source_url` is a crawled value with `maxRedirects:5` (see httpClient finding) — verification itself can be redirected to an internal host (SSRF). No host allowlist before probing crawled URLs.
- **[nit]** `backend/services/crawlers/domainCorpusCrawler.js:184-187` — Domain-engines phase failure `throw`s and aborts the entire corpus crawl AFTER per-registry crawlers already ran but BEFORE any DB insert (insert happens at line 208). A late engine failure discards all the registry-crawler results gathered above — they are never persisted.
- **[nit]** `backend/services/crawlers/domainCorpusCrawler.js:189-197` — Dedup key is `url.toLowerCase()` only; the same opportunity reachable via `application_url`/`source_url` but a differing `url` is not deduped (the per-crawler dedupe in the engine uses url||application||source, but here only `url` participates first).

### backend/services/crawlers/crawlerManager.js

- **[important]** `backend/services/crawlers/crawlerManager.js:90` — `loadStateData` does `await import(\`./data/states/${stateCode}.js\`)` with `stateCode` derived from `analysis.location?.state`. It is not validated against a 2-letter allowlist before interpolation into the dynamic import path. A profile-supplied state with path characters (`../`) is a path-traversal/arbitrary-module-load vector into the dynamic import. (Practically `analysis.location.state` is normalized upstream, but this function does not enforce it.)
- **[important]** `backend/services/crawlers/crawlerManager.js:654` — `storeResults` does `DELETE FROM crawl_results WHERE profile_id = ?` then re-inserts, with no surrounding transaction. If the process dies mid-insert (or an insert throws — it re-throws at line 678), the profile is left with zero/partial crawl_results. Not atomic; concurrent runs for the same profile race (delete-then-insert interleave).
- **[nit]** `backend/services/crawlers/crawlerManager.js:674` — `source_type` is derived via `result.id?.startsWith('school-') ? ... : (result.stateRestriction ? 'state' : (result.id?.startsWith('fed-') ? 'federal' : 'national'))` — a brittle id-prefix heuristic; any program whose id doesn't follow the `fed-`/`school-` convention is silently classified `national`.
- **[nit]** `backend/services/crawlers/crawlerManager.js:723` — `state: result.stateRestriction || 'nationwide'` writes the literal `'nationwide'` sentinel into the state column (same divergence as sources/samGov.js); other paths use `null`.
- **[nit]** `backend/services/crawlers/crawlerManager.js:39` — `crawlSchemaEnsured` is a module-level boolean memo. In a multi-db / multi-tenant process the schema is ensured only against the first `db` seen; a second `db` (e.g. test vs prod handle) skips `ensureCrawlSchema`.

### backend/services/crawlers/foundation990Crawler.js

- **[important]** `backend/services/crawlers/foundation990Crawler.js:55-102` — Pagination loop runs `for (page = 0; page < max_pages; page++)` but the only early-stop signals are `orgs.length === 0` (line 70) and `(page+1)*25 >= result.total_results` (line 95) which hardcodes a page size of 25. If the upstream page size is not 25, or `total_results` is absent/incorrect, the loop either stops early (data loss) or walks all `max_pages` (default 20) unnecessarily. Page size is assumed, not read from the response.
- **[nit]** `backend/services/crawlers/foundation990Crawler.js:78-81` — Qualification filter uses `org.grant_amount ?? org.income_amount ?? 0`; falling back to `income_amount` when `grant_amount` is absent conflates total revenue with grant payout, admitting non-grantmaking orgs above the threshold.
- **[nit]** `backend/services/crawlers/foundation990Crawler.js:97-101` — Per-page errors are pushed to `errors[]` and the loop continues, but a persistent upstream failure for a `(state,ntee)` combo silently produces zero records with only a `console.warn`; the job still returns `success: true`.

### backend/services/crawlers/itemFundingCrawler.js

- **[critical]** `backend/services/crawlers/itemFundingCrawler.js:457-588` — `searchWebForItem` scrapes DuckDuckGo HTML results and extracts `actualUrl` from the `uddg=` redirect param, then these crawled URLs are written into opportunities (`url`/`application_url`/`source_url`) and persisted with NO host/scheme validation beyond a denylist of social/search domains (lines 555-566). An attacker who can rank a result (SEO/poisoning) gets an arbitrary URL — including `http://internal-host/` or non-http schemes after `decodeURIComponent` (line 549) — stored and later HEAD-verified/followed. No `isValidHttpUrl` gate on web-search results before they become opportunity URLs.
- **[important]** `backend/services/crawlers/itemFundingCrawler.js:440-443` & `466-468` — Search queries are built by interpolating the raw user `request`/`itemRequest` into query strings (`\`free ${request}\``, `\`"${itemRequest}" free program\``) then `encodeURIComponent`'d into the DuckDuckGo URL (line 505). Encoding makes the outbound request safe, but the unbounded user string is also stored in `keywords`/`item_requested` and `_search_query` on every result with no length cap or sanitization.
- **[important]** `backend/services/crawlers/itemFundingCrawler.js:503` — `queries.slice(0,8).map(async ...)` fires up to 8 concurrent scraping requests to DuckDuckGo with a browser-spoofing User-Agent (line 511). No per-host rate limiting / robots check; aggressive concurrent scraping of a third party diverges from the politeness conventions used elsewhere (robotsPolicy, per-host delays).
- **[nit]** `backend/services/crawlers/itemFundingCrawler.js:698` — `Array.isArray(rawWebResults) && rawWebResults !== null` — the `!== null` is dead (an array is never null after `Array.isArray` passes).
- **[nit]** `backend/services/crawlers/itemFundingCrawler.js:22,37` — Imports are interleaved with function definitions (`import * as cheerio` at line 22, then `buildSearchKeywords` at 25, then more imports at 37-44). Legal ESM (imports hoist) but obscures the dependency surface.

### backend/services/crawlers/orgContactEnrichment.js

- **[important]** `backend/services/crawlers/orgContactEnrichment.js:156,169` — `origin = \`https://${domain}\`` and pages are fetched as `\`${origin}${path}\``. `domain` comes from `domainOf(org.website)` which only strips scheme/`www`; there is no check that the resolved host is public (not `localhost`/RFC1918/`*.internal`). The injected `fetchImpl` is trusted to fetch it. SSRF surface if `org.website` is attacker/crawled-supplied. (Mitigated by same-origin-only and fixed paths, but host is unvalidated.)
- **[nit]** `backend/services/crawlers/orgContactEnrichment.js:19,54` — `EMAIL_RX`/`MAILTO_RX` are global (`/g`) regexes; `MAILTO_RX.exec` in a `while` loop (line 50) relies on `lastIndex` state. Reused module-level globals are fine here because each call re-runs from a fresh string, but `EMAIL_RX` used with `.match` (line 54) and as a module const is a latent statefulness footgun if ever used with `.test`/`.exec`.
- **[nit]** `backend/services/crawlers/orgContactEnrichment.js:111-112` — `TITLE_THEN_NAME`/`NAME_THEN_TITLE` regexes built from a large title alternation run against arbitrary stripped HTML; pathological inputs could be slow (ReDoS-ish). Crawled input, low severity.

### backend/services/crawlers/stateWaiverBenefitsCrawler.js

- **[nit]** `backend/services/crawlers/stateWaiverBenefitsCrawler.js:48-53,79` — Mojibake (`â`) in several `GENERIC_DIRECTORY` descriptions and a warning string (encoding corruption), persisted into stored descriptions.
- **[nit]** `backend/services/crawlers/stateWaiverBenefitsCrawler.js:106-109` — Top-level `catch` returns `[]` and logs `console.error`; a real error in the TN/ECF branch is indistinguishable from "no programs."

### backend/services/crawlers/ecfBenefitsCrawler.js

- **[important]** `backend/services/crawlers/ecfBenefitsCrawler.js:405-418` — `defaultLiveFetch` uses `axios.get` with `maxRedirects: 5` and no host validation against the curated `ECF_SOURCES` baseUrls — but more importantly, `discoverLiveBenefits` follows links extracted from the page (`resolveAbsoluteUrl`) and those candidate URLs are stored as opportunity `url`s. The discovered absolute URLs are validated as http(s) (line 427, good) but NOT validated against an internal-host blocklist, and they're never fetched here so risk is bounded — the concern is unvalidated crawled URLs persisted as application targets.
- **[important]** `backend/services/crawlers/ecfBenefitsCrawler.js:566-654` — Curated catalog entries hardcode `amount_min`/`amount_max` (e.g. SSI `amount_max: 914`, line 607) that are stale point-in-time figures presented as data. Not a code bug, but these fabricated-precise amounts are written into stored opportunities; the header comment claims "no fabricated numbers" while the curated floor does carry fixed amounts.
- **[nit]** `backend/services/crawlers/ecfBenefitsCrawler.js:735-739` — `isLoan` substring-matches `'interest'` in title+description; an unrelated program description containing "interested applicants" would be wrongly dropped as a loan. (The richer `opportunityPolicy.isLoanLike` avoids this with phrase patterns; this crawler uses its own naive matcher.)

### backend/services/crawlers/nationalZipCrawler.js

- **[important]** `backend/services/crawlers/nationalZipCrawler.js:816-823` — `searchOverpassLocalResources` POSTs to `https://overpass-api.de` with `timeout: timeoutMs` but no robots/politeness; OSM Overpass mapped elements (`mapOsmElementToOpportunity`, line 739) take `tags.website`/`contact:facebook`/etc. as the opportunity `url` via `pickFirstUrl` with only `normalizeUrl` (line 210) scheme-checking. Crawled OSM tag URLs are persisted as application targets with no host validation — stored-URL/SSRF-on-later-verify surface.
- **[important]** `backend/services/crawlers/nationalZipCrawler.js:1132` — Fallback `axios.get(\`https://api.zippopotam.us/us/${zip}\`)` interpolates `zip` into the path. `zip` is normalized to `^\d{5}$` / FSA upstream in most paths, but `getZipCoordinates` is also reachable with the raw `zip` arg; no `encodeURIComponent`. Low risk given normalization but unvalidated at this boundary.
- **[important]** `backend/services/crawlers/nationalZipCrawler.js:1883-2018` — The main batch loop is a single sequential walk with deadline checks and per-ZIP `Promise.race` timeout (good), but there is no run-level lock/idempotency key on `geo_crawl_runs`: two overlapping `runNationalZipCrawl` invocations (cron + manual) for the same scope both walk and `saveOpportunity`/`upsertGeoAssociation`. Global dedupe in `upsertFundingOpportunity` mitigates duplicate rows, but `incrementGeoCrawlRunCounts` and progress checkpoints race.
- **[nit]** `backend/services/crawlers/nationalZipCrawler.js:1955,1957` — Inside the `geoRunId` post-ZIP block, `regionForMeta(zipcodes.lookup(result.zip))` and `resolveCountyForZip(result.zip, eventState)` are called but `resolveCountyForZip` is async and is NOT awaited here (line 1957) — `eventCounty` is assigned a pending Promise, then passed to `appendGeoCrawlEvent` as the county. (Contrast line 1220 where it IS awaited.) County is logged as `[object Promise]`/null.
- **[nit]** `backend/services/crawlers/nationalZipCrawler.js:154-156,162-164,205-207` — Three `ensureGeoCrawlTables` try/catch blocks swallow all DDL errors silently with only a comment; a genuinely broken migration surfaces only as a later, less clear error.
- **[nit]** `backend/services/crawlers/nationalZipCrawler.js:2010-2012` — `if (global.gc) global.gc()` forces GC every 100 ZIPs; only active with `--expose-gc` and a manual GC call every 100 iterations can hurt throughput more than help.

### backend/services/crawlers/studentBridgeFundingCrawler.js

- **[nit]** `backend/services/crawlers/studentBridgeFundingCrawler.js:31-32` — `JSON.parse(job.parameters)` has no try/catch; a malformed `parameters` string throws an unhandled error that fails the whole job (other handlers guard JSON.parse). Idempotency is delegated to `addBridgeOpportunityToProfilePipeline` (not in scope here) — looks correct per the per-item try/catch.

### backend/services/crawlers/opportunityPolicy.js

- **[nit]** `backend/services/crawlers/opportunityPolicy.js:35,47` — `_rejectionCounts` is module-level mutable state; `enforceOpportunityPolicy` defaults to bumping it when no per-request `rejectionCounts` is passed. Concurrent crawl jobs share/clobber these global counters (cosmetic — counters only, not correctness — but cross-job contamination of diagnostics).
- **[nit]** `backend/services/crawlers/opportunityPolicy.js:245-255` — `isExpired` swallows `new Date(opp.deadline)` parsing oddities by returning `false` (treat as active). A genuinely-passed deadline in an unparseable format is kept as active. Conservative but can surface expired opportunities.

### backend/services/crawlers/crawlerHelpers.js

- **[nit]** `backend/services/crawlers/crawlerHelpers.js:1-69` — Deprecated compatibility shim; `calculateMatchScore` rebuilds `matchedSignals` via substring `oppText.includes(needle)` on every keyword — fine, but it is dead-for-new-code and explicitly non-authoritative. No bug.

### backend/services/crawlers/domainEngines/engineHelper.js

- **[nit]** `backend/services/crawlers/domainEngines/engineHelper.js:9-22` — `normalizeAndFilter` re-runs `looksLikeLoan`/`looksLikeMatchingFunds` only when `strict_*` flags are set; engines that omit the flags emit loan/matching records that are only caught later by `enforceOpportunityPolicy` (if the caller invokes it). No single chokepoint guaranteed at the engine layer.

### crawlers/data/** (static fixtures — skimmed)

- **[nit]** `backend/services/crawlers/data/**` — `federalBenefits.js`, `nationalPrograms.js`, `scholarships.js`, `states/*.js`, `knownSchools.js`, etc. are static curated arrays of `{title,url,...}` with hardcoded amounts/URLs and no executable logic. Risk is data staleness (dead URLs, outdated amounts) rather than code defects; they rely entirely on the downstream `opportunityPolicy`/verification gate for URL validity. Not individually enumerated.

---

## connectors/

### backend/services/connectors/nihNsfConnector.js
- **[important]** `backend/services/connectors/nihNsfConnector.js:28,52` — Module-level `lastRequestTime` mutated in `rateLimitedFetch` with no lock; concurrent crawl jobs both read a stale value and fire simultaneously — the rate limiter does not serialize concurrent callers (same pattern in every connector).
- **[nit]** `backend/services/connectors/nihNsfConnector.js:20,23` — `NIH_BASE_URL`/`NSF_BASE_URL` declared but never used (real RePORTER/NSF API calls in the doc comment are unimplemented; only static templates + HEAD verification of grants.nih.gov).
- **[nit]** `backend/services/connectors/nihNsfConnector.js:90-103` — `verifyUrlReachable` uses HEAD; hosts that reject HEAD return non-2xx and yield false `is_active:false`. Unreliable verification signal.

### backend/services/connectors/benefitsGovConnector.js
- **[important]** `backend/services/connectors/benefitsGovConnector.js:81,131` — `state` interpolated unsanitized into `application_url`/`source_url` (`...stateprofile.html?state=${state}`) and sponsor strings, then persisted; no 2-letter validation despite the JSDoc claim.
- **[nit]** `backend/services/connectors/benefitsGovConnector.js:33-57` — `rateLimitedFetch` is dead (not on the static-catalogue path) and lacks any timeout/AbortController, so it would hang indefinitely if wired up.
- **[nit]** `backend/services/connectors/benefitsGovConnector.js:148` — Mojibake (`â`) in a `console.warn`. `:18-21` stale comment references a removed `cheerio` import.

### backend/services/connectors/grantsGovConnector.js
- **[important]** `backend/services/connectors/grantsGovConnector.js:140,189` — `new Date(closeDate).toISOString()` unguarded; a malformed `closeDate` yields `Invalid Date` and `.toISOString()` throws `RangeError`, aborting the whole `searchOpportunities` map (one bad record kills the page).
- **[important]** `backend/services/connectors/grantsGovConnector.js:172-175` — `getOpportunityDetails` injects `opportunityId` into the URL path (`${SIMPLER_OPPORTUNITY_URL}/${opportunityId}`) with no `encodeURIComponent`/validation — path traversal / parameter smuggling.
- **[important]** `backend/services/connectors/grantsGovConnector.js:67-75` — Pagination uses `startRecordNum: params.offset` but no total/hit-count is read; callers must paginate blindly with no termination signal.
- **[nit]** `backend/services/connectors/grantsGovConnector.js:156` — `mapped.filter((o) => !o.is_loan && !o.requires_match)` drops loan/match records with no count log (hard to diagnose "0 results").
- **[nit]** `backend/services/connectors/grantsGovConnector.js:89` — Triple-nested `hitsNode` shape-guessing falls through to `[]` silently on unexpected shape.

### backend/services/connectors/stateOpenDataConnector.js
- **[critical]** `backend/services/connectors/stateOpenDataConnector.js:158-177` — Socrata records mapped into opportunities with no field sanitization/length cap; `evidence_url`/`source_url` come straight from `record.url` with no http(s)/internal-host check. Unsanitized crawled third-party data persisted verbatim — stored-injection / SSRF-on-later-fetch surface.
- **[important]** `backend/services/connectors/stateOpenDataConnector.js:155,212` — `socrataUrl` built from `portal.domain`; `configureStatePortal` accepts an arbitrary admin-supplied `config.domain` with no allowlist — `https://${portal.domain}/...` is an unvalidated outbound fetch (SSRF).
- **[important]** `backend/services/connectors/stateOpenDataConnector.js:212-219` — `configureStatePortal` omits `portal_grants_url`; later `searchStateData` falls back to bare `https://${portal.domain}`, silently dropping the authoritative portal URL.
- **[important]** `backend/services/connectors/stateOpenDataConnector.js:171` — Operator-precedence bug: `record.max_award || record.award_ceiling ? parseFloat(...) : null` parses as `(record.max_award) || (record.award_ceiling ? ... : null)`; a truthy non-numeric `max_award` returns the raw string unparsed.
- **[nit]** `backend/services/connectors/stateOpenDataConnector.js:168` — `min_award` parse doesn't strip `"$"` (unlike statePortals' `parseAmount`); currency strings become `NaN`.

### backend/services/connectors/usaspendingConnector.js
- **[important]** `backend/services/connectors/usaspendingConnector.js:26-50` — `rateLimitedFetch` has no timeout/AbortController; a hung POST blocks the crawl indefinitely.
- **[important]** `backend/services/connectors/usaspendingConnector.js:67-77` — Pagination never reads `page_metadata.hasNext`/total; one page returned, no signal for callers to stop/continue.
- **[nit]** `backend/services/connectors/usaspendingConnector.js:18` — `agencyCode` interpolated unvalidated into `${BASE_URL}/agency/${agencyCode}/` (path-injection surface; numeric by convention).
- **[nit]** `backend/services/connectors/usaspendingConnector.js:16` — Uses raw `console.error` instead of `createLogger` (convention divergence).

### backend/services/connectors/samGovConnector.js
- **[important]** `backend/services/connectors/samGovConnector.js:30-56` — `rateLimitedFetch` has no timeout and no 429 handling; a SAM.gov 429 throws immediately and aborts `searchAssistanceListings` (diverges from `sources/samGov.js`, which handles 429).
- **[important]** `backend/services/connectors/samGovConnector.js:104,111,139,149` — `programNumber`/`cfdaNumber` interpolated unencoded into `https://sam.gov/fal/${...}/view` and `${BASE_URL}/assistance-listings/${cfdaNumber}` — path injection / SSRF on the outbound detail fetch; malformed values produce broken stored `application_url`.
- **[nit]** `backend/services/connectors/samGovConnector.js:74-77` — `params.limit` not bounds-checked (unlike sources/samGov.js clamping to `SAM_GOV_MAX_LIMIT`).
- **[nit]** `backend/services/connectors/samGovConnector.js:135-137` — `getAssistanceListingDetails` doesn't guard for a missing API key before fetch; relies on a throw rather than graceful empty-result.

---

## sources/

### backend/services/sources/grantsGov.js
- **[nit]** `backend/services/sources/grantsGov.js:47` — `oppHits.map(_canonicalTransform)` has no per-record try/catch; one throwing hit fails the whole page (usaSpending/samGov wrap per-record).
- **[nit]** `backend/services/sources/grantsGov.js:55` — `Number(... ) || oppHits.length` masks a legitimate `0` total as `oppHits.length`.

### backend/services/sources/httpClient.js
- **[important]** `backend/services/sources/httpClient.js:28-100` — `fetchWithRetry` returns `response.data` (parsed axios body), NOT a Response object — but `statePortals.js` consumes it as a fetch `Response` (`.ok`/`.json()`). Contract mismatch (root cause of the statePortals break below).
- **[important]** `backend/services/sources/httpClient.js:70-83` — 429 treated as a non-retryable 4xx and thrown immediately without honoring `Retry-After`; rate-limit responses abort crawls instead of backing off.
- **[nit]** `backend/services/sources/httpClient.js:87` — Exponential backoff has no jitter (thundering herd across concurrent jobs).
- **[nit]** `backend/services/sources/httpClient.js:55` — `axios(config)` follows redirects (default maxRedirects=5) with no host validation (SSRF amplification for caller-supplied URLs).

### backend/services/sources/statePortals.js
- **[critical]** `backend/services/sources/statePortals.js:114-120` — `fetchWithRetry` returns a parsed body, but the code calls `if (!response.ok) throw` and `await response.json()`. `response.ok` is `undefined` (guard never fires) and `response.json` is not a function → `response.json()` throws `TypeError` on every successful fetch, caught at line 137 and converted to an empty result. State portal ingestion silently returns zero opportunities every time — total functional break.
- **[important]** `backend/services/sources/statePortals.js:211,174,188` — `raw_source_payload: JSON.stringify(record)` stores the entire untrusted record; `source_url: appUrl` taken verbatim from `record.url`/`record.link` with no http(s)/host validation (stored-injection / SSRF-on-fetch).
- **[nit]** `backend/services/sources/statePortals.js:117` — POST branch sets `body:` but axios expects `data:`; a future POST portal silently sends no body.
- **[nit]** `backend/services/sources/statePortals.js:10` — Mixed default+named import from the `crypto` builtin (stylistic divergence).

### backend/services/sources/usaSpending.js
- **[nit]** `backend/services/sources/usaSpending.js:264-273` — `parseDate` defined but never called (deadlines hardcoded `null` at line 161). Dead code.
- **[nit]** `backend/services/sources/usaSpending.js:61-68` — Pagination never inspects `page_metadata.hasNext`/total (blind paging).
- **[nit]** `backend/services/sources/usaSpending.js:242` — Keyword extraction runs on raw crawled description with no sanitization before `JSON.stringify` into the DB.

### backend/services/sources/ingestionService.js
- **[important]** `backend/services/sources/ingestionService.js:50-110,194` — Idempotency is not concurrency-safe: the "preflight existence check then insert-or-update" (`checkExists.get` → branch) is a TOCTOU race. Two concurrent runs for the same `(source, source_id)` can both see "not exists" and both INSERT (the comment at 46-49 deliberately avoids `ON CONFLICT`, but the alternative provides no cross-run atomicity).
- **[important]** `backend/services/sources/ingestionService.js:269-271` — "Stop if too many errors" `throw`s inside the transaction when `errors > 10`, rolling back ALL successfully-inserted rows in the batch (potentially thousands of good inserts discarded by 11 bad records).
- **[important]** `backend/services/sources/ingestionService.js:38,289,320` — Mixed sync/async DB usage: `await createRun.run(...)` (async-style) coexists with synchronous better-sqlite3 transaction semantics (`db.transaction(()=>{...})`, `.get()`/`.run()` un-awaited at 289/320). Latent correctness hazard depending on the actual driver.
- **[nit]** `backend/services/sources/ingestionService.js:142-144,170-172` — `is_active` null is treated as `true`/coerced to `1`; a source omitting the flag is force-activated and reality-gated.
- **[nit]** `backend/services/sources/ingestionService.js:191-194` — Source/source_id null check happens after validation; records missing `source_id` fail at DB time and count as `error` rather than a clean skip.
- **[nit]** `backend/services/sources/ingestionService.js:297,329` — Run accounting (`records_fetched` vs inserted/updated/rejected/errors) won't reconcile.

### backend/services/sources/samGov.js
- **[important]** `backend/services/sources/samGov.js:16-40` — `fetchWithRetry` retries 429/503 but ignores `Retry-After` (fixed `attempt*2000`), and on a thrown error blindly retries even non-retryable 4xx (400/401/403) up to 3×; the `timeout: 30000` (line 102) is a non-standard node-fetch option and likely ineffective.
- **[important]** `backend/services/sources/samGov.js:86,96` — API key placed in the query string (`URLSearchParams({api_key: apiKey,...})`); the full URL with the key risks leaking into logs/error messages. SAM.gov supports the `X-Api-Key` header (used by the sibling connector).
- **[important]** `backend/services/sources/samGov.js:115` — `has_more` math uses post-normalization `opportunities.length` (filtered) instead of the raw page count; when records are skipped, a caller computing offset advance from this skips/loops incorrectly.
- **[nit]** `backend/services/sources/samGov.js:203` — `state: state || 'nationwide'` writes a sentinel string while `is_national` is the canonical flag (divergence from usaSpending null).
- **[nit]** `backend/services/sources/samGov.js:140` — Response-shape probing yields `[]` on an unexpected/error-envelope shape, dropping all records with no warning.

---

## geo/

### backend/services/geo/geoCoverageService.js
- **[critical]** `backend/services/geo/geoCoverageService.js:99-118` — `fetchGeoIndexIds` interpolates `LIMIT ${limit}` directly into SQL (defaults to 3000). Un-parameterized numeric interpolation — SQL injection if any caller forwards a request-derived limit. Same risk for `${activeVal}` interpolations (87,110,131,276-277).
- **[important]** `backend/services/geo/geoCoverageService.js:278-279` — `buildGeoCoverageClause` unconditionally appends `state IS NULL` joined with `OR`; every geo query then matches all `state IS NULL` rows regardless of profile/scope — unscoped rows leak into every profile's results.
- **[important]** `backend/services/geo/geoCoverageService.js:76-94,99-118,123-138` — All three query helpers wrap the DB call in `catch { return 0/[] }`, so a real DB/SQL error is indistinguishable from "no coverage" and silently falls through to national.
- **[important]** `backend/services/geo/geoCoverageService.js:50-65,27` — `findNearbyZips` scans every ZIP (~42k) computing haversine per call; the unbounded `_nearbyCache` Map grows without eviction (CPU hot spot + memory leak over time).
- **[nit]** `backend/services/geo/geoCoverageService.js:290` — The broad `OR` group (ZIP-IN / state-IN / national / `state IS NULL`) is near-tautological given the always-on `state IS NULL`.

### backend/services/geo/zipCountyResolver.js
- **[nit]** `backend/services/geo/zipCountyResolver.js:30-32,47-49` — Both dataset-load catch blocks swallow errors silently; a corrupt map yields an empty mapping and every ZIP resolves to `null` with no diagnostic.
- **[nit]** `backend/services/geo/zipCountyResolver.js:10-11,51` — `loadMappingOnce` memoizes the empty-fallback `{}` permanently (truthy), so a transient first-call failure becomes a permanent negative cache that never retries.

---

## nationalCrawlerV2/

### backend/services/nationalCrawlerV2/fetchers.js
- **[critical]** `backend/services/nationalCrawlerV2/fetchers.js:21-35` — `fetchToBuffer` performs no SSRF validation before `fetcher.fetch(url)`: no scheme/host allowlist, no private-IP block (`169.254.169.254`, `127.0.0.1`, RFC1918), and the underlying fetcher follows redirects. Data-driven/live seed URLs and redirects can reach internal services.
- **[important]** `backend/services/nationalCrawlerV2/fetchers.js:35,54` — `contentHash: sha256(buffer.toString('base64'))` here, but `run.js:301` recomputes it as `sha256(buffer.toString('utf8'))`; file-path vs network-path use different hashing — change detection is inconsistent.
- **[important]** `backend/services/nationalCrawlerV2/fetchers.js:31` — `Buffer.from(await res.arrayBuffer())` with no size cap (memory exhaustion on a huge/streamed body).
- **[nit]** `backend/services/nationalCrawlerV2/fetchers.js:38-56` — `fetchFileUrl` reads any path from a `file://` URL with no confinement to a fixtures dir (unguarded arbitrary-file-read primitive).

### backend/services/nationalCrawlerV2/parsers.js
- **[important]** `backend/services/nationalCrawlerV2/parsers.js:43-45,67-69` — PDF/DOCX parse-failure fallback does `buffer.toString('utf8')` on binary bytes and runs it through the HTML parser, storing garbage as `extracted_text` instead of recording a parse failure.
- **[nit]** `backend/services/nationalCrawlerV2/parsers.js:16-17` — Parser routing by content-type/extension only; no magic-byte verification (wrong parser on mislabeled content).
- **[nit]** `backend/services/nationalCrawlerV2/parsers.js:24` — UTF-8 assumed everywhere; no charset handling.

### backend/services/nationalCrawlerV2/robots.js
- **[important]** `backend/services/nationalCrawlerV2/robots.js:89-103` — robots.txt fetch is fail-open and the empty (allow-all) ruleset is cached for the 6h TTL, so a transient robots failure suppresses enforcement for hours.
- **[important]** `backend/services/nationalCrawlerV2/robots.js:93` — `fetcher.fetch(robotsUrl)` is unvalidated outbound and follows redirects (same SSRF surface as fetchers.js).
- **[nit]** `backend/services/nationalCrawlerV2/robots.js:122-131` — Hand-rolled per-evaluation `RegExp` from `rule.path` double-processes `$`, is fragile (ReDoS-ish on crafted input), and diverges from RFC 9309 specificity.

### backend/services/nationalCrawlerV2/store.js
- **[critical]** `backend/services/nationalCrawlerV2/store.js:319-322` — `change_log` is rewritten on EVERY crawl including `changeType === 'unchanged'`, defeating idempotency; it reads the pre-update in-memory `existing.change_log`, so concurrent jobs lost-update the log (last writer wins).
- **[critical]** `backend/services/nationalCrawlerV2/store.js:35-332` — No transaction wrapping the up-to-four writes (main row, `nf_program_versions`, `change_log`). A later failure leaves rows inconsistent; concurrent runs race on `existing` (line 49) with no row lock / `ON CONFLICT` — both can INSERT.
- **[important]** `backend/services/nationalCrawlerV2/store.js:49,113,155,214,319` — Table name interpolated via `${table}`; guarded only by the single `ALLOWED_NF_TABLES` check at line 45 (convention risk — values are parameterized, but identifier interpolation relies on one guard).
- **[important]** `backend/services/nationalCrawlerV2/store.js:97-98,297` — `last_content_hash` stores `payloadHash` while `nf_program_versions.content_hash` stores the raw fetched-bytes `contentHash` — two hash semantics in adjacent columns; version dedup unreliable.
- **[nit]** `backend/services/nationalCrawlerV2/store.js:317` — Entire change_log array read/concatenated/`.slice(-50)`/rewritten every call (O(n) JSON-blob churn).

### backend/services/nationalCrawlerV2/normalize.js
- **[important]** `backend/services/nationalCrawlerV2/normalize.js:113,120-121` — `program_name`/`eligible_population`/`covered_services` taken verbatim from crawled HTML and flow unsanitized into the DB and `computeConfidence` (stored-injection / prompt-injection risk if interpolated downstream).
- **[important]** `backend/services/nationalCrawlerV2/normalize.js:186-190` — Both the `TRACK_A` branch and `else` set `provider_requirements = null`, so TRACK_B provider requirements can never be populated (dead/buggy branch → data loss).
- **[nit]** `backend/services/nationalCrawlerV2/normalize.js:169` — Defaults to `TRACK_A` when no track is inferred (silent misclassification).
- **[nit]** `backend/services/nationalCrawlerV2/normalize.js:29` — `pickSection` uses a fixed 2500-char window; the "until next blankline-ish chunk" comment is unimplemented.

### backend/services/nationalCrawlerV2/registry.js
- **[nit]** `backend/services/nationalCrawlerV2/registry.js:21-27` — `source_id: 'smoke-safe-fed-cms-waivers'` labeled "HUD Rental Assistance" with a hud.gov URL — id/name/agency mismatch (misleading for evidence/audit).
- **[nit]** `backend/services/nationalCrawlerV2/registry.js:113-198` — `buildRegistry` hardcodes live URLs with no health check; `useLive` swaps geography (King County→NYC at 167) so one `source_id` represents different jurisdictions → different `deterministicProgramId`s.

### backend/services/nationalCrawlerV2/run.js
- **[important]** `backend/services/nationalCrawlerV2/run.js:301` — `sha256(buffer.toString('utf8'))` on binary bytes is lossy (invalid sequences → U+FFFD); the content hash is not a faithful fingerprint — breaks change detection for binary sources (and diverges from fetchers.js base64 hashing).
- **[important]** `backend/services/nationalCrawlerV2/run.js:253-416` — Single sequential crawl loop with no concurrency guard or run-level idempotency/locking on `crawl_runs`; overlapping runs (cron + manual) race on the same `program_id` rows (compounded by store.js non-transactional RMW).
- **[important]** `backend/services/nationalCrawlerV2/run.js:312,322,340,403` — DB event writes (`insertEvent.run` for success states) are not in try/catch; a throw is caught by the per-URL handler and misclassified as a `fetch_error`/`parse_error`, corrupting failure stats.
- **[important]** `backend/services/nationalCrawlerV2/run.js:365-372` — `anySuccess = true` is set even when every track upsert failed; a source whose DB writes all failed is still counted as `sources_succeeded`.
- **[nit]** `backend/services/nationalCrawlerV2/run.js:301` — `buffer.toString` at line 301 runs before the `net.ok` check at 304; a null buffer throws on the friendly-HTTP-error path.
- **[nit]** `backend/services/nationalCrawlerV2/run.js:425-426` — Sampled `SELECT * ... LIMIT 5` rows (raw crawled text) written to `sample_output.json` with no PII scrubbing (`redact()` only applied to logs).

---

## nationalPrograms/

### backend/services/nationalPrograms/continuousRunner.js
- **[important]** `backend/services/nationalPrograms/continuousRunner.js:106` — Failure-recovery SQL uses double-quoted literal `SET status = "failed"`; on Postgres `"failed"` is an identifier, so the UPDATE throws and the stuck job is never marked failed, wedging the overlap guard (lines 27-42) indefinitely. Should be `'failed'`.
- **[important]** `backend/services/nationalPrograms/continuousRunner.js:33-37` — Overlap detection via `parameters LIKE '%"mode":"programs"%'` substring match; a hard-crashed job that never reaches a terminal state stays `queued`/`running` forever and permanently blocks the loop (no stale-job reaper).
- **[nit]** `backend/services/nationalPrograms/continuousRunner.js:19` — `Math.max(5, intervalMinutes)` doesn't guard NaN/non-numeric (an env string would yield NaN ms → immediate refire).

### backend/services/nationalPrograms/fetcher.js
- **[important]** `backend/services/nationalPrograms/fetcher.js:99-104` — `fetch(url, { redirect: 'follow' })` follows redirects with no internal-host blocklist; discovered/seed/redirected links can reach `localhost`/`169.254.169.254`/RFC1918 (`sameHost`/`isLikelyProgramUrl` filter only by host-equality/keywords).
- **[important]** `backend/services/nationalPrograms/fetcher.js:95-113` — No 429/`Retry-After`/status-based retry; any HTTP status (429/500/503) returns immediately, only thrown exceptions retry.
- **[important]** `backend/services/nationalPrograms/fetcher.js:80-87` — Race on `state.lastAt`: with `perHostConcurrency = 2`, two same-host tasks read `now`/compute `wait` before either writes `lastAt`, so two requests can fire with no enforced delay.
- **[nit]** `backend/services/nationalPrograms/fetcher.js:110-111` — Backoff sleeps even after the final attempt before throwing (needless latency on the error path).

### backend/services/nationalPrograms/normalize.js
- **[important]** `backend/services/nationalPrograms/normalize.js:84-85,126` — Crawled `program_name`/`extractedText` flow unsanitized into the DB and downstream (potential LLM-prompt/stored-injection); no length cap / control-char stripping at this layer.
- **[nit]** `backend/services/nationalPrograms/normalize.js:102,127` — `source_url` rejected unless http(s), but `source_url_hash = sha256(url)` is computed unconditionally, so the hash can correspond to a URL that was nulled out — inconsistent record.

### backend/services/nationalPrograms/confidence.js
- **[nit]** `backend/services/nationalPrograms/confidence.js:44-49` — `placeholderPenalty` inspects only top-level string values (nested placeholder strings not penalized).
- **[nit]** `backend/services/nationalPrograms/confidence.js:34-37` — `REQUIRED_FIELDS_CLIENT` includes `funding_track`, which `normalizeFromDocument` doesn't set (added later in store.js); a direct call with a normalize-shaped object under-counts.

### backend/services/nationalPrograms/store.js
- **[critical]** `backend/services/nationalPrograms/store.js:57,234,239,295,351` — Table name interpolated into SQL via template literals (`SELECT/INSERT/UPDATE ${table}`); guarded only by the `ALLOWED_TRACKS` check at line 43 — convention violation and latent injection if any path bypasses the guard.
- **[important]** `backend/services/nationalPrograms/store.js:398-409,417-448` — `program_change_events` insert is not idempotent; the post-insert version re-SELECT by `(track,program_id,content_hash)` returns a pre-existing row when `INSERT OR IGNORE` dedups, so a non-`unchanged` transition on identical content emits a duplicate/mislinked change event. Overlapping jobs double-write events.
- **[important]** `backend/services/nationalPrograms/store.js:56-58,234,367` — Mixed sync/async DB API (`await db.prepare().get()` here vs synchronous `.get()`/`.run()` in continuousRunner) plus `db?.dialect === 'postgres'` branch — dual-dialect ambiguity; no transaction wraps upsert + version + event writes (read-your-writes race under Postgres).
- **[important]** `backend/services/nationalPrograms/store.js:147,95` — `nextIsActive = deactivateDueToStatus ? 0 : 1` forces `is_active = 1` for any non-404/410 status (incl. 5xx/403); a transient 500 error page can overwrite good program data and re-activate it (index.js never gates on `response.ok`).
- **[nit]** `backend/services/nationalPrograms/store.js:118,130` — Full `extracted_text` (≤200k chars) written to `program_versions` on every changed crawl; unbounded version-table growth.

### backend/services/nationalPrograms/index.js
- **[important]** `backend/services/nationalPrograms/index.js:107-167` — No `response.ok`/status check before parse+upsert; a 403/500/soft-404 error page is parsed into a "program" and upserted (compounding store.js:147 force-active).
- **[important]** `backend/services/nationalPrograms/index.js:114` — `Buffer.from(await response.arrayBuffer())` with no size cap (memory-exhaustion DoS).
- **[important]** `backend/services/nationalPrograms/index.js:54,42` — `buffer.toString('utf8')` assumes UTF-8 for all non-PDF/DOCX content; the content-type charset is parsed then discarded, so Windows-1252/Latin-1 `.gov` pages produce mojibake in `extractedText`/`content_hash`/stored fields.
- **[important]** `backend/services/nationalPrograms/index.js:202-209` — Discovery cap semantics are muddled: the per-page `break` caps additions, but the cross-page `queue` is unbounded and `maxUrls` counts visited, so queue memory isn't strictly bounded.
- **[nit]** `backend/services/nationalPrograms/index.js:146-147` — PROVIDER track injects `provider_requirements: 'See source URL'`, a placeholder that counts as a "filled" required field and inflates confidence (contradicts normalize's leave-null philosophy).
- **[nit]** `backend/services/nationalPrograms/index.js:170-199` — `program_crosslinks` insert has no idempotency key; re-crawls accumulate duplicate crosslinks (unless an unseen DB unique constraint exists).

### backend/services/nationalPrograms/audit.js
- **[nit]** `backend/services/nationalPrograms/audit.js:25-34` — `logAuditEvent(db, ...)` called without `await`; if async, post-sync errors escape the try/catch and the durable platform-log fallback is skipped. Default call sites pass no `db`, so the DB-audit branch is effectively dead.

### backend/services/nationalPrograms/fetcher / parsers / agents
- **[important]** `backend/services/nationalPrograms/parsers/html.js:27-36` — `new URL(href, url)` resolves `javascript:`/`mailto:`/`data:`/`file:` links into the discovery queue; no scheme allowlist at extraction time (filtering relies on `sameHost` downstream).
- **[important]** `backend/services/nationalPrograms/parsers/pdf.js:12-27` — `pdfParse(buffer)` runs on the raw buffer with no page/size limit or timeout (PDF-bomb CPU/memory).
- **[nit]** `backend/services/nationalPrograms/parsers/docx.js:27-36` — DOCX parse failure returns `extractedText: ''` silently; index.js still upserts, overwriting good fields with empty/`Unknown Program`.
- **[nit]** `backend/services/nationalPrograms/parsers/pdf.js:16` vs `docx.js:17` — Inconsistent truncation signaling (`[CONTENT_TRUNCATED]` marker on docx only).
- **[nit]** `backend/services/nationalPrograms/agents/tn.js:5` — Single combined `administeringAgency` ("DHS / TennCare") applied to every seed URL regardless of which agency owns the page; conflates agencies into `canonical_key`.
- **[nit]** `backend/services/nationalPrograms/agents/federal.js:3` — `administeringAgency: null` for all federal programs → permanent confidence penalty on a REQUIRED field and empty agency segment in `canonical_key` (collision risk).

---

## portalAdapters/

### backend/services/portalAdapters/externalApplicationAdapter.js
- **[important]** `backend/services/portalAdapters/externalApplicationAdapter.js:36-40,103-105` — `canHandle` matches a broad regex (`college[\s-]?board|bigfuture|niche|appily…`) over crawled `application_url`/`source_url`; loose substring matching can route an unrelated opportunity into the auto-draft path. No profile/source scoping.
- **[nit]** `backend/services/portalAdapters/externalApplicationAdapter.js:62-68` — Methods depend on `this` binding (object is `Object.freeze`d, plain methods); a destructured call (`const { fillApplication } = adapter`) throws. Currently safe (registry calls as methods) but fragile.

### backend/services/portalAdapters/universityFinancialAidAdapter.js
- **[important]** `backend/services/portalAdapters/universityFinancialAidAdapter.js:52` — `RegExp.test` over `${opportunity?.title} ${opportunity?.description}` drives FAFSA gating on unbounded crawled free-text (static regex, so no ReDoS-from-user-pattern; flagging that crawled description length should be bounded upstream).
- **[nit]** `backend/services/portalAdapters/universityFinancialAidAdapter.js:90-91` — `getMissingInfo` recomputes the full `inspectRequirements` result just to extract `.requirements` (wasted work + `this`-binding dependency).

### backend/services/portalAdapters/portalAdapterRegistry.js
- **[nit]** `backend/services/portalAdapters/portalAdapterRegistry.js:42-46` — `resolveAdapter` swallows all `canHandle` exceptions silently (`catch {}`); a buggy adapter is invisibly skipped (no warn).

### backend/services/portalAdapters/portalAdapterTypes.js + others
- **[nit]** `backend/services/portalAdapters/portalAdapterTypes.js:142-152` — `readPath` here lacks the array-index handling present in the three concrete adapters; four divergent copies of `readPath` (externalApplicationAdapter, scholarshipPortalAdapter, universityFinancialAidAdapter) — maintenance/divergence hazard.
- **[nit]** `backend/services/portalAdapters/portalAdapterTypes.js:122-128` — `detectMissingDocuments` calls user-supplied `spec.match(d)` with no try/catch (a throwing matcher propagates out of the adapter).
- **[nit]** `backend/services/portalAdapters/basePortalAdapter.js:28-32` — `inspectRequirements` default returns `READY`; a subclass that forgets to override would report "ready" with nothing checked (unsafe default).
- **[nit]** `backend/services/portalAdapters/manualPortalAdapter.js:26,59,68` — Raw `opportunity.application_url` interpolated into user-facing description/status strings with no escaping (rendering layer must escape).
- **[nit]** `backend/services/portalAdapters/scholarshipPortalAdapter.js:118-128` — Duplicate `readPath` (see types divergence); `submitApplication` correctly safe-blocks by default.


---

# backend/utils audit

### backend/utils/safeTokenEqual.js
- **[nit]** `backend/utils/safeTokenEqual.js:22` — Empty-string inputs return `false` even when both are empty (`a === b === ''`). Documented as intentional ("returns false for empty input"), so this is by-design, but callers must never treat an empty configured secret as comparable. The core timing-safe logic is correct: type check → empty check → length check (`bufA.length !== bufB.length`) before `crypto.timingSafeEqual`, so no length-mismatch throw and no timing leak on the compare itself. No bug.
- **[nit]** `backend/utils/safeTokenEqual.js:23` — `Buffer.from(a)` uses default utf8 encoding; multibyte secrets compare by byte length, which is fine and consistent for both args. No issue.

### backend/utils/accessControl.js
- **[important]** `backend/utils/accessControl.js:74-97` — The email fallback builds the IN-clause query with `try { broader query } catch { narrower query }`. The broader query references `lower(email)`; on Postgres a missing `email` column raises an error that aborts the surrounding transaction (Postgres marks the tx as failed), so the `catch` fallback query will itself fail with `current transaction is aborted`. On SQLite this is fine. If `isAdminUserWithDb` is ever called inside a caller-managed transaction on PG, the fallback silently fails and admin is denied. Fail-closed, but can cause admins to "lose" admin when scoped by email only — the exact scenario the comment at :48-54 says it is trying to prevent.
- **[nit]** `backend/utils/accessControl.js:256-281` — The non-json1 SQLite `LIKE` fallback builds `%"email"%${escapedEmail}%`. The escaping only handles `\` and `"`, not the LIKE wildcards `%`/`_` in the email local-part (legal per RFC). A crafted email containing `%` could broaden the match and grant access to additional profiles whose JSON happens to match. Low severity (requires the json1-disabled fallback path AND an attacker controlling their own profile email), but it is a profile-scoping correctness gap. Use an ESCAPE clause or escape `%`/`_`.
- **[nit]** `backend/utils/accessControl.js:464-472` — In `ensureGrantAccess`, the legacy fallback branch (no `req.ctx`) only checks `organization_id` accessibility, never `profile_id`. A grant linked solely by `profile_id` (no org) would be denied for a legitimate non-admin owner when `req.ctx` is absent. The `req.ctx` branch (:457) handles profile_id correctly, so this only bites pre-context callers.
- **[nit]** `backend/utils/accessControl.js:36-44` — `isAdminUser` is documented DEPRECATED but still used as the fallback authorization path in `ensureGrantAccess` (:466). Token-claim admin is exactly the email/claim-based path the file header warns against; acceptable only because it is a fallback, but worth flagging.

### backend/utils/runtimeSecrets.js
- **[important]** `backend/utils/runtimeSecrets.js:9-19` — Indentation is broken (lines 10-16 are flush-left inside the `try`), but functionally fine. The real issue: a base64 key that decodes to `< 32` bytes is sha256-stretched (:19) to 32 bytes, while a key `>= 32` bytes is truncated (:17). A short hex/base64 key therefore produces a *different* key than the same bytes provided directly, and the stretch path means two distinct env values can be silently accepted. Not a vuln, but the "fail loudly rather than downgrade" intent (:21-25) is undercut: short-but-valid encodings are quietly accepted via hashing rather than rejected.
- **[important]** `backend/utils/runtimeSecrets.js:55` — The fallback path hashes `AUTH_JWT_SECRET`/`JWT_SECRET`/`SESSION_SECRET` with sha256 to derive the AES key. If any of these secrets is rotated, every previously-stored runtime secret becomes undecryptable (GCM auth-tag failure throws in `decryptRuntimeSecret`). The `console.warn` at :38 notes this, but `decryptRuntimeSecret` (:72-82) has no try/catch, so a single rotation turns every secret read into an unhandled throw at the call site. Recommend wrapping decrypt in a guarded path or strongly requiring `RUNTIME_SECRETS_KEY`.
- **[nit]** `backend/utils/runtimeSecrets.js:74-76` — `decryptRuntimeSecret` does no validation that `iv`/`tag`/`value_ciphertext` are present/non-empty; `Buffer.from(String(undefined),'base64')` yields a 0-length IV and `createDecipheriv` will throw an opaque error. Guard inputs and throw a typed error for observability.

### backend/utils/uploadsDir.js
- **[nit]** `backend/utils/uploadsDir.js:1-5` — Pure re-export of `uploadsPath.js`; no logic. No issues.

### backend/utils/uploadsPath.js
- **[nit]** `backend/utils/uploadsPath.js:6-13` — `normalizeFsPath` swallows `path.resolve` errors and returns the raw string, so a bad input can produce an unresolved path that later writes go to. In practice `path.resolve` virtually never throws; low risk.
- **[nit]** `backend/utils/uploadsPath.js:55-59` — On Windows, any absolute path not under `/temp` or `/tmp` is "likely persistent". A path like `C:\Temp2\uploads` normalizes to `c:/temp2/...` and `lower.includes('/temp')` is false (no leading slash match) — actually `/temp` substring would match `c:/temp2`. Conversely `C:\contemplate\` contains `templat` not `/temp`, fine. The substring test `includes('/temp')` is a heuristic and can misclassify directories like `.../tempo/...` (contains `/temp`) as non-persistent. Heuristic only, not security-relevant.
- No path-traversal vector here: this module resolves base/env-configured directories, it does not join user-supplied filenames. Callers that join user filenames to `uploadsDir` must sanitize separately.

### backend/utils/recordOrigins.js
- **[nit]** `backend/utils/recordOrigins.js:53-60` — `trustedOriginClause` validates the optional `alias` against `/^[A-Za-z_][A-Za-z0-9_]*$/` and throws on bad input — good. The values list is built via `escapeSqlStringLiteral` (doubles single quotes), and all values come from the hardcoded `UNTRUSTED_ORIGINS`/`ALLOWED_RECORD_ORIGINS` constants, so `allowedOriginCheckSQL` (:94-99) is injection-safe. Note the inconsistent indentation (:54-56, :58) but no bug.
- **[nit]** `backend/utils/recordOrigins.js:79-83` — `trustedSourceClause` does NOT validate its `alias` argument, unlike `trustedOriginClause` at :54. All current callers pass static aliases ('fo' etc.), but this is an inconsistency: if a future caller passes a user-influenced alias, `trustedSourceClause` would interpolate it unchecked. Add the same alias regex guard.

### backend/utils/logger.js
- **[important]** `backend/utils/logger.js:101-116` — The logger does NOT redact secrets/PII. `formatContext` JSON-stringifies arbitrary context objects verbatim; nothing routes through `piiScrubber.scrubPII`. Any caller that passes a token, API key, email, or raw error containing secrets will emit it to console and into the in-memory ring buffer (:138-144) that `getRecentLogs` exposes to the admin/Anya tool. The file's own purpose docs claim structured logging but make no redaction guarantee. Given `piiScrubber.js` exists, consider scrubbing context here, at least for the audit-sink fan-out (:67).
- **[nit]** `backend/utils/logger.js:108-112` — The `JSON.stringify` replacer handles `Error` and `bigint` but circular references fall to the `catch` → `String(ctx)` which yields `[object Object]`, losing all context. Minor observability loss.

### backend/utils/safeSql.js
- **[nit]** `backend/utils/safeSql.js:357-366` — `normalizeOperator` allows `!==` as a sentinel but emits it only via the IS NULL / NOT IN / NOT LIKE branches; for a scalar non-null value with `op: '!=='` it would emit `col !== ?` (line 346), which is invalid SQL in both SQLite and Postgres (they use `!=`/`<>`). The `!==` value is only special-cased for null/array, not scalar. A caller passing `{op:'!=='}` with a scalar produces broken SQL. Map `!==` → `!=` for the scalar branch.
- **[nit]** `backend/utils/safeSql.js:331` — `value === null` with default op produces `col IS NULL`; with `op:'!=='` produces `col IS NOT NULL`. Correct.

### backend/utils/safeJson.js
- **[nit]** `backend/utils/safeJson.js:33` — Double-encoded detection only re-parses when the inner string `startsWith('{')` or `('[')`. A double-encoded JSON *scalar* (e.g. `"\"hello\""` → first parse yields `"hello"`) is correctly left as `hello`. But a double-encoded value whose inner JSON is whitespace-prefixed (`' {...}'`) won't match `startsWith('{')` and is returned as the raw string. Edge case only.
- **[nit]** `backend/utils/safeJson.js:51` — `safeStringifyJSON` logs via `console.warn` on failure (e.g. circular ref → throw) and returns fallback. Acceptable; no redaction concern since only the error message is logged.

### backend/utils/validation.js
- **[nit]** `backend/utils/validation.js:9-12` — `parseInt(query.limit,10) || DEFAULT_PAGE_LIMIT`: a legitimate `limit=0` is falsy and silently becomes the default. Same pattern for offset (:14) where `0 || DEFAULT_OFFSET` resolves to default — harmless only if `DEFAULT_OFFSET===0`. Minor.
- **[nit]** `backend/utils/validation.js:46-56` — `sanitizeColumns` whitelists keys but the resulting object's keys are still later interpolated by some callers; this helper does not itself validate identifier shape (relies on the `allowedColumns` Set being trustworthy). Documented as whitelist-based; fine.

### backend/utils/dbValidation.js
- **[nit]** `backend/utils/dbValidation.js:81-99` — `validateDate` returns `dateObj.toISOString().split('T')[0]`, i.e. the UTC date. A local-timezone date near midnight can shift by a day (e.g. `new Date('2026-06-19 23:00 EST')` → `2026-06-20`). For deadline storage this off-by-one-day is a real correctness risk.
- **[nit]** `backend/utils/dbValidation.js:254-296` — `validateForeignKey` interpolates `safeTable`/`safeColumn` into the SQL, but both are re-resolved from the hardcoded `ALLOWED_FK_TARGETS` map (:277-278) before use, so injection is not possible. The double-resolution (:268 check then :280 check) is redundant but harmless defense-in-depth.

### backend/utils/circuitBreaker.js
- **[nit]** `backend/utils/circuitBreaker.js:43-72` — `exec` reads `snapshot()` once, then on `state==='open' && canAttempt` flips to `half_open` (:54). The success path calls `close()`; the failure path increments `failures` and re-opens if `failures>=threshold || state==='half_open'`. Correct. Minor: `snapshot.canAttempt` is computed from `nowMs()-openedAt`, but there's no max-half-open concurrency guard — two concurrent calls while open+cooled both proceed as half-open trials. Acceptable for an in-process best-effort breaker.

### backend/utils/piiScrubber.js
- **[nit]** `backend/utils/piiScrubber.js:23-32` — `scrubPII` applies SSN regex before LONG_DIGITS, good ordering. But phone is replaced AFTER SSN and email; a 9+ digit run that is actually a phone without separators could be caught by `LONG_DIGITS_RE` first (it runs last, so phone wins) — ordering is fine. `safeLogObject` (:34-40) round-trips through `JSON.parse(scrubPII(obj))`; if scrubbing inserts `[REDACTED_*]` into a JSON string value it stays valid, but if the original object stringifies with redaction breaking a number field into a string, `JSON.parse` still succeeds. Low risk.
- **[important]** `backend/utils/piiScrubber.js` — This module exists but `logger.js` does not use it (see logger finding). The scrubber is only as good as its call sites; grep shows it is not wired into the central logger, so most log output is unscrubbed.

### backend/utils/scopedOpportunity.js
- **[nit]** `backend/utils/scopedOpportunity.js:61-94` — Solid parameterized joins; opportunity is resolved *through* the application row, preventing caller-supplied-id bleed. The `LOOKUP_FAILED` path returns `application:null` even when the app row was found before the join threw, slightly lossy but acceptable. No security issue.

### backend/utils/environment.js
- **[nit]** `backend/utils/environment.js:10-16` — Fine. Note `VERCEL_ENV==='production'` would be true on the frontend host, but this is backend-only code; harmless.

### backend/utils/grantFingerprint.js
- **[nit]** `backend/utils/grantFingerprint.js:50-53` — Deterministic sha256 over normalized tuple; correct and stable. `chooseGrantUrl` only accepts http/https — good. No issues.

### backend/utils/inferLocationFromAddress.js
- **[nit]** `backend/utils/inferLocationFromAddress.js:14` — The state regex `([A-Za-z]{2})\s+(\d{5})` will happily extract a non-state two-letter token (e.g. "...drive XY 12345") as a state code without validating against `stateNormalization`. Callers should pass results through `normalizeState`. Heuristic by design.

### backend/utils/stateNormalization.js
- **[nit]** `backend/utils/stateNormalization.js:138-141` — `normalizeStateFromText` iterates `ABBR_TO_NAME` and returns the FIRST full-name match by object insertion order. Because both US and Canadian entries share the map, a text mentioning two regions returns whichever appears first in the map, not in the text. Minor ambiguity.
- **[nit]** `backend/utils/stateNormalization.js:143-144` — After name matching fails, `\b([A-Z]{2})\b` with `/i` flag matches any two letters, then `normalizeState` filters — fine, returns null for non-states.

### backend/utils/tierGating.js
- **[nit]** `backend/utils/tierGating.js:15-19` — `hasTierCapability` and `requireTierCapability` both short-circuit `true` for `req.ctx?.isAdmin`. Correct, but `hasTierCapability` takes `(db, req, ...)` while `requireTierCapability` takes `(req, res, ...)` and reads `req.db` — inconsistent signatures invite call-site mistakes. No bug.

### backend/utils/openai.js
- **[nit]** `backend/utils/openai.js:31-42` — `messageContentToString` recurses on `content.content`/`content.data` with no depth/cycle guard; a self-referential object would infinite-loop. Provider payloads are not cyclic in practice. Low risk.

### backend/utils/openaiClient.js
- **[nit]** `backend/utils/openaiClient.js:20-25` — `normalizeOpenAIKey` splits on `=` and takes everything after the first `=`, then regex-extracts `sk-[A-Za-z0-9_-]+`. If the raw value legitimately has no `sk-` token it falls back to `afterEquals`, which could be garbage — but `createOpenAIClient` (:59) rejects keys lacking `sk-`/containing `*`. Good. Key never logged in full; diagnostics expose only a 7-char prefix (:39). Sound.

### backend/utils/aiProviders.js
- **[nit]** `backend/utils/aiProviders.js:11,18-19` — Mojibake in `console.warn` strings (`â` from a corrupted em-dash). Cosmetic.
- **[nit]** `backend/utils/aiProviders.js:120` — On the Anthropic success path it returns `openaiError` in the payload but hardcodes `anthropicError:null`, while the OpenAI path returns both as null. Minor inconsistency in surfaced diagnostics, not a bug.
- **[nit]** `backend/utils/aiProviders.js:166,195` — JSON parse path: `isLikelyJson ? safeParseJSON : tryParseJsonLoose` then `typeof parsed !== 'object'` throws. A JSON array passes (`typeof [] === 'object'`), accepted as valid JSON — intended.

### backend/utils/ensureUserPreferencesTable.js
- **[important]** `backend/utils/ensureUserPreferencesTable.js:164` — The legacy-row migration insert binds `@preferences_json` (`COALESCE(@preferences_json,'{}')`) but the `legacyRows` come from `SELECT *` of the OLD table, which has no `preferences_json` column. better-sqlite3 throws "Missing named parameter" when a bound `@name` is absent from the supplied object — so the rebuild path will throw for any DB that actually has legacy rows to migrate, defeating the self-heal. Verify the old schema actually has a `preferences_json` column or pass it explicitly.
- **[nit]** `backend/utils/ensureUserPreferencesTable.js:168-170` — `rows.forEach((row) => insert.run(row))` passes the entire legacy row object as named params; extra/missing columns vs. the `@id/@created_at/@updated_at/@user_id/@preferences_json` placeholders will cause better-sqlite3 to error on unexpected keys too. Fragile.

### backend/utils/ensureOutreachLogsTable.js
- **[nit]** `backend/utils/ensureOutreachLogsTable.js:33-45` — The PG `DO $$ ... IF NOT EXISTS (... proname='set_updated_at') ... CREATE OR REPLACE` block is internally contradictory (it only creates when missing, but uses CREATE OR REPLACE). Harmless. No injection (static DDL).

### backend/utils/ensurePortalCheckResultsTable.js
- **[nit]** `backend/utils/ensurePortalCheckResultsTable.js:1-41` — Static DDL, idempotent, no FK on `profile_id` (TEXT NOT NULL with no REFERENCES) unlike sibling tables — orphan profile_ids possible, but intentional given self-heal context. No issue.

### backend/utils/ensureDesignatedProfiles.js
- **[nit]** `backend/utils/ensureDesignatedProfiles.js:18-33` — `loadSectionsFromDataFile` resolves `dataFile` relative to `process.cwd()` and reads it. `dataFile` comes from the hardcoded `DESIGNATED_PROFILES` config, not user input, so no traversal risk. JSON parse guarded.
- **[nit]** `backend/utils/ensureDesignatedProfiles.js:163-166` — The SQLite branch calls `db.withTransaction((tx)=>{ _seedProfilesSync(tx) })` synchronously but `ensureDesignatedProfiles` is `async`; the sync transaction is not awaited (it's synchronous so fine), but the asymmetry with the awaited PG branch (:159) is easy to misread. All prepared statements are parameterized.

### backend/utils/ensureProfileOrgLinks.js
- **[nit]** `backend/utils/ensureProfileOrgLinks.js:58,121-124` — `nowSql` is `'now()'` or `'CURRENT_TIMESTAMP'` interpolated into INSERT/UPDATE templates. It is a dialect-controlled literal (never user input), annotated with `audit:allow dynamic-sql`. Safe.
- **[nit]** `backend/utils/ensureProfileOrgLinks.js:117-118` — `stmtEmailMatch`/`stmtNameMatch`/`stmtInsertOrg`/`stmtUpdateProfile` are prepared on the top-level `db` but then used inside `_linkProfilesSync(tx)` (SQLite branch, :126-174). For better-sqlite3 statements prepared on the base connection still execute within the active transaction, so this works; but it is inconsistent with the async branch (:188-189) which correctly re-prepares on `tx`. Works for SQLite only by virtue of the single-connection model.
- **[nit]** `backend/utils/ensureProfileOrgLinks.js:230-234` — Wraps `_linkProfilesSync` in `await db.withTransaction(...)` even though it is synchronous; fine.

### backend/utils/ensureFundingOpportunitySchema.js
- **[nit]** `backend/utils/ensureFundingOpportunitySchema.js:92-109` — Column names are hardcoded in `REQUIRED_COLUMNS` and re-validated against `IDENT_RE` (:93) before interpolation into `ALTER TABLE ... ADD COLUMN ${col.name} ${type}${defClause}`. `type`/`defClause` are also static. Injection-safe, idempotent, well-guarded. Good.

### backend/utils/ensureAgentSubsystemTables.js
- **[nit]** `backend/utils/ensureAgentSubsystemTables.js:251-259` — Reads each migration `.sql` file from disk and `db.exec(sql)` wholesale. Files are repo-controlled (not user input), so no injection; `tableExists` validates witness names via `TABLE_NAME_RE` (:120). The `out.repaired` field is lazily created (:242) but not initialized in the returned shape's docs — minor.
- **[nit]** `backend/utils/ensureAgentSubsystemTables.js:177-185` — `recordMigrationApplied` swallows unique/duplicate errors but rethrows others; if a non-unique error occurs it propagates out of the loop iteration's `try` (:258-262) and is caught by the outer catch as a failed apply. Acceptable.

### backend/utils/seedRealOpportunities.js
- **[nit]** `backend/utils/seedRealOpportunities.js:74` — `loadJSON(resolvedRealOppsPath,{required:true})` is called, but `loadJSON` only changes a log message for `required`; it still returns `null` on parse failure and the code falls back to `|| {}`. A corrupted required seed file is silently treated as empty. Acceptable for a seeder.
- **[nit]** `backend/utils/seedRealOpportunities.js:38` — `JSON.parse(readFileSync(...))` is not wrapped per-call in the try at :37-46 — it is. Fine. Errors logged for non-ENOENT only.

### backend/utils/seedAssistanceDirectories.js
- **[nit]** `backend/utils/seedAssistanceDirectories.js:60-112` — Inconsistent indentation (the `upsertOne` body is partly flush-left) but logic is sound: URL is validated `^https?://` at :102 before insert. The early `skipped++` at :63 happens before the regex check, and a non-http URL passes the first guard (truthy) then is dropped silently at :102 *without* incrementing `skipped` — so the returned `skipped` count undercounts URL-rejected records. Minor metric bug.

### backend/utils/seedFaithBasedHousing.js
- **[nit]** `backend/utils/seedFaithBasedHousing.js:151-182` — `registerGeoIndexEntries` re-imports crypto inside the loop (`const crypto = await import('crypto')` at :169) on every iteration — wasteful but cached by the loader. Parameterized inserts; guarded try/catch. Fine.

### backend/utils/seedHousingFunding.js
- **[nit]** `backend/utils/seedHousingFunding.js:69-71` — `eligibility_signals` is conditionally `JSON.stringify`'d only when `typeof === 'object'`; a value that is already a JSON string passes through, but `null` is typeof 'object' and would stringify to `"null"`. `null` → `JSON.stringify(null)` = `'null'` string stored instead of SQL NULL. Minor data-quality issue.

### backend/utils/seedOnStartup.js
- **[important]** `backend/utils/seedOnStartup.js:81-89` — `seedFundingOpportunities` uses a raw `INSERT OR REPLACE` (SQLite-only syntax). This entire module assumes a synchronous better-sqlite3 handle (`db.prepare(...).run(...)` with no await, `INSERT OR REPLACE`, `PRAGMA`). On a Postgres dialect handle these calls would break. It is gated by `isSeedingBlocked()` (production-blocked) so it only runs in dev/test where SQLite is used — acceptable, but the module is silently dialect-specific.
- **[nit]** `backend/utils/seedOnStartup.js:118-120, 313-315, 484-487** — Multiple bare `catch { /* Ignore errors */ }` and `catch { /* Ignore duplicates */ }` swallow ALL insert errors, not just duplicate-key. A schema/constraint regression would be invisible during seeding. Dev-only, low impact.
- **[nit]** `backend/utils/seedOnStartup.js:151-155` — Hardcoded skip of profiles named "rachel"/"joshua"/"josh" via substring match on display_name. Fragile business logic embedded in a util; a legitimate profile named "Joshua Smith" is excluded from seeding. Flagging as a surprising side effect.

### backend/utils/seedBaselineFromRepo.js
- **[nit]** `backend/utils/seedBaselineFromRepo.js:93` — `JSON.parse(fs.readFileSync(seedPath,'utf8'))` in `loadBaselineSeedFromRepo` is NOT wrapped in try/catch; a malformed seed file throws an unguarded SyntaxError up through `seedBaselineFromRepo`. The `existsSync` check (:88) only guards missing-file, not parse failure.
- **[nit]** `backend/utils/seedBaselineFromRepo.js:505-519` — `selectExistingIds` validates `table` against a hardcoded allow-set (:508-515) before interpolating into `SELECT id FROM ${table} WHERE id IN (...)`. Injection-safe. IDs are parameterized. Good.
- **[nit]** `backend/utils/seedBaselineFromRepo.js:757-766` — The retry-on-`documents_status_check` simply re-runs the identical `upsertDoc.run(payload)` with no change to `processing_status`, so it will fail the same check again and rethrow on the second attempt. The retry is a no-op; if the intent was to coerce the status, that coercion is missing.

### backend/utils/ensureMinimumNationalOpportunities.js
- **[important]** `backend/utils/ensureMinimumNationalOpportunities.js:24-39, 76` — Like seedOnStartup, this module calls `db.prepare(...).get()`/`.run()` synchronously (no await) and uses `PRAGMA table_info` and SQLite `ALTER TABLE ... ADD COLUMN`. But `countRealNational` (:53-77) and the schema/backfill run UNCONDITIONALLY at the top of the exported async fn, and it is NOT gated by `isSeedingBlocked()`. On a Postgres deployment, `db.prepare(sql).get()` without await may return a Promise (truthy) → `Number(row?.count)` = `NaN` → comparisons misbehave; and `PRAGMA table_info` is invalid on PG (caught, returns false → may issue an unnecessary `ALTER TABLE ... ADD COLUMN` that on PG lacks `IF NOT EXISTS` and could throw). If this runs against PG it is unsound. Confirm call sites only invoke it for SQLite.
- **[nit]** `backend/utils/ensureMinimumNationalOpportunities.js:61-66` — Country/origin clauses interpolate `trustedOriginClause()`/`trustedSourceClause()` (static, safe) and `activeVal` (dialect literal `'TRUE'`/`'1'`, safe). No injection.

### backend/utils/adminProfileLinks.js
- **[nit]** `backend/utils/adminProfileLinks.js:9-53` — `ensureAdminUser` INSERTs with `is_admin TRUE` and binds ISO-string timestamps; on SQLite `is_admin` boolean TRUE may store oddly but `Boolean(is_admin===true||===1)` reads handle it. Parameterized. `ADMIN_EMAIL` from config, not user input. Fine.
- **[nit]** `backend/utils/adminProfileLinks.js:101` — Copy-paste log label: `linkAllProfilesToAdmin`'s catch logs "in linkProfileToAdmin". Cosmetic.

### backend/utils/profileOwnershipRepair.js
- **[nit]** `backend/utils/profileOwnershipRepair.js:114-124` — `maybeAssignOwner` enforces one-profile-per-user, but the check (`SELECT id FROM profiles WHERE user_id=? LIMIT 1`) then `UPDATE` (:135-137) is not atomic; two concurrent repair runs could both pass the check and assign the same user to two profiles, violating the intended uniqueness. Startup-only/admin-only, low concurrency, but TOCTOU exists.
- **[nit]** `backend/utils/profileOwnershipRepair.js:16-22` — `parseJson` swallows parse errors to a fallback — fine. Email validation regex is permissive but adequate.

### backend/utils/profileResolver.js
- **[nit]** `backend/utils/profileResolver.js:38-69` — All lookups parameterized and case-insensitive; errors swallowed to `null` (resolution is best-effort by design). The reseed path (:121-151) can mutate the DB; callers opt out via `allowReseed:false`. Sound.

### backend/utils/repairOrphanedJobProfiles.js
- **[nit]** `backend/utils/repairOrphanedJobProfiles.js:148-149` — `newIdempotencyKey` uses `row.id.replace(/-/g,'').slice(0,16)` + `Date.now()` base36. Two rows repaired in the same millisecond with id prefixes colliding in the first 16 hex chars could theoretically collide, but UUID prefixes make this effectively impossible. Fine.
- **[nit]** `backend/utils/repairOrphanedJobProfiles.js:38` — `PROFILE_NOT_FOUND_PATTERN = /profile\s.+?\snot found/i` with `.+?` could match unrelated errors like "profile data integrity check not found in cache". Narrow but acceptable given it's paired with `status='failed'`.

### backend/utils/schoolBridgeErrors.js
- **[nit]** `backend/utils/schoolBridgeErrors.js:22-33` — Correct, narrowly-scoped table-missing matcher. The "fallback" comment (:29-32) describes a behavior that the code does NOT implement (it just `return false`), so the comment is misleading dead documentation.

### backend/utils/guardedProfileSectionWrite.js
- **[nit]** `backend/utils/guardedProfileSectionWrite.js:46-47` — `const loaded = context.profile && context.sections ? context : await loadProfileSectionGuardContext(...)`. If a caller passes a context with `profile` but no `sections` (or vice versa), it silently reloads from DB, discarding the partial context. Minor.
- **[nit]** `backend/utils/guardedProfileSectionWrite.js:8-12` — `evidenceHash` truncates sha256 to 16 hex chars (64 bits) for log correlation — fine for non-security correlation use.

### backend/utils/profileSuggestionGuards.js
- **[nit]** `backend/utils/profileSuggestionGuards.js:1` — Pure re-export of `../../shared/profileSuggestionGuards.js`. The actual guard logic lives outside `backend/utils` and is out of audit scope; flag that the security-relevant field-acceptance logic should be audited there.

### backend/utils/profileSectionSync.js
- **[nit]** `backend/utils/profileSectionSync.js:96` — `UPDATE profiles SET ${rule.profileColumn} = ?` interpolates `rule.profileColumn`, but every value comes from the hardcoded `SYNC_RULES` array (:18-70), never user input — injection-safe.
- **[important]** `backend/utils/profileSectionSync.js:97-102` — The catch only stays silent for "no such column"/"does not exist"; any OTHER error is logged but still swallowed (no rethrow), so a failed sync (e.g. constraint violation, locked DB) is non-fatal and invisible to the caller. Given this drives matching/listing correctness (state, serves_veterans, etc.), a silent sync failure means stale denormalized columns and wrong match results with no signal. Consider surfacing non-column errors.
- **[nit]** `backend/utils/profileSectionSync.js:54-69` — Two rules both target `serves_veterans` (demographics.is_veteran and military_service.veteran_status). Depending on call order, one section's update can overwrite the other (e.g. military "none" → 0 clobbers demographics is_veteran → 1). Last-writer-wins across sections may produce incorrect veteran flags.
