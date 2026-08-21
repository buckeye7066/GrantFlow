# Hamilton SMS code forwarding (Tasker)

**Purpose.** Under full automation Hamilton registers portal accounts with his OWN
email and phone (`backend/config/hamiltonIdentity.js`), because a verification
code sent to a mailbox nobody reads is the wall that turned every unattended
signup into a human handoff. The email half is read over Microsoft Graph. **The
SMS half needs the phone to forward the text**, because nothing in this product
can reach a handset — the only way a code that arrives by SMS becomes readable
is if the phone posts it to GrantFlow itself.

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

To enable production, set the same style of value on the Railway backend
service and redeploy:

```
HAMILTON_SMS_INGEST_TOKEN=<a 32-byte random string>
```

Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Use a **different** value in production from the local-dev one, and put the
production value into Tasker (below) — not the dev value.

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

## 3. The Tasker profile — copy/paste ready

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

## 4. Proving it works

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
| `202` | stored — `{"ok":true,"received_at":"..."}`. The message is never echoed back. |
| `400 body_required` | the POST carried no message text (`%SMSRB` was empty) |
| `401 unauthorized` | the `x-hamilton-sms-token` header is missing or wrong |
| `503 sms_ingest_disabled` | the server has no `HAMILTON_SMS_INGEST_TOKEN` set |

---

## 5. What happens to a forwarded message

1. The route stores `{sender, body, received_at}` in `hamilton_inbound_sms`
   (migrations `176_hamilton_inbound_sms.sql` / `0181_hamilton_inbound_sms.sql`).
2. `readSmsCode` reads only rows newer than `CODE_MAX_AGE_MS` (10 minutes) —
   a stale code is worse than none.
3. `extractVerificationCode` pulls the code out **only** when a code CUE
   ("verification code", "one-time passcode", "your code is", "OTP", …) sits
   within 60 characters of the digits.
4. `findVerificationCode` tries SMS first, then Hamilton's Graph mailbox, and
   carries BOTH channels' failure reasons back so a miss is explainable.
5. `hamiltonVerificationGate.pollForVerificationCode` asks a **bounded** number
   of times (default 5 attempts, 20s apart; hard ceiling 10 attempts / 60s) and
   the signup adapter types the code that actually arrived.
6. If no code arrives, the existing `needs_user` handoff applies unchanged. A
   code is **never** fabricated.

---

## 6. Privacy and limits

- The forward is **one-way**. There is no code path in this product that can send
  a text or read anything the phone did not forward.
- The route is behind a shared secret because Tasker posts from a phone with no
  cookie jar. Treat the token like a password; rotate it by changing both the
  server variable and the Tasker header.
- Rows in `hamilton_inbound_sms` hold real message text. Forward only the
  device's own texts, and consider the optional content narrowing above.
- Identity **proofing** (SSN, government ID, FSA ID, Login.gov, ID.me) is a
  different thing from a one-time code and still hands off to a human. Reading a
  code sent to your own number never authorizes impersonating someone to an
  identity proofer, and the portal-identity state machine keeps that line.
