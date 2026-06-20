# Hamilton Session Capture

Give Hamilton a **live, authenticated session** to a school portal so she can
submit applications inside your real account — for **any profile, any school**.

This solves the 2FA problem: Hamilton never intercepts 2FA codes. Instead, **you**
log in and clear 2FA once in a real browser window, and this tool hands the
resulting session (cookies + per-origin storage) to GrantFlow, where it is stored
**AES-256-GCM-encrypted** and reused by Hamilton. Sessions expire, so re-run this
when prompted (the calendar's "be available" flag tells you when a run will need
a fresh login).

## One-time setup

```bash
node tools/hamilton-session-capture/capture.mjs \
  --api-base   https://grantflow-production.up.railway.app \
  --token      <your GrantFlow access token> \
  --profile-id <profile uuid> \
  --portal-host <portal host, e.g. mtsu.edu> \
  --login-url   <where you log in, e.g. https://login.microsoftonline.com/> \
  --label       "MTSU SSO" \
  --expires-days 14
```

A browser window opens at the login URL. **Log in and complete 2FA**, navigate
until you are fully signed in, then return to the terminal and press **Enter**.
The session uploads and Hamilton can immediately reuse it.

### Per-profile examples

| Profile   | `--portal-host`        | `--login-url`                          |
|-----------|------------------------|----------------------------------------|
| Anastasia | `mtsu.edu`             | `https://login.microsoftonline.com/`   |
| Robert    | `clevelandstatecc.edu` | `https://www.clevelandstatecc.edu/`    |

> The captured `storageState` is multi-domain — one capture covers the SSO
> provider (`login.microsoftonline.com`) **and** the school host, so a single
> session row works for the whole login flow.

## How Hamilton uses it

When `use_saved_session` is authorized for the run, the orchestrator resolves the
valid session for the portal host, decrypts the storageState in memory, and
passes it straight to Playwright (`browser.newContext({ storageState })`). If no
valid session exists, the run flags **login/2FA required** so you can re-capture
and stand by.

## Getting an access token

Log into GrantFlow in your browser and copy the bearer token from the
`Authorization` header of any `/api/...` request (DevTools → Network), or from the
app's stored auth. The token must belong to the profile owner or an admin.
