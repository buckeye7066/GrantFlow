# GrantFlow production-readiness resumption

The owner clarified that this session's sole application is GrantFlow. Do not
resume a portfolio queue or interpret an earlier handoff as excluding this repo.
The exact-50 acceptance exercise remains retired by the September 21 directive.

## Scope still required

Profile-derived and free-text item searches; company funding discovery backed by
sources; billing tiers and add-ons; Anya profile context and owner-only authority;
Amy weakness-driven cohorts, crawler receipts, learning and cleanup; Sam source
coverage and repair; Yana leads; John tailored drafting; Robert profile matching;
and Hamilton preparation, profile-to-form mapping, required formats, continuation
and confirmation evidence. A build or route-loading pass is not proof of these
complete workflows. Preserve source reality, relevance, need fit and eligibility.

## CHANGED

- Merged PRs #1786 and #1792 through the repository's guarded merge script after
  required CI passed. These repair retry labels for reference records and add
  PostgreSQL notification storage. Reconciled both with preserved local work.
- Specific-need searches now forward the entered need into the canonical
  discovery query lane; stored profile facts still control matching decisions.
- Stripe signature validation precedes schema work. Fulfillment and the event
  receipt share one transaction. Failed writes and unresolved account/price
  mappings leave delivery retryable. Unpaid checkouts wait for settlement;
  asynchronous payment success is handled. Quote/profile mismatches are refused.
- Subscription state and event watermarks are read under a PostgreSQL account
  lock. Concurrent older events cannot overwrite a newer cancellation.
- The PostgreSQL transaction wrapper rejects a COMMIT response whose command is
  ROLLBACK. A swallowed SQL error cannot report durable success to callers.
- The existing PostgreSQL CI job runs the disposable-schema billing integration
  suite, including real lock contention and swallowed audit-write failure.

## VERIFIED

- Focused Vitest pass: 41 tests for webhook delivery, item-search forwarding and
  pipeline promotion. The earlier self-heal suite passed on isolated rerun.
- Local PostgreSQL 16 pass: transaction rollback/retry, concurrent duplicates,
  competing subscription and invoice events, and rolled-back COMMIT detection.
  Failed-payment ordering and rolled-back COMMIT regressions failed before their
  corresponding repairs. No payment provider call or customer charge was made.
- Railway deployed `2c52e1be395dc309ee27fb9071bf0e147163e338`. Authenticated
  read-only health checks returned 200 on health, readiness and data readiness.
  Health honestly retains one crawler failure in its 24-hour window.

## UNKNOWN / ongoing

Full current-tree suites and final billing/crawler PR deployment remain pending.
The previous model process was stuck unloading and timed out on a four-token
request. After deployment the same bounded local-only request succeeded; this is
not proof of full-page extraction, sustained availability or crawler quality.
Live multi-source discovery, provider-dependent agent functions, end-user billing
and confirmed external submission still require evidence. Existing notification
and route tests do not certify every user journey or every native platform.
