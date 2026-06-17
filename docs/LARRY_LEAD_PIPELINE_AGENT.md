# Larry — Lead Discovery & Outreach Agent

Larry is GrantFlow's dedicated background agent for finding likely **GrantFlow
clients** (prospective customers/users), verifying their public contact info,
scoring how well they fit GrantFlow's mission, building structured lead
packets, and (with explicit per-attempt admin approval) sending introductory
outreach.

Larry is the lead-pipeline counterpart to:

- **Anya** — user/admin grant-workflow assistant (talks to existing users).
- **Sam** — production-readiness / code health.
- **Robert** — funding-discovery agent (finds *grants*, not *clients*).

## What Larry does (and does not do)

Larry **does**:

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
7. Send outreach **only** when (a) Larry is enabled, (b) the attempt is
   explicitly admin-approved, (c) the recipient is not on the suppression list,
   (d) the relationship is not in DNC or cooldown, (e) the daily send cap
   hasn't been reached, and (f) a real `FROM_EMAIL` is configured.
8. Track relationship state per prospect: `none → contacted → opened → replied
   → meeting_scheduled → converted | declined | do_not_contact`.

Larry **does not**:

- Replace Anya, Sam, or Robert.
- Mass-email anyone. Sending always requires per-attempt approval.
- Bypass the existing `email.js` Resend pipeline.
- Touch the `funding_opportunities` table or the canonical match engine.
- Add an organization to the GrantFlow user database. Conversion is a separate
  human process; Larry hands off a packet, not an account.

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

Default `LARRY_MODE` is `observe`. Default `LARRY_ENABLED` is `false`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `LARRY_ENABLED` | `false` | Master switch. When false, every gate refuses to run. |
| `LARRY_RUN_ON_STARTUP` | `false` | Run a single cycle 5 seconds after server start. |
| `LARRY_RUN_ON_SCHEDULE` | `false` | Re-run on the cron expression below. |
| `LARRY_SCHEDULE` | `0 * * * *` | Cron expression (minute hour DOM month DOW). |
| `LARRY_MODE` | `observe` | Default mode for runs that don't pass an explicit one. |
| `LARRY_MAX_PROSPECTS_PER_RUN` | `50` | Cap on per-run discovery. |
| `LARRY_MAX_VERIFIES_PER_RUN` | `100` | Cap on per-run contact verification. |
| `LARRY_MAX_LEADS_PER_RUN` | `50` | Cap on per-run packet building. |
| `LARRY_MAX_OUTREACH_DRAFTS_PER_RUN` | `20` | Cap on per-run drafting. |
| `LARRY_MAX_OUTREACH_SENDS_PER_DAY` | `25` | Hard daily ceiling on outbound sends. |
| `LARRY_TIMEOUT_MS` | `15000` | Per-fetch timeout. |
| `LARRY_ALLOW_LIVE_WEB` | `false` | Required for any adapter that calls a real network. |
| `LARRY_ALLOW_SEARCH_ENGINE` | `false` | Specifically allow search-engine adapters. |
| `LARRY_PERSIST_PROSPECTS` | `true` | When false, discovery returns candidates without writing. |
| `LARRY_AUTO_QUALIFY` | `false` | Reserved; admins should approve qualifications themselves. |
| `LARRY_AUTO_DRAFT_OUTREACH` | `false` | When true, qualified leads automatically get drafts. |
| `LARRY_AUTO_SEND_OUTREACH` | `false` | **Strongly discouraged.** Off by default. |
| `LARRY_REQUIRE_APPROVAL_TO_SEND` | `true` | Per-attempt admin approval gate. Leave on. |
| `LARRY_MIN_FIT_SCORE` | `60` | Below this, leads stay unqualified. |
| `LARRY_MIN_COMPOSITE_SCORE` | `65` | Below this, leads stay unqualified. |
| `LARRY_RESPECT_ROBOTS` | `true` | Adapters honor robots.txt when crawling. |
| `LARRY_USER_AGENT` | `GrantFlowLarryBot/1.0` | Sent on Larry's adapter requests. |
| `LARRY_RATE_LIMIT_PER_DOMAIN_PER_HOUR` | `30` | Polite ceiling per domain. |
| `LARRY_FAIL_OPEN` | `false` | Reserved; gates fail closed by default. |
| `LARRY_FROM_EMAIL` | `FROM_EMAIL` / `EMAIL_FROM` | Sender identity for outreach. |
| `LARRY_REPLY_TO_EMAIL` | `null` | Optional reply-to. |
| `LARRY_BCC_COMPLIANCE` | `null` | Optional compliance BCC. |

## Data model

Six tables, all idempotent. SQLite migration:
`backend/db/migrations/082_larry_tables.sql`. Postgres migration:
`backend/db/postgres/migrations/0078_larry_tables.sql`. Same definitions also
appended to `backend/db/schema.sql` so fresh-bootstrap SQLite databases pick
them up.

- `larry_runs` — one row per agent run, with phase counters and a JSON summary.
- `larry_prospect_candidates` — every organization Larry has considered, with
  contact info, signals, and verification status.
- `larry_leads` — one row per (prospect, packet_version) — the structured
  handoff that gets reviewed.
- `larry_outreach_attempts` — every draft, with subject/body/status/sent_at.
- `larry_relationships` — relationship state, contact count, cooldown, DNC.
- `larry_suppression_list` — global hard suppression by email/domain/EIN/org/phone.
- `larry_domain_rate_limits` — rolling per-hour request count per domain.

## Pipeline (matches the user-supplied flow)

```
Find likely GrantFlow clients     (mode: discover-prospects)
        ↓
Verify public organization/contact info     (mode: verify-contacts)
        ↓
Score fit and urgency     (mode: score-fit + build-packets)
        ↓
Build a lead packet     (mode: build-packets)
        ↓
Send qualified leads to Larry     (mode: qualify → admin approval)
        ↓
Larry handles relationship/outreach workflow     (draft-outreach → admin
                                                  approval → send-outreach)
```

Each phase is a callable mode. `full-cycle` runs them in order.

## API endpoints

Public:

- `GET /api/larry/health` — never exposes secrets, only `{ok, agent, status, mode, require_approval_to_send, auto_send_outreach}`.

Admin (gated by `req.ctx.isAdmin`):

- `GET /api/larry/status` — full status snapshot.
- `POST /api/larry/run` — body `{mode, options}`.
- `POST /api/larry/discover-prospects | /verify-contacts | /score-fit | /build-packets | /qualify | /draft-outreach | /send-outreach` — convenience aliases.
- `GET /api/larry/runs` — recent run history.
- `GET /api/larry/prospects` — review queue.
- `GET /api/larry/leads` — lead queue with `?status=` and `?approved=` filters.
- `GET /api/larry/leads/:id` — full packet + outreach attempts.
- `POST /api/larry/leads/:id/approve` — sets `approved_for_outreach=true`.
- `POST /api/larry/leads/:id/archive` — soft-archives a lead.
- `POST /api/larry/outreach/:attemptId/approve` — approves one send.
- `POST /api/larry/outreach/:attemptId/cancel` — cancels one send.
- `POST /api/larry/outreach/:attemptId/send` — actually sends (still goes
  through every safety gate).
- `POST /api/larry/relationships/:prospectId/dnc` — hard DNC; also pushes
  identifiers onto the global suppression list.

## Frontend

- `AdminLarryConsole.jsx` (Admin → Larry tab) — status, run buttons, lead
  queue, recent runs.
- `LarryLeadReviewModal.jsx` — full packet view with per-attempt approve /
  dry-run / send / cancel / archive / DNC controls.

## Safety summary

- Off by default. Observe-mode by default.
- No live web calls without an explicit adapter and `LARRY_ALLOW_LIVE_WEB=true`.
- Sending always requires per-attempt admin approval (unless the operator
  explicitly disables `LARRY_REQUIRE_APPROVAL_TO_SEND`, which we do not
  recommend).
- Suppression list is consulted on every send. DNC supersedes all other gates.
- Cooldown after every send (default 14 days) until a reply arrives.
- Daily send cap.
- Domain rate limits during discovery (default 30/hour/domain).
- Drafts that look templatic, too short, or contain unfilled placeholders are
  flagged by the quality gate and not surfaced as ready to send.
- Audit log entries (`category=admin`, `action=larry:*`) for every approve,
  cancel, send, and DNC action.
