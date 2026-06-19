# Yana — Lead Pipeline Implementation Report

> **Naming.** This pipeline ships under the user-facing identity **Yana**.
> The on-disk filenames, table names, and audit-log action prefixes still
> read `larry_*` because they were already in production when the rename
> happened — see `docs/YANA_LEAD_PIPELINE_AGENT.md` for the full migration
> story. Wherever this report references a `larry_*` filename, table, or
> route, that is the spelling on disk; the user-facing component is
> "Yana".

## Files added

### Database migrations
- `backend/db/migrations/082_larry_tables.sql` — SQLite migration for all
  seven Yana lead-pipeline tables (`larry_runs`, `larry_prospect_candidates`,
  `larry_leads`, `larry_outreach_attempts`, `larry_relationships`,
  `larry_suppression_list`, `larry_domain_rate_limits`).
- `backend/db/postgres/migrations/0078_larry_tables.sql` — Postgres counterpart
  using `gen_random_uuid()` and `JSONB`.

### Backend services
- `backend/services/larry/larryTypes.js` — modes, statuses, factories.
- `backend/services/larry/larrySafety.js` — env config, secret masking, URL /
  email / phone classifiers, send-gate predicate.
- `backend/services/larry/larryRunStore.js` — dialect-aware persistence for
  every Yana lead-pipeline table; dedup on EIN → website → email →
  (name, state); JSON round-trip; idempotent suppression upserts.
- `backend/services/larry/larryProspectSources.js` — registry of public
  directories with applicant-type tagging and trust scoring.
- `backend/services/larry/larryProspectDiscovery.js` — pluggable adapter-driven
  discovery; rejects placeholder URLs, disposable emails, government agencies;
  domain rate-limited.
- `backend/services/larry/larryContactVerifier.js` — pluggable web/MX checks +
  format-only fallback; persists status to the prospect row.
- `backend/services/larry/larryFitScorer.js` — explainable fit score with
  per-reason weights.
- `backend/services/larry/larryUrgencyScorer.js` — urgency score + 70/30
  composite.
- `backend/services/larry/larryLeadPacketBuilder.js` — pure packet builder +
  qualification gate.
- `backend/services/larry/larryOutreachDrafter.js` — `larry_intro_v1`
  (a.k.a. `yana_intro_v1`) template + draft quality inspection.
- `backend/services/larry/larryOutreachSender.js` — gated send with injected
  email adapter; never sends without approval, suppression check, DNC check,
  cooldown check, daily cap, and configured `FROM_EMAIL`.
- `backend/services/larry/larryRelationshipTracker.js` — relationship state +
  cooldown + DNC + automatic suppression-list propagation.
- `backend/services/larry/larryAgent.js` — orchestrator with mode gating and
  observe-mode safety.
- `backend/services/larry/larryScheduler.js` — env-gated scheduler with
  in-process tiny cron parser and overlap protection. Refuses to start when
  `YANA_ENABLED=true` (so the canonical Yana client-discovery adapter and
  this older lead pipeline never double-discover).

### Routes
- `backend/routes/larry.js` — public `/health`, admin status/run/queues,
  per-lead approve/archive, per-attempt approve/cancel/send, per-prospect DNC.
  Mounted at `/api/yana-leads` (canonical) and `/api/larry` (legacy alias).

### Frontend
- `src/components/admin/AdminYanaConsole.jsx` — admin tab.
- `src/components/admin/YanaLeadReviewModal.jsx` — packet review modal.
- `src/pages/Admin.jsx` — wired in the new "Yana" tab.

### Tests (`tests/unit/yana-leads-*.test.mjs`)
- `yana-leads-test-helpers.mjs` — real in-memory better-sqlite3 fixture.
- `yana-leads-safety.test.mjs` — config defaults, classifiers, send-gate predicate.
- `yana-leads-prospect-discovery.test.mjs` — source planning, normalization,
  rejection reasons, end-to-end discovery with adapter.
- `yana-leads-contact-verifier.test.mjs` — verification verdicts, persistence.
- `yana-leads-fit-and-urgency.test.mjs` — score weighting, no-negative behavior.
- `yana-leads-lead-packet-builder.test.mjs` — packet shape, qualification gate.
- `yana-leads-outreach-drafter.test.mjs` — template content, quality gate.
- `yana-leads-outreach-sender.test.mjs` — every blocking gate independently
  (disabled, not approved, no FROM_EMAIL, suppression, DNC, dry-run, happy
  path).
- `yana-leads-relationship-tracker.test.mjs` — contact / replied / DNC /
  cooldown / unique-per-prospect.
- `yana-leads-run-store.test.mjs` — runs lifecycle, prospect dedup, lead dedup,
  JSON round-trip, daily-send count.
- `yana-leads-agent.test.mjs` — disabled refuses to run, observe never calls
  adapters, full-cycle happy path, status snapshot.
- `yana-leads-scheduler.test.mjs` — env-gating, cron-minute matcher,
  refuse-when-Yana-enabled guard.

### Docs
- `docs/YANA_LEAD_PIPELINE_AGENT.md` — operator-facing.
- `docs/YANA_OUTREACH_STRATEGY.md` — strategy / scoring / safety rationale.
- `docs/YANA_LEAD_PIPELINE_IMPLEMENTATION_REPORT.md` — this file.

## Files modified

- `backend/server.js` — mounted `/api/yana-leads` (and `/api/larry` alias)
  and added the env-gated Yana scheduler boot block (no-op when
  `YANA_LEADS_ENABLED=false` / `LARRY_ENABLED=false`).
- `backend/db/schema.sql` — appended the seven `larry_*` tables so fresh
  bootstraps include them.
- `src/pages/Admin.jsx` — added a new "Yana" tab pointing at
  `AdminYanaConsole`.

## API surface

The canonical paths are `/api/yana-leads/*`. The legacy `/api/larry/*`
paths are still mounted at the same router for backward compatibility.

Public:
- `GET /api/yana-leads/health`

Admin (requires `req.ctx.isAdmin`):
- `GET /api/yana-leads/status`
- `POST /api/yana-leads/run` (and per-mode aliases `discover-prospects`,
  `verify-contacts`, `score-fit`, `build-packets`, `qualify`,
  `draft-outreach`, `send-outreach`)
- `GET /api/yana-leads/runs`
- `GET /api/yana-leads/prospects`
- `GET /api/yana-leads/leads`, `GET /api/yana-leads/leads/:id`
- `POST /api/yana-leads/leads/:id/approve`
- `POST /api/yana-leads/leads/:id/archive`
- `POST /api/yana-leads/outreach/:attemptId/approve`
- `POST /api/yana-leads/outreach/:attemptId/cancel`
- `POST /api/yana-leads/outreach/:attemptId/send`
- `POST /api/yana-leads/relationships/:prospectId/dnc`

## Environment variables

Documented in `YANA_LEAD_PIPELINE_AGENT.md`. Defaults are conservative:
`YANA_LEADS_ENABLED=false` (legacy `LARRY_ENABLED=false`),
`YANA_LEADS_MODE=observe`, `YANA_LEADS_ALLOW_LIVE_WEB=false`,
`YANA_LEADS_AUTO_SEND_OUTREACH=false`,
`YANA_LEADS_REQUIRE_APPROVAL_TO_SEND=true`,
`YANA_LEADS_MAX_OUTREACH_SENDS_PER_DAY=25`. The legacy `LARRY_*` spellings
are still honoured.

## Tests

```
node --test tests/unit/yana-leads-*.test.mjs
# tests 68+ (plus the new "refuse when Yana enabled" guard)
# pass  all
# fail  0
```

All Yana lead-pipeline assertions pass against a real in-memory better-sqlite3
fixture running the actual `082_larry_tables.sql` migration. The send-gate
tests prove that the email adapter is *never* called when any of the safety
predicates trip.

## Architectural guardrails

- The Yana lead pipeline never imports the canonical match engine, the
  `funding_opportunities` table, the user table, or any of Robert's services.
  It has no way to accidentally insert grant data or accept user accounts.
- The pipeline's only external write surface is the seven `larry_*` tables
  and (when approved) the existing Resend pipeline in
  `backend/services/email.js`.
- The send adapter is dependency-injected, so unit tests can prove the gate
  *prevents* the email client from being called at all when conditions aren't
  met (vs. just trusting it would refuse).
- The agent orchestrator delegates every phase to a separate single-purpose
  module, so phases can be unit-tested independently and skipped in modes that
  don't need them.

## Known limitations / next improvements

- The `findhelp.org`, Candid, and per-state SoS adapters are placeholders in
  the registry; the actual fetch logic lives in adapters that are wired in by
  the route layer or scheduler at runtime, not in this PR.
- The `track-relationships` mode currently relies on admin-driven inputs
  (manual `/dnc`, manual reply classification). A future PR can add a webhook
  endpoint for inbound replies and bounces.
- Reply classification (`recordRepliedRelationship({classification})`) is
  string-based; a future PR can plug in a small classifier.
- Yana currently only sends `email`. `phone`, `contact_form`, and `postal`
  channels are stored as recommendations on the packet for human follow-up.
- The on-disk filenames (`backend/services/larry/`, `larry_*` tables, the
  `LARRY_*` env vars, the `audit_log.action='larry:*'` rows) still use the
  legacy `larry` spelling. Renaming them is a destructive migration and is
  intentionally deferred.
