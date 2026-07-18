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

## Not changed (recorded as findings — see PORTFOLIO_AUDIT.md §4)
- U1 Hamilton weekly-digest auto-send lacks per-recipient opt-in (consent/product decision).
- U2 Deadline SMS bypasses the TCPA consent gate (legal; needs transactional-vs-promotional classification + consent-lookup wiring).
- U3 No per-user LLM cost/rate quota on the Anya messages route.
- U4 `yanaOutreachSender` treats `undefined` adapter return as success (latent).
- U5 `GET /api/media/:id` is unauthenticated by design (safe only for public assets).
