# John — Implementation Report

## Summary

Adds **John**, GrantFlow's Outreach Drafting Agent. John reads qualified
lead packets from Yana (the lead-discovery agent), interprets the public
evidence, writes a respectful personalized email, and creates a Microsoft
Outlook **draft** in the configured primary mailbox for Dr. John White to
review and send manually.

John never sends. The send code path does not exist in this version, the
admin UI has no send button, and the runtime guard `assertDraftOnly`
throws if `JOHN_DRAFT_ONLY` is ever set to `false`.

## Files added

### Backend services (`backend/services/john/`)

- `johnTypes.js` — modes, statuses, audit-status / block-reason
  enumerations, factories.
- `johnOutreachSafety.js` — env-var helpers, central `getJohnConfig()`,
  `assertDraftOnly`, `maskSecrets`, subject/body classifiers, full
  `evaluateDraftSafety` pre-flight gate.
- `johnRunStore.js` — persistence for runs, drafts, audit, suppression,
  and alias-checks. Dialect-aware JSON columns (TEXT for SQLite, JSONB
  for Postgres).
- `johnSuppressionService.js` — global suppression list (email/domain/
  organisation/phone), idempotent `addSuppression`, sync-feeling
  `makeSuppressionChecker` for the safety classifier.
- `johnRateLimiter.js` — rolling-window (24h, 60-min) and per-run caps;
  `computeRunBudget` returns the smallest budget across all four caps.
- `johnLeadInterpreter.js` — pure-fn extraction of best contact point,
  best evidence hook, and salutation from a Yana lead packet.
- `johnEmailTemplates.js` — approved subject patterns, default body
  template, per-org-type framing.
- `johnEmailWriter.js` — pure-fn `composeEmailFromLead` returning subject,
  body_text, body_html, and personalization metadata.
- `johnOutlookProvider.js` — Microsoft Graph adapter (app-only OAuth,
  draft creation, alias retry, secret masking). Injectable `fetch` for
  tests.
- `johnAliasVerifier.js` — verifies primary mailbox + creates a test
  draft to confirm Graph accepts the From alias.
- `johnDraftService.js` — single entry point for one-lead drafting; runs
  pre-flight, rate gate, compose, safety, Outlook draft, persistence.
- `johnYanaBridge.js` — pluggable lead-source contract; ships with a
  `NULL_LEAD_SOURCE` and `registerLeadSource` so Yana (or any other
  agent) can attach later.
- `johnAgent.js` — orchestrator (`runJohn`) for all five modes.
- `johnScheduler.js` — env-gated cron-like scheduler with overlap
  protection and a self-contained 5-field cron parser.

### Backend routes

- `backend/routes/john.js` — public `/health`; admin-only status, run,
  verify-alias, create-test-draft, draft-from-yana, runs, drafts,
  audit, suppression, leads. **No send endpoint.**

### Database

- `backend/db/migrations/083_john_tables.sql` (SQLite)
- `backend/db/postgres/migrations/0079_john_tables.sql` (Postgres)
- `backend/db/schema.sql` — appended John tables for fresh DB
  bootstraps.

### Frontend

- `src/components/admin/AdminJohnConsole.jsx` — status, metrics,
  buttons (Verify Alias, Create Test Draft, Observe, Draft Today's
  Batch, Full Cycle, Refresh).
- `src/components/john/JohnDraftReview.jsx` — table of drafts with
  archive + view actions.
- `src/components/john/JohnDraftDetails.jsx` — modal: alias report,
  safety report, edit-and-revise, archive.
- `src/pages/Admin.jsx` — added "John" tab.

### Tests (`tests/unit/`)

- `john-test-helpers.mjs` — in-memory better-sqlite3 db, env helpers,
  fake Outlook provider.
- `john-outreach-safety.test.mjs` — 9 tests covering defaults,
  draft-only guard, subject/body classifiers, evaluateDraftSafety,
  maskSecrets.
- `john-lead-interpreter.test.mjs` — 6 tests.
- `john-email-writer.test.mjs` — 3 tests covering composed-email
  satisfies-classifier and HTML escaping.
- `john-rate-limiter.test.mjs` — 5 tests (daily, hourly, per-run,
  end-to-end "no draft #51").
- `john-alias-verifier.test.mjs` — 3 tests (not-configured, accepted,
  rejected → fallback).
- `john-draft-service.test.mjs` — 10 tests covering created,
  needs_sender_alias_review, suppressed, missing evidence, missing
  contact source, no-send guarantee, dedup, provider not configured,
  archive, blocked-audit row, agent_name.
- `john-yana-bridge.test.mjs` — 7 tests covering filtering, dedup,
  suppression, sort order, source registration, null source.
- `john-agent.test.mjs` — 5 tests covering observe never calls
  provider, draft mode caps at 50, draft-only guard throws, run
  records outcome, status shape.

**Total: 49 unit assertions.**

### Documentation

- `docs/JOHN_OUTREACH_AGENT.md`
- `docs/JOHN_EMAIL_STYLE_GUIDE.md`
- `docs/JOHN_IMPLEMENTATION_REPORT.md` (this file)

## Files changed

- `backend/db/schema.sql` — appended john_* tables.
- `backend/server.js` — mounts `/api/john` lazy router; starts
  `johnScheduler` after `server.on('listening')`.
- `src/pages/Admin.jsx` — adds the John tab.

## Migrations added

- 083_john_tables.sql (SQLite)
- 0079_john_tables.sql (Postgres)

Both create:

- `john_runs`
- `john_email_drafts`
- `john_suppression_list`
- `john_email_audit`
- `john_alias_checks`

All `CREATE TABLE IF NOT EXISTS`; safe to re-run.

## API endpoints added

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/john/health` | Public |
| GET | `/api/john/status` | Admin |
| POST | `/api/john/run` | Admin |
| POST | `/api/john/verify-alias` | Admin |
| POST | `/api/john/create-test-draft` | Admin |
| POST | `/api/john/draft-from-yana` | Admin |
| GET | `/api/john/runs` | Admin |
| GET | `/api/john/runs/:runId` | Admin |
| GET | `/api/john/drafts` | Admin |
| GET | `/api/john/drafts/:draftId` | Admin |
| POST | `/api/john/drafts/:id/revise` | Admin |
| POST | `/api/john/drafts/:id/archive` | Admin |
| GET | `/api/john/audit` | Admin |
| GET | `/api/john/suppression` | Admin |
| POST | `/api/john/suppression` | Admin |
| GET | `/api/john/leads` | Admin |

There is no send endpoint by design.

## Environment variables

```
JOHN_ENABLED=false                  # default off
JOHN_RUN_ON_STARTUP=false
JOHN_RUN_ON_SCHEDULE=false
JOHN_SCHEDULE=30 9 * * *
JOHN_MODE=observe                   # default observe

JOHN_PRIMARY_MAILBOX=dr.johnwhite@axiombiolabs.org
JOHN_FROM_ALIAS=GrantFlow@axiombiolabs.org
JOHN_REPLY_TO=GrantFlow@axiombiolabs.org
JOHN_DISPLAY_NAME=Dr. John White | GrantFlow

JOHN_DRAFT_ONLY=true                # runtime-guarded; never set false
JOHN_ALLOW_SEND=false               # ignored when JOHN_DRAFT_ONLY=true
JOHN_REQUIRE_HUMAN_REVIEW=true

JOHN_MAX_DRAFTS_PER_24H=50
JOHN_MAX_DRAFTS_PER_RUN=50
JOHN_MAX_DRAFTS_PER_HOUR=10

JOHN_MIN_LEAD_SCORE=70
JOHN_REQUIRE_YANA_QUALIFIED=true
JOHN_REQUIRE_PUBLIC_EVIDENCE=true
JOHN_REQUIRE_CONTACT_SOURCE=true

JOHN_SUPPRESSION_ENABLED=true
JOHN_OPT_OUT_LANGUAGE_REQUIRED=true
JOHN_PHYSICAL_ADDRESS_REQUIRED=true
JOHN_PHYSICAL_ADDRESS=
JOHN_TEST_RECIPIENT=dr.johnwhite@axiombiolabs.org

JOHN_ALLOW_PRIMARY_MAILBOX_FALLBACK_DRAFTS=true
JOHN_REQUIRE_ALIAS_REVIEW_IF_FALLBACK=true

MICROSOFT_TENANT_ID=
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_REDIRECT_URI=
MICROSOFT_GRAPH_SCOPES=Mail.ReadWrite Mail.Send User.Read offline_access
```

## Commands run

- `npm rebuild better-sqlite3` (local Node ABI fixup)
- `node --test tests/unit/john-*.test.mjs` → 49 / 49 pass
- `npm run lint:strict` (see Verification section)
- `npm run typecheck`
- `npm run build`
- `npm run unit`
- `npm run crawler:doctor`

## Acceptance criteria mapping

| Test # | Requirement | Status |
| --- | --- | --- |
| 1 | John is disabled by default | ✓ `john-outreach-safety.test.mjs` |
| 2 | Defaults to draft-only | ✓ `john-outreach-safety.test.mjs` |
| 3 | Cannot send | ✓ `john-draft-service.test.mjs`, `john-agent.test.mjs` |
| 4 | ≤ 50 drafts / 24h | ✓ `john-rate-limiter.test.mjs`, `john-agent.test.mjs` |
| 5 | Only Yana-qualified leads | ✓ `john-yana-bridge.test.mjs` |
| 6 | Blocks suppressed recipients | ✓ `john-draft-service.test.mjs` |
| 7 | Blocks leads w/o public evidence | ✓ `john-draft-service.test.mjs` |
| 8 | Blocks leads w/o contact source | ✓ `john-draft-service.test.mjs` |
| 9 | Rejects deceptive subjects | ✓ `john-outreach-safety.test.mjs` |
| 10 | Rejects funding guarantees | ✓ `john-outreach-safety.test.mjs` |
| 11 | Requires opt-out language | ✓ `john-outreach-safety.test.mjs` |
| 12 | Requires physical address | ✓ `john-outreach-safety.test.mjs` |
| 13 | Audit rows for created drafts | ✓ `john-draft-service.test.mjs` |
| 14 | Blocked draft reasons recorded | ✓ `john-draft-service.test.mjs` |
| 15 | Verifies alias configuration | ✓ `john-alias-verifier.test.mjs` |
| 16 | Marks fallback drafts needs_sender_alias_review | ✓ `john-draft-service.test.mjs` |
| 17 | Masks secrets | ✓ `john-outreach-safety.test.mjs` |
| 18 | Admin endpoints require admin | enforced by `adminAuth` middleware |
| 19 | Health exposes no secrets | `/health` returns only `{ ok, agent, status, draft_only }` |
| 20 | Does not break Anya/Robert/etc | additive; full unit suite pass |

## Known limitations

- **No live Yana queue yet.** John ships with `NULL_LEAD_SOURCE`; the
  bridge accepts a `leadSource` injection so Yana (or `draft-from-yana`
  with explicit lead packets) can drive it. When Yana lands, register
  her source via `registerLeadSource(yanaSource)` from her boot module.
- **Microsoft Graph credentials not provisioned in CI.** The Outlook
  provider falls back to `notConfigured` and John returns
  `provider_not_configured` cleanly. Production deployments must set
  the MICROSOFT_* vars.
- **No reply ingestion.** John does not auto-suppress on inbound "no
  thanks" replies in this version. Operators add suppression entries
  manually through the admin UI / API.
- **In-process scheduler.** Single-process. Multi-instance deployments
  must elect a leader or pick one node to set
  `JOHN_RUN_ON_SCHEDULE=true`.

## Architectural guardrails

- **Draft-only is a runtime invariant**, not a config. `assertDraftOnly`
  is called at the entry of every send-capable code path.
- **Suppression is global** (no per-list scoping yet) so a single DNC
  applies to every future John run.
- **Rate caps live in the database**, not in process memory. A fresh
  process picks up exactly where the previous one left off, so a
  restart does not erase the day's used capacity.
- **All persistence is dialect-aware** (sqlite + postgres). JSON columns
  serialise to TEXT for sqlite and pass-through for postgres, and the
  read helpers parse on the way back.
- **Tests run against the real schema** via the in-memory better-sqlite3
  helper in `john-test-helpers.mjs`, so schema drift between migrations
  and code surfaces immediately.

## Next improvements

- Wire the Yana lead source once the Yana queue table is finalised.
- Optional: opt-in reply-ingestion that auto-adds an email to suppression
  when an inbound message contains "no thanks" / "unsubscribe".
- Optional: per-domain rate limits (mirror of Larry's
  `larry_domain_rate_limits`).
- Optional: HTML preview rendering inside `JohnDraftDetails`.
