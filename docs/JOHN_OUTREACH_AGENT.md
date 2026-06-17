# John — Outreach Drafting Agent

John is GrantFlow's outreach **drafting** agent. He receives qualified lead
packets from Yana (the lead-discovery agent), interprets the public
information Yana found, writes a respectful, specific, human email, and
places that email into the **Microsoft Outlook drafts folder** of
`dr.johnwhite@axiombiolabs.org` for Dr. John White to review and send
manually.

> **John never sends.** This is a runtime guarantee — see `assertDraftOnly`
> in `backend/services/john/johnOutreachSafety.js`. The send code path
> simply does not exist in this version, no matter what environment
> variables an operator sets.

## What John is not

- A spam bot
- A mass sender
- An automatic sender
- A scraper
- A lead finder (that's Yana)
- A replacement for Yana, Anya, Sam, or Robert
- A guarantee-maker
- A high-pressure sales agent

## How John differs from Yana

| Concern | Yana | John |
| --- | --- | --- |
| Mission | Find prospective GrantFlow clients | Draft respectful outreach to qualified Yana leads |
| Touches the open web? | Yes (verifies orgs and contacts) | No (only consumes Yana's lead packets) |
| Touches email? | No | Creates Outlook **drafts** only |
| Sends? | No | **No** |
| Limits | Cooldown, suppression, daily caps | 50/24h, 10/hour, 50/run, alias gate, opt-out gate, address gate |

## Outlook mailbox setup

| Variable | Default |
| --- | --- |
| `JOHN_PRIMARY_MAILBOX` | `dr.johnwhite@axiombiolabs.org` |
| `JOHN_FROM_ALIAS` | `GrantFlow@axiombiolabs.org` |
| `JOHN_REPLY_TO` | `GrantFlow@axiombiolabs.org` |
| `JOHN_DISPLAY_NAME` | `Dr. John White | GrantFlow` |

John talks to Microsoft Graph via app-only OAuth2 (`client_credentials`).
Configure these:

```
MICROSOFT_TENANT_ID=...
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_GRAPH_SCOPES=Mail.ReadWrite Mail.Send User.Read offline_access
```

The Azure AD app must have:

- `Mail.ReadWrite` (application) — to create draft messages.
- (Optional) `Mail.Send` (application) — only if a future version sends.
  In **this** version it is unused.
- A SendAs / SendOnBehalfOf permission on the alias mailbox if you want
  Graph to honour the requested `From` alias.

Secrets are masked (`maskSecrets`) before any log line is written.

## Alias setup

John tries to set `From: Dr. John White | GrantFlow <GrantFlow@axiombiolabs.org>`
on every draft. If Microsoft Graph rejects that header (because the app
lacks SendAs for the alias mailbox), John retries **without** the From
header. The result is recorded on the draft:

```json
{
  "requested_from_alias": "GrantFlow@axiombiolabs.org",
  "actual_from": "dr.johnwhite@axiombiolabs.org",
  "alias_verified": true,
  "alias_send_supported": false,
  "fallback_used": true,
  "needs_sender_alias_review": true
}
```

When `JOHN_ALLOW_PRIMARY_MAILBOX_FALLBACK_DRAFTS=true` (default), John
keeps the draft but flips its `draft_status` to
`needs_sender_alias_review`. Dr. White will see a yellow "Needs alias
review" badge on the draft in the Admin → John tab and an audit warning
to confirm the From line before sending.

To verify the alias up front:

```
POST /api/john/verify-alias
```

The verifier creates a small test draft addressed to `JOHN_TEST_RECIPIENT`,
records whether Graph accepted the From header, and stores the result in
`john_alias_checks`.

## Draft-only behavior

John is draft-only by guarantee. Three independent layers enforce it:

1. **Configuration** — `JOHN_DRAFT_ONLY=true` (default). If an operator
   sets `JOHN_DRAFT_ONLY=false`, `assertDraftOnly()` throws
   `JOHN_DRAFT_ONLY_REQUIRED` and the agent refuses to start.
2. **Code surface** — there is no send code path in
   `backend/services/john/`. The Outlook provider exposes `createDraft` and
   `verifyMailbox` only.
3. **API surface** — `backend/routes/john.js` has no send endpoint. The
   admin console has no send button.

## Daily limit behavior

- Rolling 24-hour cap: `JOHN_MAX_DRAFTS_PER_24H` (default 50)
- Rolling 60-minute cap: `JOHN_MAX_DRAFTS_PER_HOUR` (default 10)
- Per-run cap: `JOHN_MAX_DRAFTS_PER_RUN` (default 50)

Counts come from `john_email_drafts` excluding `blocked` and `failed` rows
(those represent attempts that never produced an Outlook draft). When a
cap is reached, the agent returns `daily_limit_reached` (or
`hourly_limit_reached`) and writes a `john_runs` row recording why.

## Email style rules

See `docs/JOHN_EMAIL_STYLE_GUIDE.md` for the full guide. The short version:

- warm, specific, respectful, plain-English, mission-minded
- no guarantees, no pressure, no fake personalisation
- always include opt-out language and the configured physical address
- only personalise from Yana-supplied public evidence

## Safety rules (per draft)

Before John creates a draft for a lead, he runs a safety classifier
(`evaluateDraftSafety`) which returns `passed` or `blocked` with a list of
reasons. Blocking conditions:

- recipient suppressed (email/domain/organisation/phone)
- recipient invalid or missing
- lead is not qualified by Yana (and `requireYanaQualified=true`)
- lead score below `JOHN_MIN_LEAD_SCORE`
- missing public evidence (`requirePublicEvidence=true`)
- missing contact source URL (`requireContactSource=true`)
- subject matches a blocked pattern (e.g. `Re:`, `urgent`, `approved`)
- body promises funding, claims a prior relationship, or uses predatory
  framing
- body is missing the opt-out line or the configured physical address
- daily / hourly cap reached
- already drafted for the same lead
- provider not configured (no MICROSOFT_* env)

Every blocked draft writes a `john_email_drafts` row with `draft_status =
blocked` and a `john_email_audit` row with `status = draft_blocked`,
including the reasons array. Reviewers can see exactly why each draft was
refused.

## Suppression rules

The global suppression list lives in `john_suppression_list`. Add entries
through the admin endpoint:

```
POST /api/john/suppression
{ "type": "email" | "domain" | "organization" | "phone", "value": "..." }
```

If a recipient replies "no thanks" / "unsubscribe" / "remove me", an
operator should add the email or domain. John does not auto-read replies
in this version.

## Admin endpoints

All admin endpoints require `req.ctx.isAdmin === true`, an admin role on
the bearer token, or a valid `ADMIN_TOKEN` / `JOHN_ADMIN_TOKEN`.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/john/health` | Public; returns `{ ok, agent: 'John', status }` |
| GET | `/api/john/status` | Full status + metrics |
| POST | `/api/john/run` | Run a mode (`observe` / `draft` / `revise` / `verify-alias` / `full-cycle`) |
| POST | `/api/john/verify-alias` | Run the alias verifier explicitly |
| POST | `/api/john/create-test-draft` | Create one test draft to `JOHN_TEST_RECIPIENT` |
| POST | `/api/john/draft-from-yana` | Draft from explicit lead packets or lead IDs |
| GET | `/api/john/runs` | List recent runs |
| GET | `/api/john/runs/:runId` | Single run |
| GET | `/api/john/drafts` | List drafts (filter by `?status=`) |
| GET | `/api/john/drafts/:draftId` | Single draft |
| POST | `/api/john/drafts/:id/revise` | Manual revision (re-runs safety) |
| POST | `/api/john/drafts/:id/archive` | Archive (no send) |
| GET | `/api/john/audit` | Audit feed |
| GET | `/api/john/suppression` | Suppression list |
| POST | `/api/john/suppression` | Add to suppression list |
| GET | `/api/john/leads` | Leads currently available for John to draft |

There is **no send endpoint** by design.

## Scheduler behavior

Disabled unless both `JOHN_ENABLED=true` and one of
`JOHN_RUN_ON_SCHEDULE=true` / `JOHN_RUN_ON_STARTUP=true`. The default
schedule is `30 9 * * *` (09:30 server time) — a single daily batch.

The scheduler:

- never blocks server startup
- never overlaps two runs (in-process mutex)
- runs at most once per matching minute
- catches and logs any exception so a failed John run never crashes the
  server

To start manually instead, leave the scheduler disabled and use the Admin
→ John → "Draft Today's Batch" button.

## How to review drafts

1. Open Admin → John in the GrantFlow admin UI.
2. Look at the metrics row: drafts in last 24 hours, remaining capacity,
   safety failures, drafts needing alias review.
3. Open the **Drafts** table. Click `View` on any row.
4. Inspect the rendered subject and body. Check the alias report and the
   safety report. Edit the subject or body if you want; clicking
   `Save Revision` re-runs the body classifier and records a new
   `needs_review` row.
5. To send: open the draft directly in Outlook (the provider's
   `provider_draft_id` is the Graph message id; the draft lives in the
   primary mailbox's Drafts folder). Confirm the From line, edit if
   needed, and click Send in Outlook.
6. To suppress a recipient: Admin → John → Drafts row → Archive, then add
   the email or domain via the Suppression form.

## Troubleshooting alias issues

- "Alias not verified": run `POST /api/john/verify-alias`. If the response
  is `provider_not_configured`, the MICROSOFT_* env is missing.
- "Alias verified, send not supported": the Azure AD app does not have
  SendAs / SendOnBehalfOf permission on `GrantFlow@axiombiolabs.org`.
  Either grant that permission, or accept that drafts will be marked
  `needs_sender_alias_review` and Dr. White will fix the From line in
  Outlook before sending.
- "JOHN_OUTLOOK_TOKEN_FAILED": the client credentials are invalid or
  expired. Check `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, and the
  client secret. Logs are masked, so you'll see `Bearer ***` rather than
  the actual token.

## Yana → John workflow

```
Yana
  finds prospects
  → verifies orgs/contacts
  → scores fit & urgency
  → builds qualified lead packets   (up to 50 / 24h)
        │
        ▼
John (this agent)
  reads queue (johnYanaBridge)
  → interprets each packet
  → composes a personalised email
  → runs safety classifier
  → creates Outlook draft
  → records audit row
        │
        ▼
Dr. John White (manual)
  reviews each draft in Outlook
  → optionally edits
  → sends manually
```

## Data model

Five new tables (idempotent migrations for SQLite and Postgres):

- `john_runs` — one row per agent run
- `john_email_drafts` — one row per draft attempt (created / blocked / failed)
- `john_suppression_list` — global suppression by email / domain / org / phone
- `john_email_audit` — full audit feed
- `john_alias_checks` — every alias-verification attempt

See migrations/083_john_tables.sql for the canonical schema.
