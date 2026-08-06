# Robert Contact Harvest → Yana Verification → John

Owner directive (2026-07-25): Robert looks through the owner's contacts and
recent emails in four accounts, extracts contacts that have **both** a name and
an email address, sends them to **Yana for verification**, and only
Yana-verified contacts are passed on to **John** (the outreach-draft agent).

## Flow

```
Robert (robertContactHarvest.js)
  reads 4 mailboxes (headers + address books ONLY — never message bodies)
  → requires BOTH name AND email; drops no-reply/bulk/list/excluded/self
  → dedupes across accounts
  → files rows in YANA'S LANE: yana_lead_candidates
      source = 'robert_contact_harvest', qualification_status = 'candidate'

Yana (yanaHarvestVerification.js, runs inside every runYanaDiscovery cycle)
  re-verifies each candidate independently (valid email, real name, not an
  excluded/list/non-human address, not an existing GrantFlow client, not the
  owner) → 'qualified' or 'unqualified' (with reasons; never deleted)

John (existing handoff — UNCHANGED)
  Yana's pushQualifiedToJohn (≤50 / rolling 24h cap) marks qualified leads
  pushed_to_john; John consumes them via makeYanaLeadSource / johnYanaBridge
  with all of his own gates (score floor, evidence, suppression, exclusions).
```

Robert **never** writes into John's stores, and nothing in this feature can
send email — John remains draft-only under his own safety config.

## Safety posture

- **Default OFF.** The whole feature is gated by `ROBERT_CONTACT_HARVEST=true`
  (it reads personal mailboxes). Unset/false = honest no-op, zero DB writes.
- **Per-account honesty.** An account with no configured credentials is
  reported `skipped` with the env name it needs; a mailbox that fails to read
  is reported `error` for that account only. No fabricated contacts, ever.
- **Privacy floor.** Readers fetch only address books and message
  headers/envelopes (`from`/`to`/`cc`/date). Message bodies are never fetched
  and never stored. A harvested row carries only: name, email, source
  account(s), last-seen date, provenance.
- **Bounded.** Lookback days, per-account message and contact caps, and the
  Yana verification batch size are all env-tunable and hard-capped.

## Environment variables (names only — never commit values)

| Variable | Account / purpose | Default |
| --- | --- | --- |
| `ROBERT_CONTACT_HARVEST` | Master gate for the whole feature | `false` (OFF) |
| `ROBERT_HARVEST_DAYS` | Recent-mail lookback window (days) | `90` (max 365) |
| `ROBERT_HARVEST_MAX_MESSAGES` | Max messages read per account per run | `200` (max 1000) |
| `ROBERT_HARVEST_MAX_CONTACTS` | Max address-book entries per account | `500` (max 2000) |
| `ROBERT_GMAIL_ACCOUNT` / `ROBERT_GMAIL_APP_PASSWORD` | Owner-configured Gmail account and IMAP app password | either unset → account skipped |
| `ROBERT_YAHOO_PRIMARY_ACCOUNT` / `ROBERT_YAHOO_PRIMARY_APP_PASSWORD` | Owner-configured primary Yahoo account and app password | either unset → account skipped |
| `ROBERT_YAHOO_SECONDARY_ACCOUNT` / `ROBERT_YAHOO_SECONDARY_APP_PASSWORD` | Owner-configured secondary Yahoo account and app password | either unset → account skipped |
| `ROBERT_GRAPH_ACCOUNT` + `MICROSOFT_TENANT_ID` / `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | Owner-configured Microsoft 365 mailbox and app-only credentials | any unset → account skipped |
| `OWNER_CONTACT_EMAILS` | Comma-separated owner self-addresses excluded from prospecting | unset in production → empty |
| `YANA_HARVEST_VERIFY_LIMIT` | Yana verification batch per discovery cycle | `200` |

No OAuth browser flows are implemented anywhere — env-provided app passwords /
app credentials only.

## What the owner must provision, per account

1. **Configured Gmail account** — enable 2-Step Verification, create an
   [App Password](https://myaccount.google.com/apppasswords), set the account as
   `ROBERT_GMAIL_ACCOUNT` and the password as `ROBERT_GMAIL_APP_PASSWORD`.
   IMAP must be enabled in Gmail settings.
   *Note:* IMAP exposes recent mail headers, not the Google Contacts address
   book. To also harvest the saved address book, export Google Contacts to CSV
   and use the existing owner-contacts import
   (`yanaContactsImport.parseContactsCsv` / the admin import endpoint).
2. **Configured Yahoo accounts** — generate an app password per account (Yahoo
   Account Security → "Generate app password") and set the matching primary or
   secondary account/password pair. Yahoo has no contacts API — the
   address book, if wanted, goes through the same CSV import as Gmail's.
3. **Configured Microsoft 365 account** — set `ROBERT_GRAPH_ACCOUNT`; the
   existing Graph app may be reused. The Azure app needs application (app-only)
   permissions **Mail.Read** (already consented for the grant email feed) and
   **Contacts.Read** (also used by the existing `ROBERT_SCAN_EMAIL_CONTACTS`
   scan) with admin consent.
4. Set `ROBERT_CONTACT_HARVEST=true` once credentials are in place.

## Where things live

- `backend/services/robert/robertMailboxReaders.js` — per-account readers
  (IMAP via `imapflow` for Gmail/Yahoo; Microsoft Graph for axiombiolabs).
- `backend/services/robert/robertContactHarvest.js` — gate, extraction rules,
  cross-account dedupe, Yana-lane handoff. Runs as Phase 1d of Robert's agent
  cycle (`robertAgent.js`), reported on the run summary (`contact_harvest`).
- `backend/services/yana/yanaHarvestVerification.js` — Yana's deterministic
  verification pass, wired into `runYanaDiscovery` (summary field
  `harvest_verification`).
- Tests: `backend/tests/robertContactHarvest.test.js` (offline, injected
  readers — extraction, both-fields rule, exclusions, dedupe, handoff shape,
  gate-off default, skipped-account honesty, verification verdicts, and the
  Yana→John gate).

## Relationship to the existing contact scan

The older `robertContactDiscovery.js` (`ROBERT_SCAN_EMAIL_CONTACTS` /
`ROBERT_SCAN_EMAIL_MESSAGES`) reads only the axiombiolabs Graph mailbox and
files client-prospect candidates in `robert_source_candidates` for
`robertJohnBridge`. This harvest is the owner-directed, four-account,
Yana-verified lane; it shares the non-human filter and exclusion helpers but
routes exclusively through Yana. Both remain independently gated.
