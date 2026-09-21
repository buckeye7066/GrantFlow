# Signup bootstrap identity and crawler receipts

Owner priority for this continuation: discovery/matching quality, unfinished
auth and signup work, then Hamilton automation.

## Changed

The existing crawler-doctor work exposes the profile's retained web-lane
execution receipt alongside its next-query plan. Its regression fixture used
an array where the telemetry contract requires planned/executed/skipped buckets.
The repaired test verifies executed versus budget-skipped queries, counts,
timestamp, isolation from another profile, and a null receipt when absent.

The browser signup journey reproduced a business profile being asked about
household financial need after reload. The pending login-query change retained
primary_type and created_by, but the separate GET /api/auth/me bootstrap query
still omitted both. Both bootstrap branches now retain the fields consumed by
the shared completion-gate resolver. Authorization predicates are unchanged.
A failing-first integration test asserts business questions after bootstrap;
the login test also checks two owned identities and excludes another user's
profile from the payload.

The Discover browser test's exact profile-option label ignored the linked
organization suffix. It now selects the named seeded profile with that suffix
allowed and uses Playwright waiting instead of repeated forced clicks.
The journey also targets the current Funding discovery automation card and
asserts the queue POST succeeds. Profile switching uses the current accessible
label, Active funding profile. These replace obsolete selectors without
removing the discovery-result, queue, or profile-persistence assertions.
The catalog-page assertion now matches its Browse grant opportunities heading.

## Verified

- Crawler doctor/query-budget/web-lane receipt suites: 29 passed.
- Discovery relevance, declared needs, loan classification, auth, and Hamilton
  logic batch: 146 passed; four browser tests initially skipped for a missing
  browser were subsequently exercised in the Hamilton batch below.
- Hamilton signup real-browser, authorized-submit, and submission-authority
  batch: 33 passed with an isolated Playwright browser installation.
- Auth bootstrap, login recording, and completion-gate batch after the repair:
  28 passed. The new bootstrap regression failed before the production fix.
- Targeted ESLint and auth middleware check passed.

The full Foundation signup journey passed in Chromium: account creation,
independent password login, required answers, business completion, personal /
business switching, and persisted selection after reload. The corrected broader
app journey also passed: admin login, profile creation, document profile
selection, nonzero discovery results, source directory, an accepted automation
POST and visible queue, pipeline, and catalog. These are local seeded journeys,
not production source-quality or paid extraction acceptance. Both browser
journeys passed in their final runs; the broader app run exited 0.

## Unknown

No new real funding application, external submission confirmation, production
deployment, or live discovery acceptance is established. Specific-need search
quality remains the live gap described in the earlier source-evidence handoff.
No paid setup request, email delivery, or production profile mutation was used.
