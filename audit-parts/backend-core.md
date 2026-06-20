# Backend Core Audit

Read-only audit of `backend/` core infrastructure: entry points, middleware, config/constants, db layer, startup, jobs, apply, vnext, and prompts. Findings tagged `[critical]` / `[important]` / `[nit]` with `file:line`.

---

## Entry points

### backend/server.js

- **[important]** `backend/server.js:1497` — `jwt.verify(token, EFFECTIVE_JWT_SECRET)` is called with **no `algorithms` allowlist**. Standard JWT hardening requires `{ algorithms: ['HS256'] }` to prevent algorithm-confusion attacks. With a symmetric HMAC secret the practical risk is low, but the allowlist should be explicit.
- **[important]** `backend/server.js:1546` — `const effectiveIsAdmin = Boolean(tokenIsAdmin || sessionRow.is_admin)`. The token-claimed admin flag is OR'd with the DB flag, so a validly-signed token claiming `roles:['admin']` keeps admin even when `users.is_admin` is false in the DB (e.g. admin revoked). Admin revocation is not effective until token expiry. Mitigated downstream by `requestContext` re-resolving from DB, but this contradicts the "admin is DB-backed" invariant stated in the same block's comment (line 1544).
- **[important]** `backend/server.js:1420-1604` — The entire primary auth gate is a large inline `app.use` middleware rather than the dedicated `middleware/authIdentity.js` (which exists and does the same job). Two parallel auth implementations are a divergence/maintenance hazard; only one is actually wired (the inline one), leaving `authIdentity.js` as likely dead code at the server level.
- **[important]** `backend/server.js:668-674` — DB healthcheck failure is caught and the server continues in "degraded mode" without DB. All subsequent startup steps (runtime-secret restore line 690, schema bootstrap, seeding) still issue `db.prepare(...)` against a DB that just failed healthcheck, producing cascading caught errors instead of a clean degraded boot. (Partly guarded later by `app.locals.db_startup_error`, but the secret-restore block at 684-725 runs before that guard is checked.)
- **[important]** `backend/server.js:907` — Legacy SQLite auto-migration builds DDL by string concatenation: `db.prepare(\`ALTER TABLE ${table} ADD COLUMN ${column} ${type}\`)`. Guarded by `validTables` Set + `validColumnPattern` (line 902), so safe in practice, but identifiers are concatenated rather than validated-then-quoted; relies entirely on the whitelist.
- **[important]** `backend/server.js:380-388` — CORS `origin` is set to an array of allowed origins (good), but when `ENV.corsOrigins` is empty it falls back to `defaultCorsOrigins` which includes `http://localhost:5173`/`:3000`. In production these dev origins remain whitelisted; combined with `credentials: true`, dev origins can make credentialed cross-origin requests against a production deploy.
- **[nit]** `backend/server.js:1566` — `if (!handled && token && safeTokenEqual(token, ADMIN_TOKEN))` is dead: the same comparison already ran at lines 1468-1471 (`expectedAdminToken === ADMIN_TOKEN`). This third check can never set `handled` because the earlier one already did. Redundant.
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

- **[important]** `ensureAdminUser.js:30` — Gates on token-claimed role (`user.role !== 'admin'`) rather than DB-backed `req.ctx.isAdmin`, contradicting the "never trust token claims for admin authority" invariant. Impact limited to an idempotent synthetic-admin INSERT, and also requires `user.userId`.
- **[nit]** `ensureAdminUser.js:33-45,59` — TOCTOU between the existence `SELECT` and the `INSERT`: two concurrent admin requests can both pass the check, one INSERT throws on PK conflict, silently swallowed by bare `catch {}` (line 59) which also hides genuine schema errors. Functionally harmless.
- **[nit]** `ensureAdminUser.js:48` — Hardcoded column INSERT with no `ON CONFLICT` guard, inconsistent with upsert patterns elsewhere.

### backend/middleware/rateLimiting.js

- **[important]** `rateLimiting.js:12-44` — No limiter sets a `keyGenerator`, so `express-rate-limit` keys on `req.ip`. Behind Railway/Vercel proxies this is correct only if `app.set('trust proxy', 1)` is set (it is, server.js:171) **and** the immediate upstream is trusted; with `trust proxy: 1` a client-supplied `X-Forwarded-For` can still shift the perceived IP if more than one proxy hop exists. Verify the proxy-hop count matches the trust setting.
- **[nit]** `rateLimiting.js:5-7` — Fallback defaults applied with `||`, so a legitimate `0` (disable) is overridden by the fallback. Unlikely intentional value.

### backend/middleware/requestContext.js

- **[important]** `requestContext.js:194-203` — Auto-upgrades any user whose email matches `isAdminEmail()` to `is_admin = TRUE` in the DB. This is a persistent privilege-escalation path keyed entirely on email match; safe **only** if `isAdminEmail` is a strict exact allowlist (note `config/constants.js` hardcodes `buckeye7066@gmail.com` as a permanent admin — see below).
- **[important]** `requestContext.js:27-28,79-81` — `lastAdminSelfHealAtMs` module-global throttle mutated without a lock; concurrent admin requests can both pass the time check before either updates it, running the heavy self-heal multiple times. Best-effort, racy.
- **[nit]** `requestContext.js:205-212` — Falls back to token-claimed admin (`Boolean(user.is_admin || user.role === 'admin')`) when the DB row is missing or the query throws, re-trusting token claims the file header says never to trust. Acceptable degraded fallback but contradicts the stated invariant.

### backend/middleware/authIdentity.js

- **[important]** `authIdentity.js:149` — `jwt.verify(token, jwtSecret)` with no `algorithms` allowlist (same gap as server.js inline auth).
- **[important]** `authIdentity.js:215` — `effectiveIsAdmin = Boolean(tokenIsAdmin || sessionRow.is_admin)` — token-claimed admin OR'd with DB flag; admin revocation not effective until token expiry (same as server.js:1546).
- **[important]** `authIdentity.js:43,149` — No guard that `jwtSecret` is non-empty before `jwt.verify`; an unset secret throws (caught → guest), failing closed, but no startup assertion, so a misconfigured prod silently rejects all JWT auth.
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

- **[important]** `constants.js:10,16-17` — `DEFAULT_ADMIN_EMAIL = 'buckeye7066@gmail.com'` is hardcoded and **unconditionally** injected into `ADMIN_EMAILS` even when the operator sets a different `ADMIN_EMAIL`. The developer's personal email is therefore a permanent admin in every deployment, removable only by editing source. Combined with `requestContext.js:194` (email-match → persistent `is_admin = TRUE`), this is standing production admin access for a fixed external account.
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

- **[critical]** `designatedProfiles.js:74,184,189-200` — Real PII for real individuals is embedded directly in source and checked into git: full names, personal emails, phone numbers, home addresses, DOBs, EIN (`'88-4291655'`), a Medicaid number (`'Medicaid number: ZECM15043724.'`), VA disability ratings, and detailed medical diagnoses/ICD codes. `missionGoals.js` Goal 11 explicitly prohibits sensitive identifiers (Medicaid ID, medical identifiers) from leaving the system — committing them to the repo is a direct privacy/compliance violation regardless of crawler behavior.
- **[important]** `designatedProfiles.js:67` vs `userProfileMappings.js:23` — Email mismatch: profile email `'Oliviadbeltran@gmail.com'` vs mapping key `'oliviabeltran@gmail.com'` (different local-part, missing `d`). The designated-profile auto-link for Olivia will never match.
- **[important]** `designatedProfiles.js:899` — `owner_email: 'melissa.justus@example.com'` ships a placeholder `example.com` address (also in the urlRules denylist) as production data; this owner can never authenticate.

### backend/config/userProfileMappings.js

- **[important]** `userProfileMappings.js:33` — `anyawhite@rocketmail.com → profile-luibov-samoylenko` maps an "anyawhite" email to Luibov Samoylenko's profile. If that is a different real person (John White's wife is named Anya per designatedProfiles:486), this mis-assigns one user to another person's sensitive medical-assistance profile — a serious access-control/privacy risk worth verifying.
- **[nit]** `userProfileMappings.js:20` — `[ADMIN_EMAIL]: null` computed key; if `ADMIN_EMAIL` collides with another mapping key, order-dependent override.

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
