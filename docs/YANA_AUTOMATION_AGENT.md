# Yana Automation Agent

> **Yana** is GrantFlow's automation agent for grant, scholarship, and
> institutional-aid applications. She is described in-product as "an
> MBA-level grant writer with 20 years of experience securing grants,
> scholarships, institutional aid, foundation funding, government
> funding, school aid, and private assistance."
>
> This document covers the **select-many** automation flow added on
> branch `feat/yana-automation`. It builds on the per-grant Yana flow
> documented in [`YANA_APPLICATION_AGENT.md`](./YANA_APPLICATION_AGENT.md)
> and the supervised browser-automation layer documented in the same
> file.

## What changed

Users can now multi-select any number of funding sources from any
pipeline stage — Discovered, Saved, Interested, Gathering Documents,
Drafting, Ready to Submit, Submitted, Follow-up, Awarded, Declined,
Archived — and click a single bulk action:

> **Automate selected with Yana**

For every selected source Yana decides the correct **completion
pathway** and drives the source toward completion automatically until
she encounters a hard blocker (missing info, login, 2FA, CAPTCHA,
payment, signature, attestation, terms, ambiguous mapping). When that
happens she pauses, persists what she knows, files a missing-info
record, and notifies the user/admin. After the human resolves the
block, automation resumes from the same point.

## Eight completion pathways

`backend/services/yana/yanaAutomationClassifier.js` is a pure,
deterministic function that maps a funding source to one of:

| `automation_type` | Yana's behaviour                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `portal`          | Open a supervised Playwright browser on the application URL, pause for login/2FA/CAPTCHA, fill known fields, save draft, stop at review.          |
| `pdf_docx`        | Generate a complete DOCX + PDF packet from the profile, save it under the profile's Documents, hand it to the user for review and signing.       |
| `mail`            | Same as `pdf_docx` plus structured **mailing instructions** (funder address, postmark deadline, certified-mail recommendation, envelope subject). |
| `fax`             | Generate the packet plus structured fax instructions (number, cover-sheet content, deadline).                                                     |
| `email`           | Generate the packet plus structured email instructions (recipient, subject, attachments, deadline). Yana never sends the email itself.            |
| `no_application`  | Directory or awareness resource — log the link, skip generation.                                                                                  |
| `auto_profile`    | FAFSA / institutional / nomination-only / automatic-match — log the action and ask the user to confirm their FAFSA / institutional record.       |
| `unknown`         | Yana could not classify; status `blocked` with a clear reason, no fabrication.                                                                    |

Classification rules in priority order:

1. Explicit `application_mode` / `application_method` / `application_format` metadata.
2. Auto-profile signals (`result_kind` == `auto_match` / `institutional_match` / `nomination`, FAFSA/nomination/institutional-aid text patterns).
3. No-application signals (`result_kind` == `directory` / `awareness` / `reference`).
4. Channel-specific submission signals (apply_email, apply_fax, mailing_address, "submit by email" text).
5. URL-based signals (`.pdf`/`.docx`/`.rtf` → `pdf_docx`; `https://…` → `portal`).
6. Last-resort signals (mailing_address present → `mail`; otherwise `unknown`).

## Architecture

```
src/components/pipeline/GrantCard.jsx          ── per-card checkbox + "Automate with Yana"
src/components/yana/YanaSelectionContext.jsx   ── multi-select state (per-Pipeline scope)
src/components/yana/YanaSelectionToolbar.jsx   ── floating bulk action bar
src/components/yana/YanaAutomationQueue.jsx    ── live queue panel for the active profile
src/components/yana/YanaTaskDrawer.jsx         ── per-task review + output documents +
                                                 submission instructions + channel "mark"
                                                 buttons (mailed / emailed / faxed)

POST /api/yana/automation/start                ── bulk entry point (selected_sources[])
GET  /api/yana/automation/tasks                ── caller-scoped automation queue
GET  /api/yana/automation/tasks/:taskId        ── one task with events + missing info
POST /api/yana/automation/tasks/:taskId/regenerate
POST /api/yana/automation/tasks/:taskId/mark-mailed
POST /api/yana/automation/tasks/:taskId/mark-emailed
POST /api/yana/automation/tasks/:taskId/mark-faxed
POST /api/yana/automation/tasks/:taskId/approve
POST /api/yana/automation/tasks/:taskId/retry

backend/services/yana/yanaAutomationClassifier.js
backend/services/yana/yanaApplicationPacketGenerator.js
backend/services/yana/yanaAutomationOrchestrator.js
backend/routes/yanaAutomation.js
```

The orchestrator reuses the existing `application_tasks`,
`application_task_events`, and `application_missing_info` tables. We
extended `application_tasks` (migration **087** SQLite / **0083**
Postgres) with:

- `automation_type`, `selected_from_stage`, `current_pipeline_stage`
- `agent_persona_version` (defaults to `yana-mba-2026`)
- `portal_url`, `application_url`, `university_application_id`
- `output_document_id`, `output_pdf_document_id`, `output_docx_document_id`
- `mailing_instructions_json`, `audit_summary_json`
- `allow_auto_submit`, `started_at`, `completed_at`

The runtime ensure-schema (`applicationTaskStore.ensureApplicationTaskSchema`)
upgrades pre-migration databases in place via `ALTER TABLE ADD COLUMN`.

## "Fully automated once started"

Once a task starts, Yana proceeds without further user action **except**
for these hard blockers, all of which raise a `blocked` status, persist
a missing-info record, and emit a notification:

- missing required profile field or document
- login / SSO required
- 2FA / OTP required
- CAPTCHA detected
- payment / fee step
- signature, legal attestation, or consent checkbox
- automation explicitly forbidden by the funder
- ambiguous field mapping (low classifier confidence)

Yana never invents missing info, never bypasses a security control,
never auto-submits unless **all** of the following are true:

- automation_type is `portal` and the user clicked "Approve submit"
- `YANA_ALLOW_AUTOSUBMIT=true` on the server
- the form is grounded (every required field has a profile-backed source)
- pre-submit and post-submit screenshots are captured

## Persona

Every generated packet (and every audit event) is stamped with the
persona version `yana-mba-2026`. The DOCX/PDF cover page identifies
Yana as the writer of record so reviewers know what they're reading.

## Testing

`tests/unit/yana-automation.test.mjs` covers:

- All eight classification pathways (portal / pdf_docx / mail / fax / email / no_application / auto_profile / unknown)
- Packet content: missing-info detection, no-fabrication, mail-instruction completeness
- DOCX rendering and persistence into `documents` + `profile_documents`
- Orchestrator: every pathway, profile scoping, audit events, multi-source dispatch, **stage-agnostic selection** (every stage from Discovered through Awarded creates a task)
- Re-selecting the same source from a different stage upserts the same task instead of creating a duplicate

Run with:

```
node --test tests/unit/yana-automation.test.mjs
```

## Manual verification

1. Open the Pipeline page for a profile with at least one funding source.
2. Tick the checkbox on two or more cards across different stages.
3. Click **Automate selected with Yana** in the bottom toolbar.
4. The Yana automation queue panel appears below the kanban; each task shows the resolved `automation_type` and current status.
5. Click **View** on a `pdf_docx` / `mail` / `fax` / `email` task — the drawer shows the generated DOCX + PDF download links, the structured submission instructions, and the **Mark mailed / emailed / faxed** action button when the task is at the corresponding ready-to-submit status.
6. Click **Regenerate** to re-run the packet generator after editing the profile.
7. Click **Mark mailed** (etc.) to record a manual submission; the task transitions to `submitted` and a `yana_submitted` notification is created.

## Limitations / TODOs

- The supervised browser layer (`yanaPortalAutomation.js`,
  `browserSessionService.js`, `portalFieldMapper.js`) lives on a
  separate branch and is loaded via dynamic import. When that branch
  merges, the orchestrator will pick it up automatically; until then a
  `portal`-classified source is parked at `ready_to_start` with the
  resolved URL persisted.
- PDF rendering uses Playwright's `page.pdf()`. When chromium is not
  installed (e.g. CI without `npx playwright install`), Yana falls back
  to DOCX-only and skips the PDF row.
- `mark-mailed/emailed/faxed` is a user-confirmed transition; we do not
  watch the user's mailbox or send fax/email on their behalf.
