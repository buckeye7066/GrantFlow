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
- **[important]** `backend/routes/schoolPortal.js:96-98,291-296` — Admin authorization uses `req.user?.role === 'admin'`, the deprecated non-DB-backed check (`accessControl.js` explicitly says to use `isAdminUserWithDb`/`req.ctx.isAdmin`). These routes mint/revoke partner API keys (broad student-PII access), so they should use the DB-backed admin check.
- **[important]** `backend/routes/schoolPortal.js:176-203` — `GET /students/:external_student_id` returns full merged profile PII but, unlike `/matches` (lines ~217-223), does NOT check `link.consent_status === 'revoked'`. A partner whose student revoked consent can still read the full profile. Inconsistent consent enforcement.
- **[nit]** `backend/routes/schoolPortal.js:124-168` — `/students/sync` iterates `records` with no upper bound on array length; each element triggers a DB merge. Add a cap.
- **[nit]** `backend/routes/schoolPortal.js:325` — Several admin handlers have no try/catch; a DB error becomes an unhandled rejection relying on Express's default handler.
- Positives: partner routes `requireSchoolPartner`-gated, `findLink` scoped by `school_partner_id` (no cross-partner IDOR), API keys hashed and returned once, revoke is partner+key scoped.

### backend/routes/studentPortals.js
- **[important]** `backend/routes/studentPortals.js:38-45` — `userMayAccessProfile` treats `getAccessibleProfileIds(...) === null` as "admin → allow". Admin is already handled one line above, so the `null` branch is a redundant second admin path: if `getAccessibleProfileIds` ever returns null for a non-admin reason (internal error/empty mis-encoded), it silently grants access to ANY profile. Also uses deprecated `user.role === 'admin'`.
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
