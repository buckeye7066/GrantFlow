# Agent sync — 2026-08-20 Hamilton real-portal submit

## Owner directives
- Hamilton should fill **and submit** when the user authorizes automation; stop only for login / CAPTCHA / 2FA / payment / signatures.
- Fixes land on `buckeye7066/GrantFlow@main`.
- Vermilion Church junk-pipeline matching is **deferred** until Hamilton ships.

## Shipped (PR, not yet on main)
- **PR:** https://github.com/buckeye7066/GrantFlow/pull/1286
- **Head:** `cursor/hamilton-real-portal-submit-1839` @ `c7fc1112` (also mirrored on `fix/hamilton-real-portal-submit`)
- **Contract:** public HTTPS + fixture allowed; private/loopback/metadata blocked; browser automation + auto-submit default ON; UI `hamilton-autopilot-v2` submit ON / review OFF.

## VERIFIED
- Local (cloud agent): 20 tests across `hamiltonControlledBetaBrowserBoundary`, `portalSyncRequiresSession`, `hamiltonBrowserAutomationGuard`, `HamiltonAutopilotAuthorization`.

## Blocked
- Squash-merge to `main` rejected: required Actions checks fail immediately (account billing / spending limit). Auto-merge armed; will land when Actions can run or owner bypasses protection.

## In-flight / do not redo
- Do not re-impose fixture-only controlled-beta refuse for real public HTTPS.
- Next after merge: Vermilion Church need-aligned matching (institutional NOFO flood).

## Traps
- Portal sync still must **not** click Submit (`portal_sync_submit_not_supported`).
- SSO portals without a captured session still `needs_session` (honesty gate) — not a browser ban.
- `Number(null)===0` class and rolling match-store traps elsewhere are unrelated; leave alone.
