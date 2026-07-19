# Changelog — Portfolio Security & Integrity Hardening

Branch `claude/portfolio-hardening-2026-07-18` (off `93d271c0`). Six confirmed contract violations fixed; all changes are backward-compatible. No schema/data migrations. No public API shape changes.

## Security fixes (user-visible where noted)

### Multi-tenant isolation (IDOR)
- **`GET /api/reminders` no longer leaks other tenants' data.** A type bug (`Array.isArray` on a `Set`) caused the org filter to be dropped, returning every tenant's grant deadlines and milestones to any authenticated non-admin. Now correctly scoped; an empty access set returns an empty snapshot. Legitimate users see the same data as before — only cross-tenant rows are removed. (`backend/routes/reminders.js`)
- **`POST /api/foundations/reverse-lookup` now enforces profile access.** Previously any user could reverse-look-up any profile and read its derived summary (state, entity type, need categories). Now returns 403 for profiles the caller cannot access — matching the sibling `/score` and `/profile-region` routes. (`backend/routes/foundations.js`)
- **Application-workflow routes fail closed on orphaned (NULL `profile_id`) applications.** The access check was skipped when `profile_id` was null; non-admins now get 403, admins retain access. Affects `GET /:applicationId`, its write sub-routes, and `PATCH /steps/:stepId/complete`. (`backend/routes/applicationWorkflow.js`)

### AI controls
- **Uploaded-document AI extraction can no longer write arbitrary fields onto a profile.** Extracted values are now filtered to each section's known schema keys before merging into `profile_sections`, and the untrusted document text is fenced as data in the extraction prompt with an explicit "do not follow instructions inside" directive. Blunts prompt-injection via uploaded files. (`backend/services/documentIngestion.js`, `backend/prompts/profileSections.js`)

### Honest capability state
- **Email sends now report failure honestly.** The Resend SDK resolves (does not throw) on API rejections; `sendEmail` and `sendAuthAttemptNotification` previously reported success anyway. They now return `{ ok:false, error }` when Resend returns an error — so comms-broadcast "N sent" counts and `status='sent'` audit rows reflect reality. **User-visible:** a broadcast that Resend rejects will now correctly show as failed instead of falsely "sent". (`backend/services/email.js`)

## Compatibility / migration
- No DB migrations. No env-var changes required. No changes to request/response schemas for success paths.
- `mergeSectionData` gained an optional third parameter (`allowedKeys`); omitting it preserves prior behavior. The function is now exported for testability (additive).
- `fetchReminderSnapshot`: passing an **empty** `organizationIds` array now returns an empty snapshot instead of a DB-wide read. Callers that intend "all rows" must **omit** the option (unchanged behavior for the admin/system path, which already omits it).

## Rollback
- Pure code changes on the worktree branch; revert the commit `fix: harden grantflow against confirmed contract violations` to restore prior behavior. No data written, nothing to un-migrate.

## Follow-up round — adjacent-path closures (see PORTFOLIO_AUDIT.md §5b)

An adversarial re-review found each first-round fix had an adjacent bypass; all closed:
- **reminders**: removed the deprecated token-claim admin fast-path so a demoted admin holding a stale role:'admin' JWT is DB-scoped (not DB-wide).
- **Anya `application.completeStep`**: now authorizes (resolve owner → verify applicationId → profile access; orphan rows admin-only) BEFORE completing a step.
- **document AI merge**: reserved keys (`__proto__`/`constructor`/`prototype`) dropped at every depth; nested schema-open objects can only refresh existing keys (no AI-introduced nested eligibility fields); empty allowlist now accepts nothing.
- **prompt fence**: angle brackets in the untrusted context are escaped so document text can't forge the `</APPLICANT_CONTEXT>` sentinel.
- **email honesty**: `sendApplicationEmail` + deadline email/SMS now report Resend/Twilio rejections as failures via a single checked `sendResendEmail` helper (exported from `email.js`); `sendEmail` also routes through it.

Compat: `sendResendEmail` is additive (exported). `mergeSectionData` allowlist semantics tightened — an **empty** array now means "accept nothing" (was "no restriction"); the only callers pass either `null` (no restriction) or a non-empty `config.keys`, so production behavior is unchanged.

## Round 3 — class-closure across siblings (see PORTFOLIO_AUDIT.md §5c)

- **Admin authority is now uniformly DB-backed.** Every route-level `isAdminUser(user)` (token-claim) admin check was migrated to `req.ctx.isAdmin` (recomputed from `users.is_admin` each request) across 14 route files, incl. the `/api/ai/reminders/plan` DB-wide read, expenses/milestones/organizations tenant-scope branches, and the Hamilton/opportunities/pricing/accessGate admin gates. A demoted admin holding an unexpired `role:'admin'` JWT is now treated as non-admin. Synthetic admin/health/anya tokens are unaffected.
- **Document AI array fields are sanitized recursively.** Object elements of `array<object>` profile fields (e.g. `university_applications.applications`) now drop `__proto__`/`constructor`/`prototype` at every depth and, under the schema allowlist, cannot introduce new element fields.
- **Twilio sends report failure honestly.** A single `sendTwilioMessage` helper (in `sms.js`) checks Twilio's resolved `errorCode`/`status`; all SMS callers route through it. **User-visible:** phone-OTP `/phone/start` now only reports "code sent" and starts the resend cooldown when the SMS actually went out — a Twilio failure returns 502 and lets the user retry immediately instead of silently cooling them down with no message.

Compat: `sendTwilioMessage` is additive (exported from `sms.js`). `/phone/start` returns a new `502 { error_type: 'sms_send_failed' }` on genuine delivery failure (previously a misleading 202). The `isAdminUser` migration is behavior-preserving for real admins and synthetic tokens; only stale-JWT demoted admins change (now correctly denied).

## Round 4 — exhaustive admin-claim migration + recursive array allowlist (see PORTFOLIO_AUDIT.md §5d)

- **Every direct JWT-claim admin check is now DB-backed.** Round 3 migrated `isAdminUser(user)`; round 4 swept `backend/` for the OTHER shapes — `user.role === 'admin'`, `roles.includes('admin')`, `user.is_admin` / `req.user.is_admin` — and migrated ~24 authorization sites (Hamilton profile fence + admin gates, application-tasks, funding-sources, committed-college, portal fences, billing/comms profile fences, john/robert/emailGrants/yana admin middleware, maintenance bypass, `opportunityScope.resolveIsAdmin`, and the Anya admin-tool gate which now fails closed on a DB error instead of trusting the token). A demoted admin holding an unexpired `role:'admin'` JWT can no longer reach any admin surface or another profile's Hamilton data.
- **Document-AI array elements are recursively allowlisted.** Nested object keys inside an allowed `array<object>` element (e.g. `applications[].meta.secret_admin_flag`) are now dropped at every depth, not just the element's top level.

Compat: behavior-preserving for real admins and synthetic admin/anya tokens (resolved via `req.ctx.isAdmin`); only stale-JWT demoted admins change (now denied). Login-time side-effects (geo-crawl / Anya scheduler) and the ADMIN_TOKEN self-heal path are unchanged. Two isolated route tests were made faithful to prod by mounting the real `attachRequestContext` middleware.

## Round 5 — fail-closed foundation + last claim-shaped gates (see PORTFOLIO_AUDIT.md §5e)

- **`req.ctx.isAdmin` now fails closed.** The context builder previously fell back to the JWT `role`/`is_admin` claim when the users-table read returned no row or errored — so a demoted admin whose DB read failed still resolved as admin. Admin is now DB-backed only, with two explicit DB-independent exceptions that are NOT token claims: a validated synthetic service token (`system_admin_token`/`system_anya_token`/`system_health_token`) and the server-configured admin email. Any DB error or missing row denies admin. The admin-user self-heal middlewares were restricted to those synthetic ids so a signed `role:'admin'` token with a novel userId can't mint an admin row.
- **Second `/api/auth/me` (in server.js), billing `requireAdmin`, and an application-tasks fence** were still gating on the raw JWT claim — migrated to `req.ctx.isAdmin`. Also migrated: the other `/auth/me` self-heal/fallback branches, `hamiltonPortalSync`, `hamiltonTailoredApplication`, and the `emailGrants`/`vehicles` ingest-auth token ORs.
- **Nested arrays** inside document-AI array elements are now recursively allowlisted (previously only nested objects were).

Compat: behavior-preserving for real DB admins, the configured owner email, and validated synthetic tokens; only stale/forged `role:'admin'` tokens and DB-error cases change (now denied). Four isolated route-test harnesses were updated to use the validated synthetic ADMIN_TOKEN identity (their previous fake `role:'admin'` user relied on the now-removed fail-open fallback).

## Round 6 — provenance-bound service admin + two more scope defects (see PORTFOLIO_AUDIT.md §5f)

- **Synthetic (service-token) admin is now bound to provenance, not an id value.** A `serviceToken` flag is set only inside the validated `safeTokenEqual` service-token branches; a signed JWT whose `sub` collides with `system_admin_token`/`system_anya_token`/`system_health_token` can no longer impersonate the service token (and can't resolve the persisted synthetic `users` row). `/api/admin/*` correctly forbids it.
- **Nested array-of-arrays in document-AI output** are now flattened and shape-sanitized (previously they slipped through the primitive-array path, storing arbitrary keys / `__proto__`).
- **A fail-closed (`isAdmin=false`) context can never carry the null all-access sentinel** — the accessible-profile/org sets are coerced to empty (deny) for any non-admin context.

Compat: behavior-preserving for real DB admins, the configured owner email, and the validated ADMIN_TOKEN/Anya/health service tokens; only forged/colliding tokens and DB-error cases change (now denied). Four route-test harnesses and the auth-identity matrix were updated to the provenance model.

## Round 7 — no JWT-supplied claim grants authority by value (see PORTFOLIO_AUDIT.md §5g)

Finishes the principle across the three remaining token-claim vectors plus an array-sanitizer edge:
- **Configured admin EMAIL** is honored only from the trusted DB users-row email — a JWT that carries the configured admin address can no longer self-promote (or persist `is_admin=TRUE`).
- **Token `profile_id`** no longer self-authorizes a tenant: accessible profiles come from DB ownership / email grants; a JWT `profile_id` is honored only via a `profileTokenAuth` provenance flag set solely in the DB-verified legacy profile-token branch.
- **Raw JWT admin role** can no longer set an admin SQL `actorRole` — the AsyncLocalStorage tenant-guard role derives from `req.ctx.isAdmin` only, so a demoted admin's stale `role:'admin'` token stays profile-scoped.
- **Document-AI array sanitizer** now enforces a shape even on an empty base (drops unlisted keys instead of falling back to reserved-only) and drops objects injected into `array<string>` fields.

Compat: behavior-preserving for real DB admins, the configured owner (resolved from their stored email), validated service tokens, and the non-prod legacy profile token; only forged/stale JWT claims change (now denied). First-time untrusted-AI population of an empty `array<object>` field is now conservatively dropped until a trusted element shape exists.

## Round 8 — email-based profile grants derive only from the DB-verified email (see PORTFOLIO_AUDIT.md §5h)

- **Email-based profile access is now DB-verified-email-only.** `getAccessibleProfileIds` matched profile email grants against the token-supplied `req.user.email`, so a signed/stale JWT claiming `victim@example.com` picked up victim's shared profiles. Grants now derive from `getTrustedUserEmails` — the user's DB `users.primary_email` plus verified `user_credentials` — never the token email.
- **The duplicate `GET /api/profiles?scope=mine` email logic is removed** in favor of the shared DB-backed `getOwnedAndGrantedProfileIds` helper; no route re-derives access from `req.user.email`.
- **The `basic_information` email auto-link** (which writes a `profile_emails` grant) now checks the caller's DB-verified emails, not the token email.

Compat: behavior-preserving for users whose DB `primary_email`/verified credentials legitimately match a profile grant; only forged/stale JWT email claims change (now grant nothing). Flagged residual: `agentControlOrchestrator.isControlCenterAdmin` matches the owner via `user.email` but sits behind `/api/admin` `ensureAdmin` (DB-backed) — documented, not changed (a safe fix needs internal-token provenance rework).

## Round 9 — the root: ctx.email is DB-hydrated (see PORTFOLIO_AUDIT.md §5i)

- **Chokepoint fix:** `req.ctx.email` is now hydrated from `users.primary_email` (DB), never from the JWT payload email; the raw token email is preserved as `req.ctx.tokenEmail` for display/attribution only. If the DB email can't be resolved (missing row / DB error) and the caller isn't a synthetic service admin, `ctx.email` is empty (fail closed). This makes every downstream `ctx.email` reader DB-safe at once.
- **`/api/auth/me`** no longer builds the non-admin profile list from the token email — it uses the DB-backed `getOwnedAndGrantedProfileIds`.
- **Document delete** legacy-ownership no longer matches saved profile emails against the token email — only the caller's DB-verified emails (`getTrustedUserEmails`).

Compat: attribution/`createdBy`/`actor` labels that read `ctx.email` now show the DB email (or fall back to `userId`) instead of a possibly-token email — a cosmetic change on already-gated paths. Access/ownership behavior is preserved for users whose DB email legitimately matches; only forged/stale token-email claims change (now grant nothing).

## Round 11 — grant helper fails closed on missing user; share ≠ delete-owner (see PORTFOLIO_AUDIT.md §5k)

- **`getOwnedAndGrantedProfileIds` now fails closed for a deleted/nonexistent user.** It requires a real `users` row for the resolved userId (or a validated synthetic-service / legacy-profile-token provenance) before applying any ownership/email/legacy grant — so a stale JWT for a deleted user gains no profiles even if `profiles.user_id` still references it. Centralized in the helper so every direct caller (`?scope=mine`, `/api/auth/me`, `ensureProfileAccess`) is covered.
- **Legacy NULL-owner document delete no longer treats a shared `profile_emails` email as ownership.** Destructive ownership for a NULL-`user_id` profile is proven only by the profile's own `basic_information.email`; a collaborator shared via `profile_emails` gets 403 on delete.

Compat: behavior-preserving for real users, validated service/legacy tokens, and actual profile owners; only stale/deleted-user JWTs and share-only collaborators change (now denied).

## Round 12 — synthetic-id reservation in the helpers, trusted-identity flag, exact-field delete proof (see PORTFOLIO_AUDIT.md §5l)

- **Reserved synthetic ids are rejected without provenance in the access helpers.** A new shared `middleware/syntheticServiceTokens.js` is the single source of truth; `getOwnedAndGrantedProfileIds` and `isAdminUserWithDb` now return empty/false immediately for a userId that collides with `system_admin_token`/`system_anya_token`/`system_health_token` but lacks the `serviceToken` provenance flag — so a self-healed synthetic `users` row can never be hijacked by a colliding-`sub` JWT.
- **`req.ctx.identityResolved`** is a new trusted-identity flag (true only for a real users row / validated service or legacy-profile-token provenance). Profile subroutes no longer treat a deleted-user `ctx.userId` as ownership — the `canAccessProfileRowFromCtx` and `router.param('id')` fallbacks are gated on it.
- **Legacy document-delete owner proof is an exact root-field comparison.** The SQLite json1-absent fallback no longer uses a `LIKE` substring (which matched nested contact emails); it parses the section JSON in JS and compares only `basic_information.email`, failing closed on unparseable data.

Compat: behavior-preserving for real users, validated service/legacy tokens, and actual profile owners; only colliding-synthetic-id JWTs, deleted-user JWTs, and nested-email collaborators change (now denied). `isSyntheticServiceAdmin` is re-exported from `requestContext` for existing importers.

## Round 13 — comprehensive ctx.userId ownership-gate audit (see PORTFOLIO_AUDIT.md §5m)

Closed the remaining `ctx.userId`-as-ownership fallbacks a full backend audit surfaced:
- **`POST /api/profiles`** (create/adopt) now requires `req.ctx.identityResolved === true` for non-admins — a deleted-user or synthetic-id-collision JWT can no longer adopt/create an owned profile under its stale/reserved id.
- **`/api/outreach-logs`** access is decided by the canonical DB-backed `req.ctx.accessibleProfileIds` (fails closed) instead of `ctx.userId === profiles.user_id`; soft-deleted profiles are rejected.
- **`/api/auth/me`** `is_admin` (and the admin profile-list gate) now come from `req.ctx.isAdmin` only — never `dbUser.is_admin`, which a self-healed synthetic row would report true for a colliding JWT.
- **`/api/grant-applications`** (all user-scoped handlers) gained a router-level guard denying non-admins without a resolved identity.

Attribution-only uses of `ctx.userId` (crawl-job `user_id`, `approved_by`/`created_by`/`updated_by` labels) were reviewed and left as-is (not access decisions). No `is_admin`/`role` response field is sourced from a raw `dbUser`/token value anymore.

Compat: behavior-preserving for real users, validated service/legacy tokens, and admins; only deleted-user and synthetic-collision JWTs change (now denied everywhere).

## Round 14 — structural fail-closed identity gate ends the ungated-caller-id class (see PORTFOLIO_AUDIT.md §5n)

- **One middleware closes the class.** New `enforceResolvedIdentity` (mounted after `attachRequestContext`, before the routers) nulls the caller id on BOTH `ctx.userId` and `req.user.userId`/`id`/`user_id` for any non-admin request whose identity did not resolve to a trusted principal (deleted-user JWT / synthetic-id collision). Every user-scoped route — audited or not, reading `ctx.userId` OR `req.user.userId` — then fails closed. `/api/auth/*` is exempt (it gates itself). Real users, admins, validated service/legacy tokens, and guests are unaffected; the signup/adopt path (real users row) is verified unaffected.
- **The 3 newly-found routes** (`/api/foundations/calendar/deadlines`, `/api/anya-match-suggestions` `/pending`+accept+dismiss, `/api/saved-grants` GET/POST/PATCH/DELETE) also gained explicit `requireResolvedIdentity` gates (defense in depth), and take the caller id from `req.ctx.userId`.

Compat: behavior-preserving for real users, validated tokens, admins, and the signup flow; only deleted-user and synthetic-collision JWTs change (now denied everywhere). Two existing tests updated to prod-faithful contexts (`savedGrantsProfileScope` gains a `req.ctx` with `identityResolved:true`; the colliding-JWT admin-route assertion accepts 401 or 403 — both denied).

## Round 15 — clear the whole untrusted identity surface + deny-on-unresolved helpers (see PORTFOLIO_AUDIT.md §5o)

- **The structural gate now clears the ENTIRE untrusted identity surface.** r14 nulled only `userId`, so a synthetic-collision JWT rehydrated admin/all-access via the surviving token `profileId` (→ owning user), token email (→ user), or role/is_admin claim. `enforceResolvedIdentity` now nulls `ctx.userId/email/activeProfileId`, empties the accessible sets, and reduces `req.user` to a guest — so no helper can re-resolve identity or admin from any token field.
- **Defense in depth in `isAdminUserWithDb`:** a resolved userId (via a token `profileId`) or an email-matched row whose id is a reserved synthetic service id now returns false without `serviceToken` provenance.
- **`GET /api/pricing/my-estimate/:profileId`** now requires a resolved identity and `ensureProfileAccess(:profileId)`, and scopes the quote query by `profileId` (added a `profileId` filter to `listQuotes`).

Compat: behavior-preserving for real users, admins, validated tokens, and the auth flow (`/api/auth/*` exempt); only deleted-user and synthetic-collision JWTs change (now fully denied — no admin, no profile access via any token field).

## Round 16 — close the `/api/auth*` residual: user-scoped auth mutations are identity-gated (see PORTFOLIO_AUDIT.md §5p)

- **`PATCH /api/auth/onboarding-state` now fails closed.** The route is exempt from the structural `enforceResolvedIdentity` gate (identity-establishing endpoints must run pre-identity), so its un-nulled `ctx.userId`/`req.user.userId` let a deleted-user or synthetic-collision JWT write onboarding/tour state (the collision case mutating the reserved `system_admin_token` row). It now calls `requireResolvedIdentity(req, res)` before reading any id, derives the id from `req.ctx.userId` **only** (removed the `req.user?.userId/id` fallback, which isn't guest-nulled on this exempt path), and returns `404` on a zero-row UPDATE instead of a silent success.
- **Audited all `/api/auth*` handlers:** every other route is identity-**establishing** and self-validates against a presented credential (email/phone/OTP/password/OAuth, refresh-token hash, session revocation), not a claimed caller id — `onboarding-state` was the only user-scoped state mutation.
- **Fixed a false-positive regression test:** the r15 collision test used a nonexistent `profileId:'p-svc'`, so it never drove the `profileId→profiles.user_id→system_admin_token` rehydration guard. It now uses the seeded `'svc-owned'` (asserting the precondition mapping) so it genuinely exercises the guard.

Compat: behavior-preserving for real resolved users (they update their own onboarding state) and admins; only deleted-user and synthetic-collision JWTs change (now 403, reserved row untouched). New tests: 3 in `ownershipIdentityGates.test.js` (deny deleted/synthetic, allow real), verified red without the gate.

## Round 17 — OTP adoption is credential-bound + /api/auth/me is identity-gated (see PORTFOLIO_AUDIT.md §5q)

- **[HIGH — tenant takeover] OTP-verify profile adoption is now bound to the presented credential.** `POST /api/auth/{email,phone}/verify` accepted a caller-supplied `profile_id` and `attachProfileToUser` attached ANY unowned profile — so an OTP holder who knew an unrelated, unowned profile id could claim it. `attachProfileToUser(db, userId, profileId, { verifiedEmail })` now: allows re-selecting an already-owned profile; rejects another user's profile (403); and adopts an UNOWNED profile only when `profileIsBoundToEmail` matches the just-verified email (designated map / `profile_emails` grant / `basic_information.email` / owner's primary email). The email path passes the verified email; the phone path passes none (no verified phone→profile binding), so it can only re-select an owned profile, never adopt.
- **[MEDIUM] `GET /api/auth/me` now requires a resolved identity.** The route is exempt from the `enforceResolvedIdentity` structural gate, and it read `users` by the raw `req.user.userId` before checking `identityResolved` — a synthetic-collision JWT (`sub=system_admin_token`) read the self-healed reserved row and got a 200 payload. It now rejects unless `req.ctx.identityResolved === true || req.ctx.isAdmin === true` and sources the id from `req.ctx.userId`.
- **Re-audited every `/api/auth*` handler** and classified each as identity-establishing (safe under the exemption), user-scoped read/write (must be identity-gated — both now are), or credential-adoption (must be credential-bound — both verify paths now are). Full classification in PORTFOLIO_AUDIT.md §5q.

Compat: behavior-preserving for real users (adopt/re-select their own or their-email-bound profiles; read their own `/me`), validated admins, legacy profile tokens, and the OAuth/password flows (adoption there already uses DB-derived emails); only cross-credential adoption of an unowned profile and unresolved/synthetic `/me` reads change (now denied). New tests: `otpProfileAdoptionBinding.test.js` (10) and `authMeIdentityGate.test.js` (3, full-app), both verified red without their fix. Two auth helpers (`attachProfileToUser`, `profileIsBoundToEmail`) added to the existing test-export block.

## Round 18 — email OTP genuinely proves inbox possession (see PORTFOLIO_AUDIT.md §5r)

- **[HIGH] The email OTP no longer leaks a brute-forceable verifier.** `/email/start` signed a JWT containing `code_hash = sha256(email:code)` and returned it to the requester; a JWT is signed, not encrypted, so the client could decode the hash and brute-force all 1,000,000 six-digit codes offline, then `/email/verify` accepted the matching token (`tokenOk`) and skipped the DB row. Now: `signOtpToken` embeds no verifier (opaque challenge reference only) and `/email/start` signs it without the code hash; `/email/verify` trusts only the server-side one-time, expiring DB code row (client token removed); and a max-attempts lockout (`EMAIL_MAX_VERIFY_ATTEMPTS`, default 6) bounds an online brute-force with `429 too_many_attempts` + invalidation of the active code. Removed the now-unused `verifyOtpToken`.
- **Phone path audited — already safe:** `/phone/start` signs no token and `/phone/verify` verifies only against the DB code row. No change.
- This makes `/email/verify` genuinely identity-establishing, which is what the r17 credential-bound profile adoption depends on.

Compat: behavior-preserving for the real login flow (a user who receives the emailed code still verifies); only the offline-recoverable token verifier and the tokenOk DB-skip change (both removed). New test: `emailOtpTokenNoVerifier.test.js` (3, full-app), verified red under the pre-fix behavior. Two tests that relied on the token bypass (`refreshLoginRecording`, `adminReinterviewGate`) were made prod-faithful (seed the real server-side DB code row).

## Round 19 — OTP verification is atomic under concurrency (see PORTFOLIO_AUDIT.md §5s)

- **[HIGH] Closed the OTP verify TOCTOU race.** The r18 verification checked the attempt cap, then separately matched a code, then separately incremented/consumed — no transaction or affected-row check. Under pooled Postgres, parallel wrong guesses could all slip under the cap, and two parallel correct submissions could both consume a one-time code and mint two sessions. New choke point `atomicVerifyOtpCode` runs the whole check-and-consume in ONE transaction: Postgres `SELECT … FOR UPDATE` / SQLite `BEGIN IMMEDIATE`; cap re-read under the lock (locked code stays locked); one-time consume as a single conditional `UPDATE … WHERE consumed_at IS NULL` that must affect exactly one row (else `already_consumed` — no second session); raceless `attempt_count + 1`; constant-time hash compare (`timingSafeEqualHex`).
- **Phone parity:** `/phone/verify` had the same shape and now uses the same helper (`PHONE_MAX_VERIFY_ATTEMPTS`) — one session per one-time phone code, exact cap (it had none before).
- **Defense in depth:** `/email/verify` rate limiter keyed by normalized email + IP (`AUTH_EMAIL_VERIFY_RATE_LIMIT`, default 30/10 min).

Compat: behavior-preserving for the normal single-request login (correct code → session; wrong → invalid; too many → 429); only concurrent double-submit and parallel brute-force change (now strictly bounded / single-session). New test `otpVerifyAtomicity.test.js` (4: 2 concurrent full-app + 2 deterministic helper units), verified red by removing the cap + one-time-consume logic. Two SQLite test shims (`refreshLoginRecording`, `adminReinterviewGate`) gained `withTransaction`/`dialect` to mirror the real `SqliteDb`. `findMatchingActiveVerificationCode` (superseded) removed.

## Round 20 — one consumable OTP per credential + per-code cap on the matched row (see PORTFOLIO_AUDIT.md §5t)

- **[HIGH] Closed the multi-row OTP lockout bypass.** r19 enforced the cap only on the LATEST active code, and `/email/start` + `/phone/start` appended new codes without invalidating older active rows — so a locked-out older code stayed active and, after a fresh `/start` minted a newer (attempt_count=0) row, could still be verified (lockout bypass; alternating start+guess gave unlimited attempts on a target). Two belt-and-suspenders fixes: (1) new `insertFreshVerificationCode` invalidates all prior active codes in the SAME transaction as the insert → exactly one consumable active code per credential (both start paths use it); (2) `atomicVerifyOtpCode` enforces the cap on the MATCHED row (not just latest) → a matched-but-capped older row is `locked_out`, never consumed.
- All r19 properties preserved (row-locked tx, conditional one-time consume requiring one affected row, constant-time compare, phone parity, email+IP rate limiter); the parallel-correct→one-session and parallel-wrong→cap-bounded guarantees still hold.

Compat: behavior-preserving for the normal login (start → verify newest code → session); only stale/locked older codes change (now always invalidated at the next start and never consumable). New test `otpLockoutBypass.test.js` (4: dialect-agnostic unit for both shared helpers + full-app email + full-app phone), verified red by reverting both fixes (reproduces the bypass). `insertFreshVerificationCode` exported for the suite.

## Round 21 — one active OTP holds under concurrent /start (serialize + partial-unique-index) (see PORTFOLIO_AUDIT.md §5u)

- **[HIGH] Closed the concurrent-/start multi-active-code race.** r20's `insertFreshVerificationCode` made one caller's invalidate+insert atomic but didn't serialize two callers; on Postgres READ COMMITTED, two `/start` for the same credential could both invalidate before either insert was visible and leave TWO active codes (reopening the r20 lockout-bypass surface). Fix, both halves: (1) the mint now locks the parent credential row (`SELECT … FOR UPDATE` on Postgres; SQLite `BEGIN IMMEDIATE`) FIRST, re-checks the resend cooldown under the lock, and updates credential metadata in the same transaction — returning `{minted, retryAfterSeconds}` so `/start` 429s when throttled; (2) new migration `136_one_active_otp_code.sql` (+ Postgres `0140_…`, + `schema.sql`) adds a **partial unique index** `ON user_verification_codes(credential_id) WHERE consumed_at IS NULL` as a hard DB backstop (idempotent; de-dupes pre-existing violations first). The helper tolerates a unique-violation (23505 / SQLITE_CONSTRAINT_UNIQUE) as "another start won".
- All r19/r20 properties preserved (row-locked verify, matched-row cap, one-affected-row consume, constant-time compare, phone parity, email+IP limiter, single active code).

Compat: behavior-preserving for normal login (one start → one active code → verify); only concurrent starts change (serialized to one active code). New tests in `otpLockoutBypass.test.js` (concurrent-mint→one active; partial-unique-index rejects a 2nd active; migrated-DB rejects a 2nd active; concurrent /email+/phone start→one active), plus the r20/r19 guarantees still hold. Honest limitation noted: SQLite serializes writers so the true pooled-PG race isn't reproducible; the partial-unique-index backstop is the storage-level guarantee.

## Round 22 — winner-only OTP send + atomic idempotent credential/user creation (see PORTFOLIO_AUDIT.md §5v)

- **[HIGH] Send only for the serialized mint winner + compensate on failure.** `/phone/start` sent the SMS BEFORE the serialized mint, so two concurrent starts both sent (loser got an unstored, unverifiable code + a duplicate Twilio charge). Reordered: mint FIRST, winner-only send, loser 429s without sending. On a send failure after the mint, new `compensateFailedOtpSend` invalidates the minted code AND rewinds `last_sent_at` (no verifiable code the user never received; retry not cooldown-blocked). `/email/start` (already mint-first) applies the same compensation, gated on `isEmailServiceConfigured()` so the unconfigured/dev/queued path stays tolerant and only a configured-but-failed send compensates + 502.
- **[MED] First-ever concurrent `/start` creates exactly one credential/user/profile.** `ensureEmailCredential`/`ensurePhoneCredential` did select-then-insert outside any lock. Now the common path stays lock-free but first-ever creation runs serialized per identifier (Postgres `pg_advisory_xact_lock`; SQLite `BEGIN IMMEDIATE`) + idempotent (`ON CONFLICT (type,identifier) DO NOTHING` for the credential; phone user `ON CONFLICT (primary_phone) …`; profile assigned only for the true creator). New migration `137_users_primary_phone_unique.sql` (+ Postgres `0141_…`, + `schema.sql`) adds a partial unique index on `users(primary_phone)` (idempotent, non-destructive de-dupe first) as the backstop.
- All r19/r20/r21 properties preserved.

Compat: behavior-preserving for normal login; only concurrent/first-ever starts and configured-email send failures change (winner-only send, compensation, no duplicate users). New tests: `otpStartOrdering.test.js` (compensation unit + first-ever/post-cooldown concurrent) and `otpEmailSendCompensation.test.js` (mocked configured email: failure→502+compensation+retry-unblocked; success→sender-once). Honest limitation noted: SQLite serializes writers so the true pooled-PG race isn't reproducible; the phone-uniqueness partial index is the storage-level backstop.

## Round 23 — de-dup keeps the credential-owned user + scoped/late-safe OTP compensation (see PORTFOLIO_AUDIT.md §5w)

- **[HIGH] Phone de-dup migration keeps the phone on the credential-owned user.** r22 kept the OLDEST duplicate-phone user and nulled the rest, which could strand the `phone_otp` credential on a nulled-phone user → `/phone/verify` re-hits the unique index after consuming the code → persistent 500s. Migration `137_…`/`0141_…` now: null the phone on every non-canonical owner (canonical = the credential's user if present, else oldest), then restore the phone on a credential-owned user an earlier run nulled (when free). Idempotent, non-destructive.
- **[MED] Configured email failures after the route timeout are now compensated.** On a configured-provider timeout, a late handler on the send promise runs `compensateFailedOtpSend` if the send eventually fails — no active/verifiable/undelivered code + preserved cooldown leak. Unconfigured/dev stays tolerant; a late success keeps the code.
- **[MED] Compensation is scoped to the exact failing mint.** `insertFreshVerificationCode` returns the minted code id (`RETURNING id`) + mint timestamp; `compensateFailedOtpSend(db, cred, { codeId, sentAt })` only invalidates THAT code if still active and only rewinds `last_sent_at` if it still equals that mint — so a slow send's late failure can't destroy a newer good code or erase its cooldown. Idempotent; phone + email.
- All r19–r22 properties preserved.

Compat: behavior-preserving for normal login; only the de-dup canonical choice, late-configured-email failures, and superseded-mint compensation change. New tests: `otpPhoneDedupMigration.test.js` (migration fixture, red-able), plus late-failure/late-success + scoped-compensation cases in `otpEmailSendCompensation.test.js` / `otpStartOrdering.test.js`. Honest limitation noted: SQLite serializes writers so the true pooled-PG race isn't reproducible; the migration fixture + partial unique index are the storage-level guarantees.

## Round 24 — forward repair migration for stamped DBs + ownership repoint (see PORTFOLIO_AUDIT.md §5x)

- **[HIGH] The r23 phone-dedup repair now ships as a FORWARD migration.** r23 edited `137`/`0141` in place, but the runner skips already-stamped files by filename — so r22-stamped DBs never got the credential-owned repair (the stranded-credential 500 persisted). New forward migrations `138_repair_phone_dedupe_repoint.sql` + Postgres twin `0142_…` perform the repair idempotently; corrected `137`/`0141` remain fresh-install coverage. Rule adopted: never edit an applied migration to change data behavior — add a forward one.
- **[MED] Phone de-dup repoints the losing duplicate's ownership to the canonical user.** Previously only `users.primary_phone` was cleared, stranding the duplicate's profile/data ("logs in but can't see their data"). `138`/`0142` build a `dup→canonical` map and repoint account-level ownership, conflict-guarded. **Repointed:** profiles, saved_grants, user_organizations, user_preferences, stripe_customers, user_credentials, user_providers, service_purchases, student_portals, application_portal_links, application_tasks, pricing_quotes, anya_sessions, anya_runs, anya_onboarding_events (profile-scoped data follows the profile). **Excluded (documented):** transient auth (user_sessions, password_setup_tokens) and pure actor/audit stamps + agent-run logs (created_by / *_by_user_id / assigned_to / reviewed_by / approved_by / actor_user_id / consumed_by / hamilton_* / *_runs / agent_activity_events / anya_tool_usage / anya_brain_memory.scope_id) — repointing those would falsify history.
- All r19–r23 preserved. Conflicts handled non-destructively (repoint only when the canonical has no colliding row).

Compat: behavior-preserving; the forward migration repairs stranded phone credentials + ownership on already-deployed DBs. New tests in `otpPhoneDedupMigration.test.js` (forward-migration selection; age-based-137-then-138 repair; profile/saved_grant repoint; idempotent + fresh-install no-op), verified red by removing the repoint / restore steps.

## Round 25 — phone-dedup moves data as consistent units, never splitting ownership (see PORTFOLIO_AUDIT.md §5y)

- **[HIGH x2] Fixed split-ownership from the r24 per-table conflict-skip.** r24 could leave a row with `user_id` on the canonical but `profile_id`/`stripe_customer_id` on the duplicate (e.g. profile stays on dup while its saved_grants moved to canonical; service_purchases moved while stripe_customer stayed). `138`/`0142` rewritten to move each duplicate as an ALL-OR-NOTHING unit: a `mergeable` dup (canonical + dup don't both own any 1-per-user resource — profile / stripe_customer / user_preferences) has ALL its owned rows moved to the canonical (no collisions possible, so no split); an UNMERGEABLE dup has NOTHING moved (stays fully self-consistent, loses only phone login) and is recorded in a new `phone_dedupe_conflicts` table for manual owner reconciliation.
- Core invariant: after the migration, no row's user_id / profile_id / stripe_customer_id point at different accounts. Membership-PK and credential-UNIQUE collisions are still guarded (skipping a redundant row never splits). Idempotent + fresh no-op. `138` and `0142` SQL bodies are identical (parity-tested).
- All r19–r24 preserved. New `phone_dedupe_conflicts` table added to schema.sql + the migration.

Compat: behavior-preserving; the migration cleanly merges reconcilable duplicates and leaves genuinely-ambiguous ones intact-and-recorded (no silent split, no data loss). New tests in `otpPhoneDedupMigration.test.js` (mergeable full-merge; unmergeable both-profiles / both-stripe / both-prefs cross-FK-consistency; SQLite/Postgres body parity), verified red by reintroducing the split.

## Round 26 — durable map (ordering), abort-proofing, all two-owner tables + by-construction guard (see PORTFOLIO_AUDIT.md §5z)

- **[HIGH #1] The repair survives 137's phone-null.** 138 identified duplicates by primary_phone, which 137 nulls first → the repair was a silent no-op. 137/0141 now capture the dup→canonical identity into a durable `phone_dedupe_map` BEFORE the null; 138/0142 repair from it (+ live-capture fallback + re-apply the phone fix so a stamped DB is repaired end-to-end).
- **[HIGH #2] The migration never aborts on a legacy unique collision.** `saved_grants` has a partial unique `(user_id, opportunity_id) WHERE profile_id IS NULL`; a blind mergeable-dup UPDATE hit `UNIQUE constraint failed` and aborted mid-run (deploy outage). Now redundant dup rows are COLLAPSED (deleted) first for both saved_grants uniques and the user_organizations PK; all other moved tables audited (global uniques can't collide).
- **[HIGH #3] Every two-owner-FK table is handled (no split).** user_sessions + hamilton_* carry user_id AND profile_id; moving the profile but not these left them split. For a mergeable dup, ALL 20 user_id+profile_id tables (+ service_purchases' stripe FK) are MOVED with the profile, EXCEPT security-sensitive session/authorization/payment state (user_sessions, hamilton_authorizations, hamilton_saved_sessions, hamilton_payment_authorizations, hamilton_attestation_authorizations) which is REVOKED (deleted), never transferred.
- **By-construction guard:** a post-migration test sweeps every two-owner table and fails on ANY user_id/profile_id (or user_id/stripe_customer_id) mismatch — red-able, catches any table a future change misses.
- All r19–r25 preserved. 138/0142 byte-identical (parity-tested); idempotent + fresh no-op. `anya_brain_memory` dropped from the move list (its `user_id` was a comment, not a column).

Compat: behavior-preserving; the forward migration cleanly merges reconcilable phone duplicates (moving all owned data, revoking stale auth/sessions) and leaves ambiguous ones intact-and-recorded — never split, never aborting. New/updated tests in `otpPhoneDedupMigration.test.js` (ordering, collision-no-abort, revoke-vs-move, multi-duplicate invariant sweep), verified red per finding.

## Round 27 — live-schema-introspected guard + multi-dup groups + pre-map path (see PORTFOLIO_AUDIT.md §5aa)

- **[HIGH #3, foundational] The two-owner inventory is now INTROSPECTED from the full migrated schema, not schema.sql.** r26's hardcoded 20-table list missed ~18 two-owner tables created by later migrations (grant_applications, anya_match_suggestions, yana_*, hamilton_portal_credentials, payment_access_events, …) → those rows split. The test now enumerates every user_id+profile_id / user_id+stripe_customer_id table from the live schema and FAILS on any unclassified one. Full classification (38 profile + 1 stripe): 24 user-data + 5 account MOVED, 12 security session/auth/payment/credential REVOKED, 2 actor/audit (audit_logs, agent_activity_events) EXEMPT. The migration move/revoke covers all discovered tables.
- **[HIGH #1] Multi-dup groups never abort or split.** Mergeability + collision-collapse are now computed PER CANONICAL PHONE GROUP (canonical + ALL its dups), not per pair — so dup-vs-dup collisions on saved_grants / user_organizations / 1-per-user resources are collapsed to one survivor before the move (no UNIQUE-abort), and a group where 2+ members own a 1-per-user resource is wholly unmergeable (nothing moved, all recorded).
- **[HIGH #2] Pre-map (52caf99-137) stamped DBs are no longer silently skipped.** 138/0142 reconstruct a nulled dup from a durable trace (the dup profile's basic_information phone matching a canonical's phone_otp credential) and repair it; what can't be reconstructed is left operator-visible, never a silent empty no-op.
- All r19–r26 preserved. 138/0142 bodies identical except the one documented JSON-extraction dialect line (parity-tested); idempotent + fresh no-op. A generated `phoneDedupeClassification.json` is the single source of truth for the classification.

Compat: behavior-preserving; the forward migration now covers the FULL two-owner surface, handles multi-dup groups without aborting, and repairs/flags pre-map states. New/updated tests in `otpPhoneDedupMigration.test.js` (introspection guard, multi-dup no-abort, group-unmergeable, pre-map reconstruction), all verified red per finding.

## Round 28 — pre-map is conflict-only (no cross-account merge) + no renamed-away-table abort (see PORTFOLIO_AUDIT.md §5ab)

- **[CRITICAL] Removed the r27 profile-phone reconstruction that merged unrelated users.** A coincidental `basic_information.phone` match populated phone_dedupe_map, so an email-only user who typed another user's phone into their profile had their profile + credentials reassigned to the phone owner — a silent cross-account data merge. Now detect-ONLY, fail-closed: such candidates are recorded as operator conflicts (`pre-map-unverified, manual review`) and moved by NOTHING. The proven-map path (137 captures before nulling; 138 live-captures still-phoned dups) is unchanged.
- **[HIGH] The migration no longer targets renamed-away yana_* tables (PG abort).** yana_* were renamed to hamilton_* (sqlite 090 / pg 0086); r27's 0142 aborted at `UPDATE yana_runs` in live PG. yana_* removed from move/revoke (hamilton_* successors classified), marked EXEMPT (vestigial). Postgres 0142 now MOVE/REVOKEs inside a DO block that existence-guards each table (`to_regclass`) so an absent/renamed table is skipped. The test harness now applies migrations with REAL runner semantics (tolerate only idempotent errors), and a guard asserts no yana_* reference + every referenced table exists.
- All r19–r27 preserved. 138 (SQLite static) and 0142 (PG DO block) share a byte-identical preamble/collapse/phone-fix (parity-tested); move/revoke derives from the same generated classification.

Compat: behavior-preserving; the forward migration never merges on an unproven match and never aborts on a renamed-away table. New/updated tests in `otpPhoneDedupMigration.test.js` (cross-account negative, no-yana-reference + referenced-tables-exist, pre-map conflict-only), verified red per finding.

## Round 29 (FINAL) — safe JSON everywhere + harness shares the real runner predicate (see PORTFOLIO_AUDIT.md §5ac)

- **[HIGH] A malformed `profile_sections.data` row can no longer abort the migration.** The r28 detect-only pre-map read cast the unconstrained `TEXT` column to JSON (`ps.data::jsonb->>'phone'` / `json_extract(...)`); one legacy/corrupt row aborted the entire migration before move/revoke/phone-repair, leaving 138/0142 unstamped on every boot (deploy outage from pre-existing data). Now safe in both dialects at the only place either migration parses that column: SQLite guards with `CASE WHEN json_valid(ps.data) THEN json_extract(...) END`; Postgres uses a `pg_temp.pdedupe_json_phone(text)` extractor with `EXCEPTION WHEN others THEN RETURN NULL`. A malformed row yields NULL and is skipped.
- **[MEDIUM] The test harness now shares the real runner's idempotent-error predicate (single source of truth).** `isIdempotentAlreadyAppliedError` is exported from `backend/db/migrate.js` and imported by `applyLikeRunner`; the harness's own `'no such table'` tolerance is removed, so an absent/renamed-table statement fails the harness exactly as it fails boot (previously the live-schema guard introspected a schema a strict run would never produce, masking a yana_*-style abort). Sharing the predicate surfaced no currently-masked migration error — the full-schema build still applies cleanly.
- All r19–r28 preserved; 138/0142 remain byte-identical in the correctness-critical merge/collapse/phone-fix regions (parity-tested) and derive move/revoke from the same classification.

Compat: behavior-preserving; the forward migration never aborts on malformed profile data, and the harness can no longer mask an absent-table abort. New tests in `otpPhoneDedupMigration.test.js` (malformed-JSON no-abort; harness-throws-on-absent-table + predicate rejects `'no such table'`), both verified red per finding.

**OTP identity/verification + phone-dedup migration surface: CLOSED** — no known open finding remains across rounds 17–29.

## Not changed (recorded as findings — see PORTFOLIO_AUDIT.md §4)
- U1 Hamilton weekly-digest auto-send lacks per-recipient opt-in (consent/product decision).
- U2 Deadline SMS bypasses the TCPA consent gate (legal; needs transactional-vs-promotional classification + consent-lookup wiring).
- U3 No per-user LLM cost/rate quota on the Anya messages route.
- U4 `yanaOutreachSender` treats `undefined` adapter return as success (latent).
- U5 `GET /api/media/:id` is unauthenticated by design (safe only for public assets).
