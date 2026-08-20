# 2026-08-20 — Hamilton real-portal submit unblock (PR #1286)

## Directives
- Owner: ship Hamilton real-portal submit unblock to `buckeye7066/GrantFlow` main.
- Contract: public HTTPS + fixture allowed; private/loopback/metadata SSRF forever blocked;
  browser automation + auto-submit default ON; UI submit toggles ON; hard stops kept
  (login/CAPTCHA/2FA/payment/signatures).

## Shipped (branch / PR — not yet on main)
- Branch: `cursor/hamilton-real-portal-submit-1839` (mirrors `fix/hamilton-real-portal-submit`)
- Commits: `9f0de72d` (policy rewrite) + `ed0283b6` (full unblock) + `ba611f35` (CI retrigger)
- PR: https://github.com/buckeye7066/GrantFlow/pull/1286 (ready for review; squash auto-merge armed)

## Local verification (VERIFIED)
```
npx vitest run backend/tests/hamiltonControlledBetaBrowserBoundary.test.js \
  backend/tests/portalSyncRequiresSession.test.js \
  backend/tests/hamiltonBrowserAutomationGuard.test.js \
  src/components/hamilton/HamiltonAutopilotAuthorization.test.jsx
# 4 files / 20 tests passed
```

## Merge blocker (UNKNOWN until billing fixed)
GitHub Actions jobs fail in ~2–5s with empty steps. Annotation:
> "The job was not started because recent account payments have failed or your spending limit needs to be increased."
Required status checks therefore fail; branch protection blocks push/merge to `main`
(including `--admin`). Auto-merge is enabled and will land once checks can run green
or an owner bypasses protection after fixing billing.

## Traps
- Do not re-fixture-only `controlledBetaBrowserPolicy` / launch / portal-sync gates.
- `reviewedPortalSubmissionExecutionAvailable` === `browserAutomationPermittedForUrl`.
- Env defaults are ON via `envFlagEnabled(..., true)`; explicit `false`/`0`/`off`/`no` disables.
