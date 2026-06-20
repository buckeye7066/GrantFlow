# Backend Routes Audit (A–M)

Read-only audit of `backend/routes/*.js` files whose names begin with a letter A–M.

Conventions assumed for this repo: auth via `requireAuthenticatedUserMiddleware`/`ensureAuth`; authenticated context on `req.ctx` (`userId`, `activeProfileId`, `email`, `isAdmin` — DB-backed canonical admin); DB via `req.db.prepare(sql).get/all/run(...args)` (parameterized); tenant data queries scoped to the caller's profile/org; admin endpoints require admin authz.

---

### backend/routes/activity.js
- No issues found. Single `POST /page-view` route validates auth from `req.ctx`, validates input, ACKs 204, then runs a guarded fire-and-forget audit write (cannot leak an unhandled rejection). Only writes the caller's own activity, so no tenant-scoping concern.

### backend/routes/admin.js
- **[important]** `backend/routes/admin.js:1710` — `POST /reattach-users` has no in-handler admin check (`ensureAdminRequest` not called) yet performs destructive mass re-assignment of profile ownership (`UPDATE profiles SET user_id = ...`, links all unowned profiles to admin ~1784). Protected today only by router-level middleware; diverges from the defense-in-depth pattern every sibling mutating route uses.
- **[important]** `backend/routes/admin.js:3744` — `POST /link-admin-to-organizations` similarly has no in-handler admin check while mutating `user_organizations`.
- **[important]** `backend/routes/admin.js:1454` — `POST /upload-profile-document` authorizes via `isAdminUser(req.user)` (token-claims only) rather than the DB-backed `isAdminUserWithDb`/`ensureAdminRequest` used elsewhere. Inconsistent admin enforcement on a route that creates profiles and dispatches jobs.
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
- **[important]** `backend/routes/applicationTasks.js:61` — authorization uses `user.role === 'admin'` (e.g. `userMayAccessTask` `:61`, list `:74`) rather than the canonical `req.ctx.isAdmin`. If the admin flag is exposed as `is_admin`/`isAdmin` rather than `role`, this mis-scopes admins. Verify `user.role` is reliably populated.
- **[nit]** `backend/routes/applicationTasks.js:79` — `GET /` non-admin path issues one `listApplicationTasks` query per accessible profile (unbounded fan-out; each capped at 100, but no cap on number of profiles).
- **[nit]** `backend/routes/applicationTasks.js:203` — `POST /:taskId/missing-info` iterates `items` with no count bound, doing sequential DB writes per item.

### backend/routes/applicationWorkflow.js
- **[nit]** `backend/routes/applicationWorkflow.js:67` — `loadApplication` enforces access only `if (row.profile_id)`; a `grant_applications` row with null `profile_id` bypasses `ensureProfileAccess` entirely and is returned (and mutable via the steps/documents/status routes that funnel through it). Cross-tenant hole if null `profile_id` is possible.
- **[nit]** `backend/routes/applicationWorkflow.js:105` — `POST /preview` makes `profile_id` optional; when omitted it runs `generateActionPlan(opportunity, {})` unscoped on attacker-supplied `opportunity`. Low risk (side-effect-free planner) but unscoped.
- **[nit]** `backend/routes/applicationWorkflow.js:96` (every catch) — returns `err?.message ?? String(err)` to the client.

### backend/routes/authMe.js
- **[important]** `backend/routes/authMe.js:263` — `GET /api/auth/diagnostics` has no authn/authz. Leaks secrets-presence metadata (`adminTokenConfigured`, `bulkKeyConfigured`, JWT secret state, per-provider OAuth client-id/secret presence) and DB error strings (`'error: ' + error.message`) to any caller. Should require admin.
- **[nit]** `backend/routes/authMe.js:49` — handler reads the auth principal off `req.user.*` as primary, consulting `req.ctx.isAdmin` only as one of several admin signals — divergence from the `req.ctx` convention.
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
- **[important]** `backend/routes/billing.js:36` — `requireAdmin` checks only `req.user?.role !== 'admin'` rather than the canonical DB-backed `req.ctx.isAdmin`; an admin via `req.ctx.isAdmin` whose `req.user.role` isn't `'admin'` is wrongly 403'd (and vice-versa it trusts only the token-derived role).
- **[nit]** `backend/routes/billing.js:357` / `:372` — uses `req.user.userId` for `assigned_by`/`changed_by`; if undefined it degrades audit attribution to `'admin'`.
- **[nit]** `backend/routes/billing.js:16` — `ensureProfileAccess as ensureProfileAccessByEmail` imported but never used.

### backend/routes/billingSettings.js
- **[nit]** `backend/routes/billingSettings.js:81` — `incoming = req.body` stored wholesale into `custom_preferences.billing_settings` with no allow-list/validation (mass-assignment; low impact, namespaced under the caller's own row).
- **[nit]** `backend/routes/billingSettings.js:51` (and 68, 118, 154) — error responses return `error?.message` regardless of environment.
- Note: tenant scoping is correct — every handler queries `user_preferences WHERE user_id = ?` and `:id` routes verify `row.id === req.params.id` after loading by `userId`; no IDOR.

### backend/routes/blocklist.js
- **[important]** `backend/routes/blocklist.js:48` — `adminAuth` accepts `req.user?.role === 'admin' || req.user?.is_admin === true` as a fallback beside the correct `req.ctx.isAdmin === true`, widening the trust surface to whatever weaker source populates `req.user`. Same in `ingestAuth` (`:64`).
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
- **[important]** `backend/routes/committedCollege.js:81` — `userMayAccessProfile` reads `req.user` and grants access on `user.role === 'admin'`, rather than the DB-backed canonical `req.ctx.isAdmin`. A token claiming `role:'admin'` that is not a DB admin gets full access — token-only admin bypass. Authz for the whole file rests on this non-canonical check.
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
- **[important]** `backend/routes/hamiltonAutomation.js:262` — `GET /tasks` admin detection uses `user.role === 'admin'`; an admin via `req.ctx.isAdmin`/`is_admin` without `role === 'admin'` falls into the non-admin (own-profiles) branch. Same `user.role === 'admin'` at `:137` (`userMayAccessProfile`, which fails safe/more restrictive). Inconsistent with `req.ctx.isAdmin`.
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
- **Non-canonical admin checks**: several files gate admin on `req.user.role === 'admin'`/`req.user.is_admin` instead of the DB-backed `req.ctx.isAdmin` — `billing.js:36`, `blocklist.js:48`, `committedCollege.js:81`, `hamiltonAutomation.js:262`, `applicationTasks.js:61`, `discovery.js:627`. Inconsistent and, in `committedCollege.js`, a token-only admin bypass.
- **Raw `error.message` leaked to clients** across many files (applicationDrafts, applicationWorkflow, contacts, contactMethods, crawlerV2, discovery, expenses, grantApplications, billingSettings, milestones, admin).
- **Client-supplied primary keys / mass-assignment** of `id`/`created_by`/`approved`: applicationDrafts.js:100, budgets.js:145, contactMethods.js:110/130, expenses.js:120, billingSettings.js:81.
- **`Host`-header-derived internal `fetch` (SSRF + credential forwarding)**: anyaMatchSuggestions.js:101, laptopConnector.js:387 (and the `getInternalBaseUrl` pattern referenced in anya.js).
- **Un-awaited `.get()?.count` on the async/postgres path**: crawlerV2.js:38, legacyFunctions.js:354 (silently yields 0/undefined).
