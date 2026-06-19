# Owner Blocklist

A single canonical denylist for GrantFlow. Anyone the owner blocks — by **email,
domain, phone number, surname, organization, or full name** — is automatically:

1. **Banned from accounts** — can't start auth, log in, or verify a code; any
   existing account is marked `status = 'banned'`.
2. **Rejected at inbound** — can't be added as a contact.
3. **Suppressed from outreach** — email/domain/phone/org entries are mirrored
   into the **John** and **Larry** suppression lists those agents already check
   before contacting anyone (no pipeline changes needed).

## Why "push", not "pull"

Neither source can be read by a backend:

- **Gmail blocked senders** are not exposed by the Gmail API. The closest signal
  is your **filters** that trash / skip-inbox mail.
- **A phone's block list** (`BlockedNumberContract` on Android, CallKit on iOS)
  is readable only by the default dialer / a system app — never a server.

So your devices **push** their lists into GrantFlow's ingest endpoint. The phone
uses Tasker; Gmail uses a Google Apps Script (or the server-side sync below if
you configure Gmail OAuth).

## Data model

- `owner_blocklist(match_type, match_value, …)` — the canonical list.
  `match_type ∈ {email, domain, phone, last_name, organization, name}`.
- `owner_blocklist_hits(…)` — every enforcement hit, for audit.
- `users.status / blocked_reason / blocked_at` — account ban flags.

Migrations: sqlite `109_owner_blocklist.sql` + `110_owner_blocklist_seed.mjs`;
postgres `0106` + `0107`. Run `npm run migrate`.

## Seeded (always-on) entries

| Type | Value |
|------|-------|
| last_name | Kemper |
| organization | Van Buren County Sheriff's Office |
| organization | Van Buren County Government |
| organization | McMinnville Fire Department |
| organization | McMinnville EMS |

Re-seed any time: `POST /api/blocklist/seed` (admin).

## Matching rules (the tunable part)

Defined in `backend/services/blocklist/ownerBlocklistService.js → fuzzyRuleMatches()`:

- **email / domain / phone** — exact, normalized. Phone = **last 10 digits**
  (US), so country code / formatting don't matter.
- **last_name** — **token** match: a word in the subject's name OR org must
  equal the surname. `Dana Kemper` ✅, `Kemperton` ❌.
- **organization** — bidirectional **substring** containment. `McMinnville EMS`
  matches `McMinnville EMS Department`.
- **name** — exact normalized equality.

> ⚠️ Surname/org matching can over-block (e.g. an unrelated person named Kemper).
> Tune `fuzzyRuleMatches()` if you need stricter/looser behavior — it's isolated
> for exactly that reason, and covered by `backend/tests/ownerBlocklist.test.js`.

## API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/blocklist` | admin | list entries |
| POST | `/api/blocklist` | admin | add `{ match_type, value, reason?, enforcement? }` |
| DELETE | `/api/blocklist` | admin | remove `{ match_type, value }` |
| POST | `/api/blocklist/seed` | admin | re-apply seed entries |
| GET | `/api/blocklist/hits` | admin | recent enforcement hits |
| POST | `/api/blocklist/ingest` | **ingest token** | bulk device push |
| POST | `/api/blocklist/sync/gmail-filters` | admin | server-side Gmail pull (if configured) |

### Auth tokens

- Admin endpoints: `req.ctx.isAdmin`, or `Authorization: Bearer <ADMIN_TOKEN>` /
  `x-admin-token`.
- Ingest endpoint: `x-blocklist-token: <BLOCKLIST_INGEST_TOKEN>` (falls back to
  `ADMIN_TOKEN`). Set **`BLOCKLIST_INGEST_TOKEN`** in Railway to a long random
  secret used only by your phone/Apps Script.

### Ingest payload (flexible)

```jsonc
POST /api/blocklist/ingest
x-blocklist-token: <token>
{
  "source": "tasker_phone",
  "numbers": ["+1 931 314 0866", "615-555-1212"],   // → phone entries
  "emails":  ["spammer@example.com"],                // → email entries
  "entries": [{ "match_type": "domain", "value": "badco.com" }]
}
```

## Phone → Tasker recipe (Galaxy S25 / CRISPR-CAS9)

Tasker can read the system blocked-numbers list (it requires the
`READ_BLOCKED_NUMBERS` capability via the default-dialer role, or you maintain a
Tasker variable/array of numbers you block through a Tasker shortcut).

1. **Profile**: Time → every 6 hours (or Event → after you block a number).
2. **Task**:
   - `Variable Set %BASE` to `https://<your-railway-host>/api/blocklist/ingest`
   - Build a JSON array `%NUMS` of blocked numbers (one source: read
     `content://com.android.blockednumber/blocked` via a Tasker SQL/Read action,
     or append to a Tasker array each time you block someone).
   - **HTTP Request** action:
     - Method: `POST`
     - URL: `%BASE`
     - Headers:
       `Content-Type:application/json`
       `x-blocklist-token:<BLOCKLIST_INGEST_TOKEN>`
     - Body:
       ```json
       { "source": "tasker_phone", "numbers": %NUMS }
       ```
3. Done — every blocked number lands in `owner_blocklist` as a `phone` entry and
   is enforced everywhere.

> A ready-to-import `.tsk.xml` can be generated the same way as your existing
> Call931 / Forwarded931 Tasker projects.

## Gmail filters → Google Apps Script recipe

This runs on **your** Google account (so it can read your filters) and pushes
the "trash / skip inbox" senders to the ingest endpoint. No server OAuth needed.

```javascript
// Apps Script — Triggers → time-driven, every 6 hours.
function pushGmailBlocksToGrantFlow() {
  const TOKEN = 'YOUR_BLOCKLIST_INGEST_TOKEN';
  const URL = 'https://<your-railway-host>/api/blocklist/ingest';

  // Gmail.Users.Settings.Filters requires the "Gmail API" advanced service (enable it).
  const filters = Gmail.Users.Settings.Filters.list('me').filter || [];
  const emails = [];
  filters.forEach(f => {
    const trashes = f.action && (
      (f.action.addLabelIds || []).indexOf('TRASH') >= 0 ||
      (f.action.removeLabelIds || []).indexOf('INBOX') >= 0
    );
    const from = f.criteria && f.criteria.from;
    if (trashes && from) {
      String(from).split(/\s+OR\s+|[,\s]+/i).forEach(t => { if (t) emails.push(t); });
    }
  });
  if (!emails.length) return;

  UrlFetchApp.fetch(URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-blocklist-token': TOKEN },
    payload: JSON.stringify({ source: 'gmail_filter_sync', emails: emails }),
    muteHttpExceptions: true,
  });
}
```

## Server-side Gmail sync (optional)

If you'd rather have GrantFlow pull, set in Railway and install `googleapis`:

```
GMAIL_OAUTH_CLIENT_ID=...
GMAIL_OAUTH_CLIENT_SECRET=...
GMAIL_OAUTH_REFRESH_TOKEN=...   # scope: gmail.settings.basic (read filters)
```

Then `POST /api/blocklist/sync/gmail-filters`. Without these it returns a clear
`not_configured` message pointing back to the Apps Script.
