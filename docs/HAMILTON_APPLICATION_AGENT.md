# Hamilton — Application-Completion Agent

Hamilton is the GrantFlow agent that takes over a funding opportunity once a
discovered match has reached the "ready for application" stage in the
pipeline. She links the opportunity to the right student-portal record,
drafts the application from profile + document data, detects missing
information, and either prepares a final review or, when explicitly
authorised in the reserved synthetic fixture, exercises the submit state
machine. In the current controlled beta, every real-domain final submission is
completed by the owner in the official portal.

This document is the contract for what Hamilton **will** and **will not**
do, and how to extend her safely.

## What Hamilton does

1. **Connects funding sources to portals.** When a discovered opportunity
   is added to the pipeline for a student profile, Hamilton classifies it
   into one of the canonical portal types
   (`financial_aid`, `scholarship`, `admissions`, `student_account`,
   `bursar`, `department`, `graduate_school`, `program_specific`,
   `external_application`, `manual_or_offline`) and stores the linkage
   in `application_portal_links` with a confidence score and a
   human-readable list of reasons.
2. **Drafts the application.** Hamilton loads the student profile (sections,
   documents, household data, school/program data) and runs the matching
   portal adapter to (a) inspect requirements, (b) fill known fields,
   (c) detect missing fields and documents, and (d) propose a next-action
   plan.
3. **Tracks progress.** Each draft lives in `application_tasks` with a
   complete event audit log in `application_task_events` and a
   structured list of missing items in `application_missing_info`.
4. **Notifies the user and admins.** When Hamilton needs human action she
   creates a persistent notification (`hamilton_missing_info`,
   `hamilton_login_required`, `hamilton_document_required`,
   `hamilton_review_required`, `hamilton_application_ready`,
   `hamilton_application_submitted`, `hamilton_application_blocked`,
   `hamilton_application_failed`). Logged-in users see a toast immediately
   via the `HamiltonToastBridge`; offline users see them in the
   `NotificationBell` on next login.
5. **Records telemetry.** Each cycle writes a row to `hamilton_runs` so the
   agent telemetry aggregator can chart Hamilton's activity alongside Anya,
   Sam, John, and Robert.

## What Hamilton will not do

Hamilton **never**:

- invents answers to required questions (missing info is recorded and
  surfaced — never fabricated);
- bypasses CAPTCHAs, 2FA, SSO security, paywalls, ToS gates, manual
  signatures, legal attestations, or final-submission consent boxes;
- logs into a school portal on behalf of the student — institutional
  portals always require either a stored credential reference (no plain
  passwords are ever stored) or a manual user-initiated login;
- launches a server browser or performs final submission on a real portal
  domain during controlled beta. Saved submit intent, environment flags,
  provider metadata, and host allow-lists do not expand this boundary;
- treats login, 2FA, CAPTCHA, a signature, an attestation, an owner approval, or
  portal confirmation as bypassable. The owner completes those steps directly
  in the official portal.

When Hamilton reaches a required human boundary, it stops in
`waiting_for_user`, `waiting_for_admin`, `blocked_login_required`,
`blocked_missing_info`, `blocked_2fa`, `blocked_captcha`, or
`blocked_terms_or_policy` and emits the matching notification.

## Database surface

Migrations: `backend/db/migrations/085_hamilton_student_portals_and_application_tasks.sql`
(SQLite) and `backend/db/postgres/migrations/0081_hamilton_student_portals_and_application_tasks.sql`
(Postgres). Both are idempotent and update `backend/db/schema.sql`.

Tables:

| Table | Purpose |
| --- | --- |
| `student_portals` | Canonical portal record per `(profile_id, school_normalized, portal_type)`. |
| `application_portal_links` | Links an opportunity (or grant) to a portal with confidence + reasons. |
| `application_tasks` | One row per Hamilton run-through of a single application. |
| `application_task_events` | Append-only audit log for each task. |
| `application_missing_info` | Missing fields / documents / logins / consents Hamilton detected. |
| `hamilton_runs` | Per-cycle telemetry row. |
| `hamilton_manual_submission_receipts` | Append-only task/profile binding for a genuine owner-uploaded portal confirmation. |

All tables enforce profile scoping: every read is filtered by
`profile_id`, every write requires it.

## How portal linking works

`backend/services/hamilton/studentFundingPortalLinker.js`
exposes `classifyFundingPortal({ profile, opportunity, ... })` and
`linkOpportunityToPortal(db, ...)`. The classifier is **explainable**:

1. It collects the student's school list from
   `university_applications` and the profile root.
2. It scores candidate portal types using:
   - `exact_school_name_match` (boosted toward whichever portal type the
     opportunity text already implies — FAFSA stays in financial aid),
   - `knownSchools_match` (lookup against
     `backend/services/crawlers/data/knownSchools.js`),
   - `profile_school_committed` (the student picked this school as
     their target),
   - `source_url_host_match_school`,
   - `opportunity_title_keyword_match` and
     `opportunity_body_keyword_match`,
   - `crawler_school_metadata`,
   - `scholarship_category_match`,
   - `application_url_evidence`,
   - `profile_program_or_major_match`.
3. It picks the highest-scoring type. If no signal fires, the result is
   `manual_or_offline` with `requires_admin_review = true`. Mission rule:
   **directory-style and unknown opportunities must always survive
   filtering** — Hamilton never silently drops them; she requests human
   review.
4. Confidence is the sum of triggered weights, clamped to `[0, 1]`.
5. Login / admin / can-Hamilton flags are derived from the winning type:
   institutional aid always sets `requires_user_login = true`;
   confidence below `0.35` sets `requires_admin_review = true`;
   only `external_application`, `admissions`, and `scholarship` allow
   `can_hamilton_attempt = true` — and only when the user-login flag is
   off and confidence ≥ `0.4`.

## Portal adapters

Adapters live in `backend/services/portalAdapters/`:

| File | Handles |
| --- | --- |
| `manualPortalAdapter.js` | `manual_or_offline` |
| `externalApplicationAdapter.js` | `external_application` |
| `universityFinancialAidAdapter.js` | `financial_aid`, `student_account`, `bursar` |
| `scholarshipPortalAdapter.js` | `scholarship`, `admissions`, `department`, `program_specific` |

Each adapter implements:

```js
{
  name,
  portalTypes,
  canHandle(portalLink, opportunity, profile),
  inspectRequirements(ctx),
  prepareApplication(ctx),
  fillApplication(ctx),
  submitApplication(ctx), // only fires when ctx.options.allowSubmit
  getMissingInfo(ctx),
  getHumanReadableStatus(ctx),
}
```

`portalAdapterRegistry.js` resolves the right adapter for a given
`(portalLink, opportunity, profile)` triple, falling back to the
manual adapter if nothing matches.

### Adding a new adapter

1. Drop a new file in `backend/services/portalAdapters/` and export an
   object that satisfies the adapter contract above.
2. Use `detectMissingProfileFields` and `detectMissingDocuments` from
   `portalAdapterTypes.js` to keep missing-info detection consistent.
3. Register the adapter in `portalAdapterRegistry.js` **before** the
   manual fallback.
4. If the adapter requires a portal type that is not yet in the
   `student_portals.portal_type` enum, add it to:
   - `backend/services/hamilton/studentPortalStore.js` `PORTAL_TYPES`
   - the SQLite + Postgres migrations
   - `backend/db/schema.sql`
   - the frontend `PORTAL_TYPE_LABELS` in `src/api/hamilton.js`
5. Add a unit test in `tests/unit/` that exercises:
   - `inspectRequirements` returns `READY` when the profile is complete
   - `inspectRequirements` returns `BLOCKED_MISSING` when a required
     field is absent
   - `submitApplication` refuses when `options.allowSubmit !== true`

## Missing info alerts (notifications + toasts)

Source of truth: `notifications` table (migration 049). Hamilton writes
rows there via `backend/services/hamilton/hamiltonNotifications.js`.

Frontend:

- `src/components/notifications/NotificationBell.jsx` — pre-existing
  bell. Hamilton types `hamilton_*` show alongside Anya/Sam/Robert/John alerts.
- `src/components/hamilton/HamiltonToastBridge.jsx` — polls
  `/api/notifications` every few seconds and surfaces unseen `hamilton_*`
  notifications as toasts (`showInfoToast`, `showWarningToast`,
  `showErrorToast`, `showSuccessToast`). Mounted once in `src/App.jsx`.
- `src/components/hamilton/HamiltonTaskBadge.jsx` — compact pipeline badge with
  Hamilton status + "Let Hamilton help / Continue / Review" buttons.
- `src/components/hamilton/HamiltonTaskDrawer.jsx` — full task panel with
  audit timeline, missing-info form, real-portal handoff, and owner-attested
  receipt retention.
- `src/components/hamilton/HamiltonPortalsPanel.jsx` — surfaces portal
  connections + funding-link explanations inside `StudentPortalsCard`.

Toast timeout is **never** the source of truth. The persistent row in
`notifications` always survives until the user marks it read.

## Profile scoping

Every Hamilton entry point is scoped:

- API: `backend/routes/studentPortals.js` and
  `backend/routes/applicationTasks.js` use `requireAuthenticatedUser` +
  `userMayAccessProfile` (or `getAccessibleProfileIds`) so a user can
  only read/write data on profiles they own (or admin override).
- Service: `runHamiltonCycle` rejects with `403 profile mismatch` if the
  caller's `profileId` does not match the task's `profile_id`.
- Store: `studentPortalStore.js`, `applicationTaskStore.js`, and
  `studentFundingPortalLinker.js` all require a `profileId` and never
  emit rows from a different profile.
- Tests: `tests/unit/hamilton-funding-portal-linker.test.mjs` and
  `tests/unit/hamilton-application-agent.test.mjs` include the
  "no profile bleed" cases.

## Browser automation

Disabled by default. Set `HAMILTON_ENABLE_BROWSER_AUTOMATION=true` to
opt in. The flag is read inside `hamiltonApplicationAgent.js`
(`isBrowserAutomationEnabled()`) and is passed to adapters via
`ctx.options.browserAutomation`. The current adapters never trigger
real browser automation — they call `applyEngine.js` for drafting and
defer all interactive steps to the user. Controlled-beta policy also rejects
real-domain browser launch even when flags or allow-lists are present. The only
executable browser path is the reserved synthetic fixture; changing that
boundary requires a separately reviewed release, not configuration alone.

## Manual submission evidence

For a real portal, Hamilton's handoff ends before login/2FA/signature/
attestation/final Submit. After the owner completes those steps in their own
browser, the task drawer accepts a genuine PDF, PNG, or JPEG portal
confirmation (maximum 10 MiB) together with the owner's explicit attestation.
The API requires an idempotency key and derives the real HTTPS portal origin
from the server-recorded task.

Only a valid, active `hamilton_manual_submission_receipts` binding can promote
the canonical submission proof. A confirmation-like document by itself cannot.
The resulting label is **“Externally submitted — owner-attested portal
confirmation on file.”** Its authority is `owner_attestation`, with
`independently_verified=false`; it is not a funder API verification, an award,
or proof of eligibility. A legacy `submitted` row that lacks proof may be
reconciled through this same explicit owner flow.

Revocation preserves the binding and bytes as append-only audit evidence while
removing proof authority and returning the task to
`submission_verification_required`. Active and revoked receipt documents remain
profile-scoped and cannot be edited or deleted through the document API. Their
authenticated download response uses `private, no-store`, `Pragma: no-cache`,
and `X-Content-Type-Options: nosniff`; document JSON never serializes
`file_bytes`.

The schema change is additive in SQLite migration 165 and Postgres migration
0170. A safe rollback reverts the application readers/writers while retaining
the table and immutable audit evidence. There is intentionally no destructive
down-migration for submitted evidence.

## Testing with mock portals

Unit tests use in-memory `better-sqlite3` and never hit live URLs.
Run them with:

```bash
node --test tests/unit/hamilton-funding-portal-linker.test.mjs
node --test tests/unit/hamilton-application-agent.test.mjs
```

The full unit suite is invoked by:

```bash
npm run unit
```

End-to-end smoke (Playwright) tests are not yet wired for Hamilton — they
are intentionally **not** allowed to perform live institutional
logins. Add new fixtures under `tests/e2e/` that swap the adapter
registry for a mock adapter implementing the same contract.

## Security limitations

- **No raw passwords.** `student_portals.credentials_status` only ever
  takes values from
  `unknown | needed | stored_reference | user_session_required | unavailable`.
  When credentials are required Hamilton sets
  `credentials_status = needed` and writes a `hamilton_login_required`
  notification — she never asks the user to paste a password into
  GrantFlow.
- **Audit trail.** Every Hamilton action is recorded in
  `application_task_events` (`event_type`, `actor_user_id`,
  `actor_role`, `message`, `payload_json`, `created_at`) and reflected
  in `hamilton_runs` (`fields_filled`, `missing_info_detected`,
  `submissions_completed`, `error`).
- **Rate limits.** API endpoints in `backend/routes/applicationTasks.js`
  apply the existing `express-rate-limit` middleware so a single user
  cannot trigger Hamilton cycles in a tight loop.

## Manual verification checklist

1. Open the profile page for a student with a university committed
   (e.g. MTSU). The `StudentPortalsCard` should render the
   `HamiltonPortalsPanel` (initially empty).
2. Discover or insert a funding opportunity tied to that university.
3. Move the grant into the pipeline. Confirm the `GrantCard` shows the
   Hamilton badge with "Let Hamilton help".
4. Click "Let Hamilton help". Hamilton should either draft the application
   (badge changes to `Draft complete` / `Review`) or block on missing
   info / login (badge shows the reason and the bell shows a
   `hamilton_*` notification).
5. Open the drawer, supply any missing fields, and click "Continue".
   Hamilton should advance the task and append events.
6. Confirm `hamilton_runs` has at least one row for the cycle and the
   audit log in `application_task_events` matches.
7. As a different user (or different profile), confirm the data is
   not visible — profile scoping is enforced at the API layer.
8. For a real portal, confirm GrantFlow opens a visible manual handoff and does
   not launch a server browser or cross login/2FA/signature/attestation gates.
9. Complete the final steps yourself, retain the genuine receipt, and confirm
   the task says owner-attested and not independently verified by a funder API.
