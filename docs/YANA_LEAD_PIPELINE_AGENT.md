# Yana — Lead Discovery & Outreach Agent

> **Naming history.** This pipeline was originally shipped under the
> codename "Larry". The user-facing identity has been unified under
> **Yana**, GrantFlow's canonical lead-discovery agent. The backend
> service files in `backend/services/larry/`, the database tables
> `larry_*`, and the environment variables `LARRY_*` keep their
> original spellings for backward compatibility (renaming applied
> migrations and live env config is risky); everything operators and
> users *see* now says "Yana". A `YANA_LEADS_*` env-var alias and a
> `/api/yana-leads/*` route alias are mounted alongside the legacy
> names so new deployments can adopt the canonical naming directly.
>
> If you also have `YANA_ENABLED=true` set, the lead-pipeline scheduler
> intentionally refuses to start so the canonical Yana client-discovery
> adapter (`backend/services/yana/yanaLeadDiscovery.js`, wired to the
> Admin Agent Control Center) and this older lead pipeline never
> double-discover the same prospects. See
> `tests/unit/yana-leads-scheduler.test.mjs` for the guard's exact behaviour.

Yana is GrantFlow's dedicated background agent for finding likely **GrantFlow
clients** (prospective customers/users), verifying their public contact info,
scoring how well they fit GrantFlow's mission, building structured lead
packets, and (with explicit per-attempt admin approval) sending introductory
outreach.

Yana is the lead-pipeline counterpart to:

- **Anya** — user/admin grant-workflow assistant (talks to existing users).
- **Sam** — production-readiness / code health.
- **Robert** — funding-discovery agent (finds *grants*, not *clients*).
- **John** — outreach drafting agent. When `YANA_ENABLED=true`, Yana hands
  qualified leads to John for the actual outreach drafting/sending.

## What Yana does (and does not do)

Yana **does**:

1. Find likely GrantFlow clients from public registries (IRS Tax-Exempt
   Organization Search, NCES schools, USFA fire department registry, USAspending
   assistance awards, community foundation grantee lists, etc.).
2. Verify public organization/contact info — website live, email format/domain
   classification, phone digit-validity, address completeness.
3. Score fit (how well the org matches GrantFlow's audience) and urgency
   (active capital campaigns, recent grant denials, posted deadlines, etc.).
4. Build a structured lead packet (org snapshot + reasons + recommended pitch +
   recommended outreach channel).
5. Hold qualified leads in a review queue until an admin approves.
6. Draft introductory outreach (email by default).
7. Send outreach **only** when (a) Yana is enabled, (b) the attempt is
   explicitly admin-approved, (c) the recipient is not on the suppression list,
   (d) the relationship is not in DNC or cooldown, (e) the daily send cap
   hasn't been reached, and (f) a real `FROM_EMAIL` is configured.
8. Track relationship state per prospect: `none → contacted → opened → replied
   → meeting_scheduled → converted | declined | do_not_contact`.

Yana **does not**:

- Replace Anya, Sam, or Robert.
- Mass-email anyone. Sending always requires per-attempt approval.
- Bypass the existing `email.js` Resend pipeline.
- Touch the `funding_opportunities` table or the canonical match engine.
- Add an organization to the GrantFlow user database. Conversion is a separate
  human process; Yana hands off a packet, not an account.

## Operating modes

| Mode | What it does | Network? | Writes? |
|---|---|---|---|
| `observe` (default) | Read-only sanity report (counts, samples). | No | No |
| `discover-prospects` | Walks the public source registry; persists candidate rows. | Yes (via adapter) | Yes |
| `verify-contacts` | Runs format/liveness checks on existing prospects. | Optional | Updates prospect row |
| `score-fit` | Computes fit + urgency on existing prospects. | No | No |
| `build-packets` | Produces lead packets from scored prospects. | No | Inserts/updates `larry_leads` |
| `qualify` | Marks packets that cross the threshold as `qualified`. | No | Updates `larry_leads.status` |
| `draft-outreach` | Generates email drafts for approved leads. | No | Inserts `larry_outreach_attempts` |
| `send-outreach` | Sends approved drafts. | Yes (Resend) | Updates send status |
| `track-relationships` | Updates relationship state from external signals. | No | Updates `larry_relationships` |
| `full-cycle` | Runs all of the above in sequence. | Yes | Yes |

Default mode is `observe`. Default for the master switch is `false`.

## Environment variables

The canonical names are the `YANA_LEADS_*` aliases listed first. The
`LARRY_*` names are the original env-var spellings and are still
honoured (each variable is read from the canonical name first, then
falls back to the legacy name).

| Canonical (preferred) | Legacy (still honoured) | Default | Purpose |
|---|---|---|---|
| `YANA_LEADS_ENABLED` | `LARRY_ENABLED` | `false` | Master switch. When false, every gate refuses to run. |
| `YANA_LEADS_RUN_ON_STARTUP` | `LARRY_RUN_ON_STARTUP` | `false` | Run a single cycle 5 seconds after server start. |
| `YANA_LEADS_RUN_ON_SCHEDULE` | `LARRY_RUN_ON_SCHEDULE` | `false` | Re-run on the cron expression below. |
| `YANA_LEADS_SCHEDULE` | `LARRY_SCHEDULE` | `0 * * * *` | Cron expression (minute hour DOM month DOW). |
| `YANA_LEADS_MODE` | `LARRY_MODE` | `observe` | Default mode for runs that don't pass an explicit one. |
| `YANA_LEADS_MAX_PROSPECTS_PER_RUN` | `LARRY_MAX_PROSPECTS_PER_RUN` | `50` | Cap on per-run discovery. |
| `YANA_LEADS_MAX_VERIFIES_PER_RUN` | `LARRY_MAX_VERIFIES_PER_RUN` | `100` | Cap on per-run contact verification. |
| `YANA_LEADS_MAX_LEADS_PER_RUN` | `LARRY_MAX_LEADS_PER_RUN` | `50` | Cap on per-run packet building. |
| `YANA_LEADS_MAX_OUTREACH_DRAFTS_PER_RUN` | `LARRY_MAX_OUTREACH_DRAFTS_PER_RUN` | `20` | Cap on per-run drafting. |
| `YANA_LEADS_MAX_OUTREACH_SENDS_PER_DAY` | `LARRY_MAX_OUTREACH_SENDS_PER_DAY` | `25` | Hard daily ceiling on outbound sends. |
| `YANA_LEADS_TIMEOUT_MS` | `LARRY_TIMEOUT_MS` | `15000` | Per-fetch timeout. |
| `YANA_LEADS_ALLOW_LIVE_WEB` | `LARRY_ALLOW_LIVE_WEB` | `false` | Required for any adapter that calls a real network. |
| `YANA_LEADS_ALLOW_SEARCH_ENGINE` | `LARRY_ALLOW_SEARCH_ENGINE` | `false` | Specifically allow search-engine adapters. |
| `YANA_LEADS_PERSIST_PROSPECTS` | `LARRY_PERSIST_PROSPECTS` | `true` | When false, discovery returns candidates without writing. |
| `YANA_LEADS_AUTO_QUALIFY` | `LARRY_AUTO_QUALIFY` | `false` | Reserved; admins should approve qualifications themselves. |
| `YANA_LEADS_AUTO_DRAFT_OUTREACH` | `LARRY_AUTO_DRAFT_OUTREACH` | `false` | When true, qualified leads automatically get drafts. |
| `YANA_LEADS_AUTO_SEND_OUTREACH` | `LARRY_AUTO_SEND_OUTREACH` | `false` | **Strongly discouraged.** Off by default. |
| `YANA_LEADS_REQUIRE_APPROVAL_TO_SEND` | `LARRY_REQUIRE_APPROVAL_TO_SEND` | `true` | Per-attempt admin approval gate. Leave on. |
| `YANA_LEADS_MIN_FIT_SCORE` | `LARRY_MIN_FIT_SCORE` | `60` | Below this, leads stay unqualified. |
| `YANA_LEADS_MIN_COMPOSITE_SCORE` | `LARRY_MIN_COMPOSITE_SCORE` | `65` | Below this, leads stay unqualified. |
| `YANA_LEADS_RESPECT_ROBOTS` | `LARRY_RESPECT_ROBOTS` | `true` | Adapters honor robots.txt when crawling. |
| `YANA_LEADS_USER_AGENT` | `LARRY_USER_AGENT` | `GrantFlowYanaBot/1.0` | Sent on Yana's adapter requests. |
| `YANA_LEADS_RATE_LIMIT_PER_DOMAIN_PER_HOUR` | `LARRY_RATE_LIMIT_PER_DOMAIN_PER_HOUR` | `30` | Polite ceiling per domain. |
| `YANA_LEADS_FAIL_OPEN` | `LARRY_FAIL_OPEN` | `false` | Reserved; gates fail closed by default. |
| `YANA_LEADS_FROM_EMAIL` | `LARRY_FROM_EMAIL` | `FROM_EMAIL` / `EMAIL_FROM` | Sender identity for outreach. |
| `YANA_LEADS_REPLY_TO_EMAIL` | `LARRY_REPLY_TO_EMAIL` | `null` | Optional reply-to. |
| `YANA_LEADS_BCC_COMPLIANCE` | `LARRY_BCC_COMPLIANCE` | `null` | Optional compliance BCC. |

## Data model

Six tables, all idempotent. SQLite migration:
`backend/db/migrations/082_larry_tables.sql`. Postgres migration:
`backend/db/postgres/migrations/0078_larry_tables.sql`. Same definitions also
appended to `backend/db/schema.sql` so fresh-bootstrap SQLite databases pick
them up.

The table names below retain the `larry_` prefix because they are
already-applied migrations and renaming them would require a destructive
schema rewrite for every existing deployment. Treat them as the on-disk
spelling for "Yana lead pipeline" tables.

- `larry_runs` — one row per agent run, with phase counters and a JSON summary.
- `larry_prospect_candidates` — every organization Yana has considered, with
  contact info, signals, and verification status.
- `larry_leads` — one row per (prospect, packet_version) — the structured
  handoff that gets reviewed.
- `larry_outreach_attempts` — every draft, with subject/body/status/sent_at.
- `larry_relationships` — relationship state, contact count, cooldown, DNC.
- `larry_suppression_list` — global hard suppression by email/domain/EIN/org/phone.
- `larry_domain_rate_limits` — rolling per-hour request count per domain.

## Pipeline

```
Find likely GrantFlow clients     (mode: discover-prospects)
        ↓
Verify public organization/contact info     (mode: verify-contacts)
        ↓
Score fit and urgency     (mode: score-fit + build-packets)
        ↓
Build a lead packet     (mode: build-packets)
        ↓
Send qualified leads to Yana review queue     (mode: qualify → admin approval)
        ↓
Yana handles relationship/outreach workflow     (draft-outreach → admin
                                                 approval → send-outreach)
```

Each phase is a callable mode. `full-cycle` runs them in order.

## API endpoints

The canonical paths are `/api/yana-leads/*`. The legacy `/api/larry/*`
paths are still mounted at the same router for backward compatibility
(both URL prefixes resolve to the same handlers).

Public:

- `GET /api/yana-leads/health` — never exposes secrets, only `{ok, agent, status, mode, require_approval_to_send, auto_send_outreach}`.

Admin (gated by `req.ctx.isAdmin`):

- `GET /api/yana-leads/status` — full status snapshot.
- `POST /api/yana-leads/run` — body `{mode, options}`.
- `POST /api/yana-leads/discover-prospects | /verify-contacts | /score-fit | /build-packets | /qualify | /draft-outreach | /send-outreach` — convenience aliases.
- `GET /api/yana-leads/runs` — recent run history.
- `GET /api/yana-leads/prospects` — review queue.
- `GET /api/yana-leads/leads` — lead queue with `?status=` and `?approved=` filters.
- `GET /api/yana-leads/leads/:id` — full packet + outreach attempts.
- `POST /api/yana-leads/leads/:id/approve` — sets `approved_for_outreach=true`.
- `POST /api/yana-leads/leads/:id/archive` — soft-archives a lead.
- `POST /api/yana-leads/outreach/:attemptId/approve` — approves one send.
- `POST /api/yana-leads/outreach/:attemptId/cancel` — cancels one send.
- `POST /api/yana-leads/outreach/:attemptId/send` — actually sends (still goes
  through every safety gate).
- `POST /api/yana-leads/relationships/:prospectId/dnc` — hard DNC; also pushes
  identifiers onto the global suppression list.

## Frontend

- `AdminYanaConsole.jsx` (Admin → Yana tab) — status, run buttons, lead
  queue, recent runs.
- `YanaLeadReviewModal.jsx` — full packet view with per-attempt approve /
  dry-run / send / cancel / archive / DNC controls.

## Safety summary

- Off by default. Observe-mode by default.
- No live web calls without an explicit adapter and `YANA_LEADS_ALLOW_LIVE_WEB=true`
  (legacy `LARRY_ALLOW_LIVE_WEB` still honoured).
- Sending always requires per-attempt admin approval (unless the operator
  explicitly disables `YANA_LEADS_REQUIRE_APPROVAL_TO_SEND`, which we do not
  recommend).
- Suppression list is consulted on every send. DNC supersedes all other gates.
- Cooldown after every send (default 14 days) until a reply arrives.
- Daily send cap.
- Domain rate limits during discovery (default 30/hour/domain).
- Drafts that look templatic, too short, or contain unfilled placeholders are
  flagged by the quality gate and not surfaced as ready to send.
- Audit log entries (`category=admin`, `action=larry:*`) for every approve,
  cancel, send, and DNC action. (The `larry:` action prefix is a legacy
  identifier; the entries belong to the Yana lead pipeline.)
