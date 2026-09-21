# Selected-profile production acceptance

GrantFlow remains the sole application in scope. The full functional scope in
`2026-09-21-billing-crawler-resumption.md` remains open; exact-50 is retired.

## CHANGED

- PR #1793 merged through the guarded script after all 21 reported checks settled
  without failures and both `test` and `test-suite` passed. This ships atomic
  billing delivery, quote ownership checks, recurring reactivation rollback,
  PostgreSQL concurrency coverage, specific-need query forwarding, and isolated
  SQLite defaults for test workers.
- The signed-in browser found an Anya conversation create/reopen defect: the
  app sent the selected business profile but server context retained the
  sign-in default. The new conversation appeared in the list and returned 404
  on reopening. Request context now honors the selected-profile header only
  after database-backed access validation. Unauthorized selections return 403.
  Auth bootstrap/refresh/logout and unresolved identities keep their existing
  behavior. SQL scope, Anya and entitlements consume the same context.

## VERIFIED

- The owner browser is authenticated. Owner AI status reports an online, ready
  Codex subscription bridge. This does not yet prove a completed Anya reply.
- Two selected-profile unit regressions failed before the fix with the old
  profile retained. Context/actor-role suites passed after the fix (25 tests).
- Conversation creation/reopen, message listing, previous-profile isolation,
  unauthorized selection and authenticated default passed through the actual
  Express application. Adjacent identity and Anya resolver suites passed.
- The earlier full local run passed 3,412 node tests. Its Vitest workers picked
  up the two new intentionally failing profile regressions before the repair:
  10,994 passed, two failed, four skipped. That mixed-tree run is not a clean
  final gate. Exact billing PR head passed its complete CI gates independently.

## UNKNOWN / ongoing

The selected-profile fix needs its own complete gates, deployment and live
retest. A real Axiom BioLabs discovery job was requested through the owner browser
(`fb1a1fcf-67b1-4bf2-b2e2-0c02800cdd6a`); enqueue success is not discovery success.
Production local inference previously timed out on full-page extraction despite
passing a tiny prompt after restart. No production-ready claim or external
submission confirmation is justified yet.
