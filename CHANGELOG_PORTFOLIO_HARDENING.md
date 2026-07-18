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

## Not changed (recorded as findings — see PORTFOLIO_AUDIT.md §4)
- U1 Hamilton weekly-digest auto-send lacks per-recipient opt-in (consent/product decision).
- U2 Deadline SMS bypasses the TCPA consent gate (legal; needs transactional-vs-promotional classification + consent-lookup wiring).
- U3 No per-user LLM cost/rate quota on the Anya messages route.
- U4 `yanaOutreachSender` treats `undefined` adapter return as success (latent).
- U5 `GET /api/media/:id` is unauthenticated by design (safe only for public assets).
