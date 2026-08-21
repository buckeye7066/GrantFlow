# Hamilton Automation Agent — Autopilot

> **Hamilton** is GrantFlow's automation agent for grant, scholarship, and
> institutional-aid applications. She is described in-product as "an
> MBA-level grant writer with 20 years of experience securing grants,
> scholarships, institutional aid, foundation funding, government
> funding, school aid, and private assistance."
>
> When the user authorizes automation (including submit), Hamilton may open
> public HTTPS portal sites in a server browser, fill forms, save drafts, and
> click Submit. She still pauses for login, CAPTCHA, 2FA, payment, and
> signatures that only a human can complete. Private / loopback / metadata
> addresses remain blocked (SSRF). Set `HAMILTON_ENABLE_BROWSER_AUTOMATION=false`
> or `HAMILTON_ALLOW_AUTOSUBMIT=false` to force packet-only / draft-only mode.

## Autopilot in one paragraph

When the user clicks **Automate with Hamilton**, the
`HamiltonAutopilotAuthorization` modal records the standing authorization
(`POST /api/hamilton/automation/authorize`), runs preflight against the
selected sources (`POST /api/hamilton/automation/preflight`) so any
missing field/document/URL is fixed before launch, and then starts
the unattended run (`POST /api/hamilton/automation/start-autopilot`).
With submit authorized, Autopilot drives the public HTTPS portal and
submits when the form is complete; otherwise she prepares a packet and
stops for a visible handoff. Login / CAPTCHA / 2FA / payment / signature
remain hard stops.

## What changed

Users can now multi-select any number of funding sources from any
pipeline stage — Discovered, Saved, Interested, Gathering Documents,
Drafting, Ready to Submit, Submitted, Follow-up, Awarded, Declined,
Archived — and click a single bulk action:

> **Automate selected with Hamilton**

For every selected source Hamilton decides the correct **completion
pathway** and automates the safe preparation steps. It pauses and persists its
state at missing information or any human/security boundary (login, 2FA,
CAPTCHA, payment, signature, attestation, terms, or ambiguous mapping). Real
portal completion does not resume server-side in controlled beta; the owner
uses the official portal.

## Eight completion pathways

`backend/services/hamilton/hamiltonAutomationClassifier.js` is a pure,
deterministic function that maps a funding source to one of:

| `automation_type` | Hamilton's behaviour                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `portal`          | Prepare the scoped packet and official portal handoff. Controlled beta never launches Playwright on a real domain; only the reserved synthetic fixture exercises browser automation. |
| `pdf_docx`        | Generate a complete DOCX + PDF packet from the profile, save it under the profile's Documents, hand it to the user for review and signing.       |
| `mail`            | Same as `pdf_docx` plus structured **mailing instructions** (funder address, postmark deadline, certified-mail recommendation, envelope subject). |
| `fax`             | Generate the packet plus structured fax instructions (number, cover-sheet content, deadline).                                                     |
| `email`           | Generate the packet plus structured email instructions (recipient, subject, attachments, deadline). Hamilton never sends the email itself.            |
| `no_application`  | Directory or awareness resource — log the link, skip generation.                                                                                  |
| `auto_profile`    | FAFSA / institutional / nomination-only / automatic-match — log the action and ask the user to confirm their FAFSA / institutional record.       |
| `unknown`         | Hamilton could not classify; status `blocked` with a clear reason, no fabrication.                                                                    |

Classification rules in priority order:

1. Explicit `application_mode` / `application_method` / `application_format` metadata.
2. Auto-profile signals (`result_kind` == `auto_match` / `institutional_match` / `nomination`, FAFSA/nomination/institutional-aid text patterns).
3. No-application signals (`result_kind` == `directory` / `awareness` / `reference`).
4. Channel-specific submission signals (apply_email, apply_fax, mailing_address, "submit by email" text).
5. URL-based signals (`.pdf`/`.docx`/`.rtf` → `pdf_docx`; `https://…` → `portal`).
6. Last-resort signals (mailing_address present → `mail`; otherwise `unknown`).

## Architecture

```
src/components/pipeline/GrantCard.jsx          ── per-card checkbox + "Automate with Hamilton"
src/components/hamilton/HamiltonSelectionContext.jsx   ── multi-select state (per-Pipeline scope)
src/components/hamilton/HamiltonSelectionToolbar.jsx   ── floating bulk action bar
src/components/hamilton/HamiltonAutomationQueue.jsx    ── live queue panel for the active profile
src/components/hamilton/HamiltonTaskDrawer.jsx         ── per-task review + output documents +
                                                 submission instructions + channel "mark"
                                                 buttons (mailed / emailed / faxed)

POST /api/hamilton/automation/authorize            ── Phase A: persist standing authorization
GET  /api/hamilton/automation/authorizations       ── list / lookup active authorizations
POST /api/hamilton/automation/authorizations/:id/revoke
POST /api/hamilton/automation/preflight            ── Phase B: pre-launch checks
POST /api/hamilton/automation/start-autopilot      ── Phase C: launch unattended Autopilot
POST /api/hamilton/automation/tasks/:taskId/resolve-blocker  ── Phase D: continue after blocker
GET  /api/hamilton/automation/providers            ── Phase F: portal provider catalogue
GET  /api/hamilton/automation/tasks/:taskId/autopilot-runs   ── per-task autopilot run history

POST /api/hamilton/automation/start                ── legacy bulk entry (still works, no auth gate)
GET  /api/hamilton/automation/tasks                ── caller-scoped automation queue
GET  /api/hamilton/automation/tasks/:taskId        ── one task with events + missing info
POST /api/hamilton/automation/tasks/:taskId/regenerate
POST /api/hamilton/automation/tasks/:taskId/mark-mailed / mark-emailed / mark-faxed
POST /api/hamilton/automation/tasks/:taskId/approve
POST /api/hamilton/automation/tasks/:taskId/retry

backend/services/hamilton/hamiltonAutomationClassifier.js
backend/services/hamilton/hamiltonApplicationPacketGenerator.js
backend/services/hamilton/hamiltonAutomationOrchestrator.js
backend/services/hamilton/hamiltonAuthorizationStore.js   ── Phase E: standing authorization model
backend/services/hamilton/hamiltonPreflight.js            ── Phase B: preflight checks
backend/services/hamilton/hamiltonAutopilotEngine.js      ── Phase C: unattended Playwright engine
backend/services/hamilton/hamiltonPortalProviders.js      ── Phase F: provider catalogue
backend/routes/hamiltonAutomation.js
```

The orchestrator reuses the existing `application_tasks`,
`application_task_events`, and `application_missing_info` tables. We
extended `application_tasks` (migration **087** SQLite / **0083**
Postgres) with:

- `automation_type`, `selected_from_stage`, `current_pipeline_stage`
- `agent_persona_version` (defaults to `hamilton-mba-2026`)
- `portal_url`, `application_url`, `university_application_id`
- `output_document_id`, `output_pdf_document_id`, `output_docx_document_id`
- `mailing_instructions_json`, `audit_summary_json`
- `allow_auto_submit`, `started_at`, `completed_at`

The runtime ensure-schema (`applicationTaskStore.ensureApplicationTaskSchema`)
upgrades pre-migration databases in place via `ALTER TABLE ADD COLUMN`.

## Standing authorization (Phase E)

The user grants Autopilot authority once on the launch screen. The
authorization is recorded in `hamilton_authorizations` (migration **088**
SQLite / **0084** Postgres) with the exact text shown on screen,
the version (`hamilton-autopilot-v1`), the option payload, the IP
address and user agent, and the timestamp. Authorization types:

- `complete_forms`
- `upload_documents`
- `generate_narratives`
- `save_drafts`
- `submit_applications`
- `use_saved_session`
- `use_saved_credentials_reference`
- `use_standing_attestation`

Authorizations are scoped: `profile`, `funding_source`, or `task`.
Revocation is a status transition (`revoked_at IS NOT NULL`); rows
are never deleted, so the audit trail is always complete.

## Hard blockers (Phase D)

Once Autopilot starts, Hamilton proceeds without further user action
**except** for these hard blockers, all of which raise a `blocked`
status, persist a missing-info record, and emit a notification:

- missing required profile field or document (preflight blocker)
- login / SSO required and `use_saved_session` not authorized
- 2FA / OTP required
- CAPTCHA detected
- payment / fee step
- digital or wet signature
- legal attestation outside the standing-attestation allow-list
- portal validation error after fill (low confidence in correction)
- portal anti-bot block / TOS forbids automation
- ambiguous field mapping below confidence threshold

Hamilton never invents missing info, bypasses a security control, types an
FSA-ID or other federal credential, or fakes a signature. In controlled beta,
the listed authorization records are retained as scoped intent and audit data;
they do not authorize browser launch or final submission on a real domain.
Submit-path automation is confined to the reserved synthetic fixture.

## Provider catalogue (Phase F)

`backend/services/hamilton/hamiltonPortalProviders.js` exposes the seeded
provider catalogue plus any `hamilton_portal_providers` overrides. Each
provider record carries the new automation columns:

- `integration_modes` (any of `pilot_manual_import`,
  `browser_autopilot`, `browser_session_reuse`,
  `secure_credential_reference`, `api_integration`)
- `live_supported` / `automation_supported`
- `authentication_strategy` (e.g. `sso`, `username_password`, `fsa_id`)
- `session_reuse_supported`, `credential_reference_supported`
- `captcha_likely`, `two_factor_likely`
- `tos_notes`, `adapter_name`

The legacy `schoolPortalImportService` still supports
`pilot_manual_import`. Real-domain completion remains the manual controlled-beta
path; provider metadata cannot expand that boundary.

## Owner-attested manual portal receipts

After the owner completes a real portal submission outside GrantFlow, an exact
profile owner or DB-resolved human admin may upload a genuine PDF, PNG, or JPEG
confirmation (maximum 10 MiB) through:

`POST /api/hamilton/automation/tasks/:taskId/manual-submission-receipt`

The request requires the current attestation version and an idempotency key.
The backend derives the HTTPS portal origin from the task; it never accepts a
caller-supplied proof URL. The immutable bytes/hash live in `documents`, while
`hamilton_manual_submission_receipts` binds the document to the exact task and
profile. Service tokens, legacy profile tokens, shared collaborators, and
reserved synthetic identities cannot make this human attestation.

The canonical UI label is **“Externally submitted — owner-attested portal
confirmation on file.”** This means GrantFlow has an authorized owner's
attestation plus a retained artifact. It is explicitly **not independently
verified by a funder API** and must never be described as an award or as
funder-confirmed eligibility.

Revocation is append-only. It removes the receipt's proof authority and returns
the task to `submission_verification_required`, but retains the bound document
for audit. Active and revoked receipt documents remain owner-scoped,
non-editable, non-deletable, and downloadable only with private/no-store cache
headers. SQLite migration `165_hamilton_manual_submission_receipts.mjs` and
Postgres migration `0170_hamilton_manual_submission_receipts.sql` are additive;
rollback means reverting application code while retaining the audit table and
evidence, never a destructive down-migration.

## Persona

Every generated packet (and every audit event) is stamped with the
persona version `hamilton-mba-2026`. The DOCX/PDF cover page identifies
Hamilton as the writer of record so reviewers know what they're reading.

## Testing

`tests/unit/hamilton-automation.test.mjs` covers:

- All eight classification pathways (portal / pdf_docx / mail / fax / email / no_application / auto_profile / unknown)
- Packet content: missing-info detection, no-fabrication, mail-instruction completeness
- DOCX rendering and persistence into `documents` + `profile_documents`
- Orchestrator: every pathway, profile scoping, audit events, multi-source dispatch, **stage-agnostic selection** (every stage from Discovered through Awarded creates a task)
- Re-selecting the same source from a different stage upserts the same task instead of creating a duplicate

Run with:

```
node --test tests/unit/hamilton-automation.test.mjs
```

## Manual verification

1. Open the Pipeline page for a profile with at least one funding source.
2. Tick the checkbox on two or more cards across different stages.
3. Click **Automate selected with Hamilton** in the bottom toolbar.
4. The Hamilton automation queue panel appears below the kanban; each task shows the resolved `automation_type` and current status.
5. Click **View** on a `pdf_docx` / `mail` / `fax` / `email` task — the drawer shows the generated DOCX + PDF download links, the structured submission instructions, and the **Record mailed / emailed / faxed** action button when the task is at the corresponding ready-to-submit status.
6. Click **Regenerate** to re-run the packet generator after editing the profile.
7. Click **Record mailed** (etc.) to record the dispatch. This remains
   `submission_verification_required` until genuine external confirmation is
   retained; a click alone is not proof of receipt by the funder.
8. For a real portal, complete the final steps in the official portal, then use
   **I submitted this myself** to retain the genuine confirmation. Confirm the
   UI identifies it as owner-attested and not independently funder-verified.

## Limitations / TODOs

- Controlled beta deliberately refuses real-domain server-browser launches.
  The reserved synthetic fixture proves the state machine, not permission or
  reliability on a live funder portal.
- PDF rendering uses Playwright's `page.pdf()`. When chromium is not
  installed (e.g. CI without `npx playwright install`), Hamilton falls back
  to DOCX-only and skips the PDF row.
- `mark-mailed/emailed/faxed` is a user-confirmed transition; we do not
  watch the user's mailbox or send fax/email on their behalf.

## Hard-Stop Resolver layer (Phase Addendum)

Hamilton never gives up at the first portal hiccup. Every detected blocker
flows through the **Hard-Stop Resolver**, which classifies the blocker
into one of seventeen canonical categories and tries an approved
resolution strategy *before* asking the user.

| Category | Resolver strategy | Lawful guard |
| --- | --- | --- |
| missing_required_information | reuse `hamilton_resolved_fields`; else ask once and persist | never invent values |
| missing_required_document | reuse profile document; else generate (cover letter / packet); else request | never fabricate signatures or third-party docs |
| login_required | reuse saved Playwright storage state when authorized | no plaintext credentials |
| sso_required | reuse saved SSO session | never bypass the IdP |
| two_factor_required | reuse trusted-device session | never intercept codes |
| captcha_required | reuse session that does not trigger CAPTCHA | never solve / spoof |
| payment_required | stop for the owner on a real portal; authorization records remain audit-only in controlled beta | never charge a real portal unattended; no raw card data |
| wet_signature_required | always degrade to printable signature packet | never forge |
| digital_signature_required | fill everything else, then escalate for the applicant to e-sign | never e-sign on the user's behalf |
| legal_attestation_required | stop for the owner on a real portal | never attest for the owner |
| portal_terms_block | switch to `policy.fallback_path` (pdf_docx / mail / fax / email / manual / api) | always respect ToS |
| portal_anti_bot_block | stop and switch to the manual handoff/packet | no session replay, stealth, or fingerprint evasion on real domains |
| ambiguous_required_field | reuse cached resolved field, otherwise ask once | never guess |
| final_review_screen | reserved fixture may proceed; a real portal stops for owner review and final submission | no configuration override |
| deadline_expired | mark task blocked + suggest related opportunities | n/a |
| unknown_application_method | generate funder contact packet | n/a |
| portal_unreachable | mark task blocked with a human-readable "site unreachable / link may be dead" alert (DNS, connection, navigation-timeout failures) | never surface raw Playwright errors to users |

### Persistence

| Table | Purpose |
| --- | --- |
| `hamilton_blockers` | every detected blocker, with type, source, text, audit timestamps |
| `hamilton_blocker_resolutions` | every attempted resolution: strategy, outcome, detail |
| `hamilton_saved_sessions` | references to authenticated Playwright storage states |
| `hamilton_payment_authorizations` | pre-authorized payment categories + tokenised method ref + spent counter |
| `hamilton_attestation_authorizations` | per-profile standing attestation patterns |
| `hamilton_portal_policies` | per-host `automation_allowed` / `scraping_allowed` / `api_available` / `manual_only` |
| `hamilton_resolved_fields` | "resolve once, reuse forever" cache |

### Modules

- `backend/services/hamilton/hamiltonBlockerClassifier.js`
- `backend/services/hamilton/hamiltonHardStopResolver.js`
- `backend/services/hamilton/hamiltonPreflightResolver.js`
- `backend/services/hamilton/hamiltonCredentialSessionService.js`
- `backend/services/hamilton/hamiltonPaymentAuthorizationService.js`
- `backend/services/hamilton/hamiltonESignatureService.js`
- `backend/services/hamilton/hamiltonPortalPolicyRegistry.js`
- `backend/services/hamilton/hamiltonAttestationStore.js`
- `backend/services/hamilton/hamiltonResolvedFieldStore.js`
- `backend/services/hamilton/hamiltonBlockerStore.js`

### Wiring

- `hamiltonAutomationOrchestrator.runAutopilotPathway` now wraps the engine
  call in a resolver loop. After every engine pass, the directive
  determines whether Hamilton retries with new options (saved session,
  document candidate), degrades to a lawful packet path, or surfaces a
  blocker to the user.
- `POST /api/hamilton/automation/preflight-resolve` returns the resolver-aware
  preflight + readiness readout consumed by `HamiltonAutopilotAuthorization`.
- New routes: `/payment-authorizations`, `/sessions`, `/attestations`,
  `/portal-policies`, `/resolved-fields`, `/tasks/:id/blockers`,
  `/tasks/:id/resolve-blocker-input`.
