# Larry — Implementation Report

## Files added

### Database migrations
- `backend/db/migrations/082_larry_tables.sql` — SQLite migration for all
  seven Larry tables (`larry_runs`, `larry_prospect_candidates`, `larry_leads`,
  `larry_outreach_attempts`, `larry_relationships`, `larry_suppression_list`,
  `larry_domain_rate_limits`).
- `backend/db/postgres/migrations/0078_larry_tables.sql` — Postgres counterpart
  using `gen_random_uuid()` and `JSONB`.

### Backend services
- `backend/services/larry/larryTypes.js` — modes, statuses, factories.
- `backend/services/larry/larrySafety.js` — env config, secret masking, URL /
  email / phone classifiers, send-gate predicate.
- `backend/services/larry/larryRunStore.js` — dialect-aware persistence for
  every Larry table; dedup on EIN → website → email → (name, state); JSON
  round-trip; idempotent suppression upserts.
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
- `backend/services/larry/larryOutreachDrafter.js` — `larry_intro_v1` template
  + draft quality inspection.
- `backend/services/larry/larryOutreachSender.js` — gated send with injected
  email adapter; never sends without approval, suppression check, DNC check,
  cooldown check, daily cap, and configured `FROM_EMAIL`.
- `backend/services/larry/larryRelationshipTracker.js` — relationship state +
  cooldown + DNC + automatic suppression-list propagation.
- `backend/services/larry/larryAgent.js` — orchestrator with mode gating and
  observe-mode safety.
- `backend/services/larry/larryScheduler.js` — env-gated scheduler with
  in-process tiny cron parser and overlap protection.

### Routes
- `backend/routes/larry.js` — public `/health`, admin status/run/queues,
  per-lead approve/archive, per-attempt approve/cancel/send, per-prospect DNC.

### Frontend
- `src/components/admin/AdminLarryConsole.jsx` — admin tab.
- `src/components/admin/LarryLeadReviewModal.jsx` — packet review modal.
- `src/pages/Admin.jsx` — wired in the new "Larry" tab.

### Tests (`tests/unit/larry-*.test.mjs`)
- `larry-test-helpers.mjs` — real in-memory better-sqlite3 fixture.
- `larry-safety.test.mjs` — config defaults, classifiers, send-gate predicate.
- `larry-prospect-discovery.test.mjs` — source planning, normalization,
  rejection reasons, end-to-end discovery with adapter.
- `larry-contact-verifier.test.mjs` — verification verdicts, persistence.
- `larry-fit-and-urgency.test.mjs` — score weighting, no-negative behavior.
- `larry-lead-packet-builder.test.mjs` — packet shape, qualification gate.
- `larry-outreach-drafter.test.mjs` — template content, quality gate.
- `larry-outreach-sender.test.mjs` — every blocking gate independently
  (disabled, not approved, no FROM_EMAIL, suppression, DNC, dry-run, happy
  path).
- `larry-relationship-tracker.test.mjs` — contact / replied / DNC /
  cooldown / unique-per-prospect.
- `larry-run-store.test.mjs` — runs lifecycle, prospect dedup, lead dedup,
  JSON round-trip, daily-send count.
- `larry-agent.test.mjs` — disabled refuses to run, observe never calls
  adapters, full-cycle happy path, status snapshot.
- `larry-scheduler.test.mjs` — env-gating, cron-minute matcher.

### Docs
- `docs/LARRY_LEAD_PIPELINE_AGENT.md` — operator-facing.
- `docs/LARRY_OUTREACH_STRATEGY.md` — strategy / scoring / safety rationale.
- `docs/LARRY_IMPLEMENTATION_REPORT.md` — this file.

## Files modified

- `backend/server.js` — mounted `/api/larry` (lazy) and added the env-gated
  Larry scheduler boot block (no-op when `LARRY_ENABLED=false`).
- `backend/db/schema.sql` — appended the seven Larry tables so fresh
  bootstraps include them.
- `src/pages/Admin.jsx` — added a new `Larry` tab pointing at
  `AdminLarryConsole`.

## API surface

Public:
- `GET /api/larry/health`

Admin (requires `req.ctx.isAdmin`):
- `GET /api/larry/status`
- `POST /api/larry/run` (and per-mode aliases `discover-prospects`,
  `verify-contacts`, `score-fit`, `build-packets`, `qualify`,
  `draft-outreach`, `send-outreach`)
- `GET /api/larry/runs`
- `GET /api/larry/prospects`
- `GET /api/larry/leads`, `GET /api/larry/leads/:id`
- `POST /api/larry/leads/:id/approve`
- `POST /api/larry/leads/:id/archive`
- `POST /api/larry/outreach/:attemptId/approve`
- `POST /api/larry/outreach/:attemptId/cancel`
- `POST /api/larry/outreach/:attemptId/send`
- `POST /api/larry/relationships/:prospectId/dnc`

## Environment variables

Documented in `LARRY_LEAD_PIPELINE_AGENT.md`. Defaults are conservative:
`LARRY_ENABLED=false`, `LARRY_MODE=observe`, `LARRY_ALLOW_LIVE_WEB=false`,
`LARRY_AUTO_SEND_OUTREACH=false`, `LARRY_REQUIRE_APPROVAL_TO_SEND=true`,
`LARRY_MAX_OUTREACH_SENDS_PER_DAY=25`.

## Tests

```
node --test tests/unit/larry-*.test.mjs
# tests 68
# pass 68
# fail 0
```

All 68 Larry assertions pass against a real in-memory better-sqlite3 fixture
running the actual `082_larry_tables.sql` migration. The send-gate tests
prove that the email adapter is *never* called when any of the safety
predicates trip.

## Architectural guardrails

- Larry never imports the canonical match engine, the `funding_opportunities`
  table, the user table, or any of Robert's services. He has no way to
  accidentally insert grant data or accept user accounts.
- Larry's only external write surface is the seven `larry_*` tables and (when
  approved) the existing Resend pipeline in `backend/services/email.js`.
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
- Larry currently only sends `email`. `phone`, `contact_form`, and `postal`
  channels are stored as recommendations on the packet for human follow-up.
