# Hamilton verification-code forwarding (Tasker) — SMS **and email**

**Purpose.** Under full automation Hamilton registers portal accounts with his OWN
email and phone (`backend/config/hamiltonIdentity.js`), because a verification
code sent to a mailbox nobody reads is the wall that turned every unattended
signup into a human handoff. Nothing in this product can reach a handset, so the
only way a code that arrives on the phone becomes readable is if the phone posts
it to GrantFlow itself.

The owner's phone runs **both** the messaging app **and Outlook signed in to
`Hamilton@axiombiolabs.org`**, so Tasker covers **both channels**:

| Channel | Tasker trigger | Completeness |
| --- | --- | --- |
| **SMS** | `Received Text` | **Complete.** `%SMSRB` is the FULL message body — SMS is never truncated. |
| **Email** | `Notification` (Outlook) | **Preview only** by default. See the ladder in §4. |

Because email codes can now arrive this way, the Microsoft Graph app
registration is **no longer required** for 2FA — it is an optional Tier‑3
fallback (§4).

Tasker does that in one profile. Nothing is ever sent back to the phone; the
route only stores what the phone chose to forward.

Verified on the owner's device 2026-08-20: `SM-S938U`, Android 16, serial
`R5CY52E8P6D`, Tasker (`net.dinglisch.android.taskerm`) installed with
`RECEIVE_SMS` and `READ_SMS` **granted**. The device reached
`https://grantflow-production.up.railway.app/api/hamilton/automation/sms-inbox`
and got `503 sms_ingest_disabled`, which proves the route is live and only the
server-side token is missing (see "Server prerequisites").

---

## 1. Server prerequisites

| What | Where | Status |
| --- | --- | --- |
| `HAMILTON_SMS_INGEST_TOKEN` | local dev: repo-root `.env` (gitignored) + a persistent user env var (`setx`) | **set 2026-08-20** |
| `HAMILTON_SMS_INGEST_TOKEN` | **production: Railway service variables** | **NOT SET — owner action** |

With the variable unset the route is **DISABLED**, not open: it answers
`503 {"error":"sms_ingest_disabled"}`. An unauthenticated write endpoint that
silently accepts anything would be worse than one that does not exist.

**Generate a production value** (do this first — use a DIFFERENT value from the
local-dev one, and put the production value into Tasker, not the dev value):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

**Set it on Railway — CLI** (from the repo root; the service is the backend):

```bash
railway link                       # once, if this shell is not linked yet
railway variables --set "HAMILTON_SMS_INGEST_TOKEN=PASTE_THE_GENERATED_VALUE"
railway redeploy                   # or: railway up
```

To confirm it took (the value is masked in the listing):

```bash
railway variables | grep HAMILTON_SMS_INGEST_TOKEN
```

**Set it on Railway — dashboard:** project → the **backend** service →
**Variables** tab → **New Variable** → Name `HAMILTON_SMS_INGEST_TOKEN`, Value
the generated string → **Add** → **Deploy** the change.

Verify from any machine — an unauthenticated probe must flip from `503` to
`401`, which proves the token is set without revealing it:

```bash
curl -s -X POST https://grantflow-production.up.railway.app/api/hamilton/automation/sms-inbox   -H 'Content-Type: application/json' -d '{"body":"probe"}'
# before: {"ok":false,"error":"sms_ingest_disabled",...}
# after:  {"ok":false,"error":"unauthorized",...}
```

Treat the token like a password: it is the only thing standing in front of a
write endpoint. Rotate it by changing the Railway variable and the Tasker header
together.

---

## 2. The exact URL to use

| Target | URL |
| --- | --- |
| **Production (use this on the phone)** | `https://grantflow-production.up.railway.app/api/hamilton/automation/sms-inbox` |
| Local dev, same Wi-Fi | `http://192.168.1.104:8080/api/hamilton/automation/sms-inbox` |
| Local dev, over Tailscale | `http://100.95.159.8:8080/api/hamilton/automation/sms-inbox` |

`127.0.0.1` will **not** work from the phone — that is the phone's own loopback.
The LAN address changes with the network; the Tailscale address does not.

There is also a back-compat alias at `/api/yana/automation/sms-inbox`. Prefer the
`hamilton` path.

---

## 3. Profile A — SMS codes (`Received Text`)

Create this once in Tasker (**Profiles → + → Event → Phone → Received Text**).

### Profile

| Field | Value |
| --- | --- |
| Profile name | `Hamilton SMS Codes` |
| Event category | **Phone** |
| Event | **Received Text** |
| Type | `SMS` |
| Sender | *(leave blank — portals send from short codes and rotating numbers)* |
| Content | *(leave blank — see "Optional narrowing" below)* |

### Task

Name the task `Hamilton Forward SMS`, then add ONE action:

**Action: Net → HTTP Request**

| Field | Value |
| --- | --- |
| Method | `POST` |
| URL | `https://grantflow-production.up.railway.app/api/hamilton/automation/sms-inbox` |
| Headers | `x-hamilton-sms-token:YOUR_TOKEN_HERE`<br>`Content-Type:application/json` |
| Body | `{"from":"%SMSRF","body":"%SMSRB","received_at":"%TIMES"}` |
| Timeout | `30` |
| Continue Task After Error | ✅ **on** |

> **Headers field format.** Tasker's HTTP Request action takes headers as
> `Name:Value`, **one per line**. Enter the two lines exactly as shown, with the
> token pasted in place of `YOUR_TOKEN_HERE`.

> **Older Tasker (`HTTP Post` action) equivalent:**
> Server:Port `grantflow-production.up.railway.app`, Path
> `/api/hamilton/automation/sms-inbox`, Data/File the JSON body above,
> Content Type `application/json`, Extra Headers
> `x-hamilton-sms-token:YOUR_TOKEN_HERE`.

### The Tasker variables used

| Variable | Meaning |
| --- | --- |
| `%SMSRF` | the sender ("SMS Received From") |
| `%SMSRB` | the message text ("SMS Received Body") |
| `%TIMES` | seconds since epoch at the time of the event |

`%TIMES` is a Unix seconds value, not an ISO timestamp. **That is fine** — the
route accepts an unparseable `received_at` and substitutes the server's own
`now()`. A bad stamp can therefore only ever make a code look *newer*, never
older, so a stale code can never be smuggled in as fresh. If you would rather
send a precise stamp, add a `Variable Set` action before the HTTP Request:

```
Variable Set  %HTS  To: %DATE %TIME
```

…and use `"received_at":"%HTS"`. It is not required.

> **SMS is not truncated.** `%SMSRB` carries the whole message body, so nothing
> in the email ladder below applies to this profile. There is no "Tier 2" for
> SMS because there is nothing missing to go and fetch.

### Optional narrowing

If you would rather forward only likely code messages instead of every text, set
the profile's **Content** field to a Tasker regex match:

```
.*(verification|security|one-time|passcode|confirmation|authentication|login|OTP|code).*
```

This is a trade-off: it reduces what leaves the phone, but a portal that words
its message unusually will be missed. The server-side extractor is already
conservative — it requires a code CUE near the digits and refuses to read an
award amount, a deadline, or a reference number as a code
(`backend/services/hamilton/hamiltonVerificationCodes.js`), so forwarding
everything is safe from a *wrong-code* standpoint.

---

---

## 4. Profiles B–D — EMAIL codes (the ladder)

Outlook's **notification** is the cheap way in, but a notification carries a
**truncated preview**, so a code sitting below the fold never leaves the phone.
That is a real failure, not a theoretical one — it is reproduced verbatim in §5.

Three tiers, most reliable per unit of effort first. **Start with Tier 1.** Add
Tier 2 only if a real portal's code turns out to be below the fold.

All tiers POST the **same shape** to the **same endpoint**; only the `body` gets
fuller. **No server change is needed to move between them** — verified by
posting all three shapes against the running backend (§5).

### Tier 1 — expanded notification text *(recommended starting point)*

No accessibility permission, no app interaction, nothing opens on screen.

**Profile:** Event → **UI** → **Notification**
| Field | Value |
| --- | --- |
| Profile name | `Hamilton Email Codes` |
| Owner Application | **Outlook** |
| Title / Text | *(leave blank, or use the code-ish filter below)* |

**Task — action 1 (optional but recommended): Variable Set**

Outlook posts a big-text / inbox-style notification, so a longer field is often
already available. Prefer the **LONGEST non-empty** of what you have:

| Source | Variable |
| --- | --- |
| Tasker built-in Notification event | `%NTITLE`, `%NTEXT`, `%NSUBTEXT` |
| AutoNotification (if installed) | `%anbigtext`, `%antextlines`, `%antext` |

With AutoNotification, set `%HBODY` to the longest available:

```
Variable Set  %HBODY  To: %anbigtext        If %anbigtext is Set
Variable Set  %HBODY  To: %antextlines      If %HBODY is not Set
Variable Set  %HBODY  To: %NTEXT            If %HBODY is not Set
```

Without AutoNotification, just use `%NTEXT` directly.

**Task — action 2: Net → HTTP Request**

| Field | Value |
| --- | --- |
| Method | `POST` |
| URL | `https://grantflow-production.up.railway.app/api/hamilton/automation/sms-inbox` |
| Headers | `x-hamilton-sms-token:YOUR_TOKEN_HERE`<br>`Content-Type:application/json` |
| Body | `{"channel":"email","from":"%NTITLE","subject":"%NTITLE","body":"%HBODY","received_at":"%TIMES"}` |
| Timeout | `30` |
| Continue Task After Error | ✅ on |

*(No AutoNotification? Use `"body":"%NTEXT"`.)*

**Why Tier 1 catches most 2FA mail:** the code is usually in the SUBJECT or the
first line or two, and the server searches the **subject first, then the body**.
`%NTITLE` is Outlook's notification title, which is the message subject — so
"481920 is your AwardSpring code" is captured by Tier 1 alone.

### Tier 2 — actually OPEN the email *(only if Tier 1 misses)*

This is the tier that removes the truncation caveat, at a real cost.

**Cost, stated plainly:**
- **AutoInput is a PAID plugin** and requires **Accessibility permission**.
- **It physically opens Outlook on the device.** Do not run it while the phone
  is in your hand or you will fight it for the screen. Guard it (below), and
  expect it to do nothing useful while the phone is locked — a locked device
  will not render the message for AutoInput to read.
- **Screen scraping is brittle.** An Outlook redesign can break the UI query
  with no warning; Tier 1 and Tier 3 keep working when it does.

**Profile:** Event → **UI** → **Notification**, Owner Application **Outlook**,
**plus a code-ish guard** so it never fires on ordinary mail. Set the profile's
**Title** filter to a regex match:

```
.*(verification|security|one-time|passcode|OTP|code).*
```

**Task — actions in order:**

| # | Action | Settings |
| --- | --- | --- |
| 1 | **Variable Set** | `%HWAIT` to `2000` *(ms the view needs to settle — tune here, not in the Wait action)* |
| 2 | **AutoNotification Actions** | Action Type `Click`, target the Outlook notification → Outlook opens that message |
| 3 | **Wait** | `%HWAIT` milliseconds |
| 4 | **AutoInput UI Query** | App Package `com.microsoft.office.outlook`; put the result in `%HSCRAPE` (use *Get Text* / the message-body region) |
| 5 | **Variable Set** | `%HBODY` to `%HSCRAPE` — **If `%HSCRAPE` is Set**, else leave the Tier‑1 `%HBODY` |
| 6 | **Net → HTTP Request** | Exactly as Tier 1, with `"body":"%HBODY"` |
| 7 | **Button** | `Back` |
| 8 | **Button** | `Home` *(returns the phone to where it was)* |

Actions 7–8 are not optional politeness — without them the phone is left sitting
in an opened email.

**You do not need to remove the Tier‑1 profile.** Tier 2 posts the same message
again with a longer body, and the server **deduplicates and keeps the longer
text** (§5) — one row, one code, never two.

### Tier 3 — Microsoft Graph *(optional fallback, unchanged)*

If `MICROSOFT_TENANT_ID` / `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` are
set **and** the app registration has `Mail.Read` for
`Hamilton@axiombiolabs.org`, the server reads the mailbox itself and sees the
whole message — no phone involved. With those unset it reports an honest reason
and the forwarded lanes carry on; it is a fallback, **not a prerequisite**.

**Order the server tries:** forwarded rows (SMS + email, newest first) → Graph.

## 5. Proving it works

### From a computer (already verified locally, 2026-08-20)

```bash
curl -i -X POST http://127.0.0.1:8080/api/hamilton/automation/sms-inbox \
  -H 'Content-Type: application/json' \
  -H 'x-hamilton-sms-token: YOUR_TOKEN_HERE' \
  -d '{"from":"+18775550142","body":"AwardSpring: Your verification code is 481920. It expires in 10 minutes.","received_at":"2026-08-21T01:44:39.835Z"}'
```

Expected:

```
HTTP/1.1 202 Accepted
{"ok":true,"received_at":"2026-08-21T01:44:39.835Z"}
```

### From the phone

In Tasker, long-press the task and hit **Play**. With no real SMS in flight the
Tasker variables are empty, so the route answers `400 body_required` — that
still proves URL + token are right. To test for real, have someone text the
phone anything containing e.g. "Your verification code is 481920".

### Response codes and what each means

| Code | Meaning |
| --- | --- |
| `202` | stored — `{"ok":true,"received_at":"...","channel":"sms","deduped":false}`. The message is never echoed back. |
| `400 body_required` | the POST carried no message text (`%SMSRB` / `%HBODY` was empty) |
| `400 invalid_channel` | `channel` was neither `sms` nor `email` |
| `401 unauthorized` | the `x-hamilton-sms-token` header is missing or wrong |
| `503 sms_ingest_disabled` | the server has no `HAMILTON_SMS_INGEST_TOKEN` set |

`deduped: true` means this post matched a recent message with the same channel +
subject + sender. The stored text is replaced only when the new copy is
**strictly longer**, which is exactly what makes the Tier‑1 → Tier‑2 upgrade
safe.

### The EMAIL ladder, measured (2026-08-20, live against the running backend)

This is the before/after that justifies Tier 2's complexity.

**A truncated Outlook preview — the code is cut off:**

```
POST /api/hamilton/automation/sms-inbox
{"channel":"email","from":"AwardSpring","subject":"Verify your AwardSpring account",
 "body":"Hi Dana, thanks for creating an AwardSpring account. Before you can start your
 application we need to confirm this address belongs to you. Please enter the verific",
 "received_at":"2026-08-21T02:40:33.207Z"}

HTTP/1.1 202 Accepted
{"ok":true,"received_at":"2026-08-21T02:40:33.207Z","channel":"email","deduped":false}
```

`findVerificationCode` then returns **no code, and says why**:

```json
{ "code": null,
  "reason": "phone (sms+email): no fresh verification code forwarded by the phone (sms+email) | graph email: no Graph token provider configured" }
```

**The SAME mail, opened and fully scraped (Tier 2):**

```
POST /api/hamilton/automation/sms-inbox
{"channel":"email","from":"AwardSpring","subject":"Verify your AwardSpring account",
 "body":"... Please enter the verification code 481920 on the confirmation screen.
 This code expires in 10 minutes. ...","received_at":"2026-08-21T02:41:04.476Z"}

HTTP/1.1 202 Accepted
{"ok":true,"received_at":"2026-08-21T02:41:04.476Z","channel":"email","deduped":true}
```

**Deduplication:** still ONE row, body grown 158 → 289 chars, and the ORIGINAL
`received_at` kept (a repost must never refresh the clock, or a stale code could
be smuggled in as fresh). `findVerificationCode` now returns:

```json
{ "code": "481920", "source": "email_forwarded", "channel": "email",
  "receivedAt": "2026-08-21T02:40:33.207Z", "subject": "Verify your AwardSpring account" }
```

**Tier 1 alone is enough when the code is in the SUBJECT** — body still
truncated, code still found, because the subject is searched first:

```json
{ "code": "224180", "source": "email_forwarded", "channel": "email",
  "subject": "224180 is your Scholarship America verification code" }
```

---

## 6. What happens to a forwarded message

1. The route stores `{channel, sender, subject, body, received_at}` in
   `hamilton_inbound_sms` (migrations `176`/`0181`, generalized to carry
   `channel` + `subject` by `178`/`0183`). The table keeps its original SMS name
   so the shipped route and any existing Tasker profile keep working; `channel`
   is what carries the meaning now.
2. A repost of the same `(channel, subject, sender)` inside
   `HAMILTON_INBOX_DEDUP_WINDOW_MS` (5 min) **replaces** the stored text when
   the new copy is strictly longer, and is otherwise dropped.
3. `readForwardedCode` reads only rows newer than `CODE_MAX_AGE_MS`
   (10 minutes) — a stale code is worse than none — and searches the
   **subject first, then the body**.
4. `extractVerificationCode` pulls the code out **only** when a code CUE
   ("verification code", "one-time passcode", "your code is", "OTP", …) sits
   within 60 characters of the digits.
5. `findVerificationCode` tries the forwarded rows (SMS + email together,
   newest first), then Hamilton's Graph mailbox, and carries EVERY lane's
   failure reason back so a miss is explainable.
6. `hamiltonVerificationGate.pollForVerificationCode` asks a **bounded** number
   of times (default 5 attempts, 20s apart; hard ceiling 10 attempts / 60s) and
   the signup adapter types the code that actually arrived.
7. If no code arrives, the existing `needs_user` handoff applies unchanged. A
   code is **never** fabricated.

---

## 7. Privacy and limits

- The forward is **one-way**. There is no code path in this product that can send
  a text or read anything the phone did not forward.
- The route is behind a shared secret because Tasker posts from a phone with no
  cookie jar. Treat the token like a password; rotate it by changing both the
  server variable and the Tasker header.
- Rows in `hamilton_inbound_sms` hold real message text — and with the email
  lanes on, real **email** text from Hamilton's mailbox. Forward only the
  device's own messages, and consider the code-ish filters above. Tier 2 in
  particular scrapes whatever the opened message shows, so scope its profile
  filter narrowly.
- Identity **proofing** (SSN, government ID, FSA ID, Login.gov, ID.me) is a
  different thing from a one-time code and still hands off to a human. Reading a
  code sent to your own number never authorizes impersonating someone to an
  identity proofer, and the portal-identity state machine keeps that line.
