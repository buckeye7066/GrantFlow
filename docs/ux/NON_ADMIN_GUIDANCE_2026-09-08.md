# Non-admin guidance and saved-work reliability

## Scope

This change improves the existing GrantFlow workspace. It does not introduce
new pricing, alter payment prerequisites, remove non-admin tools, change the
matching engine, or grant new server-side permissions. The administrator's
navigation and workflow remain in place.

## Implemented journey

The non-admin page guide explains the current destination, shows the active
funding profile, provides a direct Help link, and offers an expandable overview:
About you, Find funding, Review and save, Prepare and apply, Track results.
It is an explanation of the journey, not fabricated application progress or a
mandatory wizard. All 23 non-admin navigation destinations have descriptions in
the existing canonical Help Registry. The Help Center searches these same tools
and provides written instructions without an AI request. Anya chat opens on
request, and suggested questions fill the composer rather than silently sending.

My Profile links carry the active profile identifier. Profile editors keep
entered text after a failed or partially rejected save, report save state in the
page and dialog, and warn before discarding unsaved edits. Existing field
metadata, relevance rules, canonical questions, and writer services are reused.

## One next-action policy

`src/lib/dashboardNextAction.js` is a pure presentation policy used by the
non-admin dashboard hero and supplied to its embedded assistant. It prioritizes:

1. Unavailable profile or unconfirmed data, with an honest recovery state.
2. An application task requiring attention.
3. An approaching deadline, linking to the relevant source when available.
4. Current task or unfinished application work.
5. Location or profile gaps, with the exact section link.
6. Saved-work synchronization or review of saved opportunities.
7. Review of a source, tracking existing outcomes, or starting discovery.

Foreign-profile task and grant rows cannot become the suggested action. A queued
task is not labeled as running. Submitted records are tracked, not offered as
new applications. Existing admin policy behavior remains regression tested.

## State and safety

Navigation preferences are keyed by account and workspace. Resume paths are
profile-scoped on the server and account/profile-scoped in browser storage.
Internal resume links are validated against current routes and known records;
external URLs, foreign profile IDs, and unvalidated record IDs are rejected.

The saved-grants store confirms server writes before showing a successful save
or replacing a saved note. Failed intent is retained for explicit retry. Reads
started under an earlier account/profile or before a write cannot overwrite the
current confirmed result. Synchronization does not re-upload arbitrary cached
bookmarks and resurrect a source that was removed on another device. Loading,
failure, and an empty synchronized result are distinct states.

Pipeline task status uses the shared lifecycle classification, including
queued, waiting, needs-attention, and terminal states. Existing single-active-task
safeguards remain. Opening a portal, preparing a packet, and clicking a submission
control are not portrayed as confirmation. Potential totals exclude recorded
awards; awards use the recorded awarded amount rather than an estimate.

The existing onboarding sequencer now has a non-admin presentation. Mandatory
welcome content remains first, and the required-profile gate retains authority.
The optional introduction is inline, dismissible, and replayable through Help.
The owner-configured reset still uses its existing video and gap interview.

## Accessibility and language

Page guidance and help use visible labels, keyboard-accessible links, wrapping
layouts, and comfortably sized controls. Non-admin breadcrumbs stay visible on
mobile without linking to the hidden admin profile list. New journey labels use
the existing translation fallback. Other language page bodies remain partially
translated; this work does not claim complete multilingual coverage.

## Verification

Evidence comes from automated checks and controlled browser walkthroughs, not
human usability research or proof of real funding awards. The isolated browser
fixture creates a fresh temporary SQLite database and loopback-only server. It
uses real application password authentication and server authorization, not an
admin-token impersonation of an end user. Fixture users cover nonprofit,
business, individual, family, and student profiles. Their no-charge fixture
billing does not modify production billing.

Commands and final results are recorded in the pull request and completion
report. Dedicated tests cover next-action precedence, loading/error handling,
profile isolation, safe resume URLs, confirmed writes, retries, concurrent
writes, stale responses, and preservation of the authorized non-admin toolset.
Browser evidence is stored under `docs/ux/evidence/non-admin-20260908/`.

Verified during implementation: 3,233 Node tests, 20 focused Vitest tests, and nine authenticated browser journeys passed. The complete Vitest suite and exact pull-request CI outcomes are reported separately, rather than inferred from these focused checks.

The final local pre-push chain passed, including auth/profile/runtime/environment/native-platform guards, lint, type checking, and build. The broad Vitest run passed 9,171 tests but initially failed to load the existing SavedGrants test because its mocks lacked the new auth dependency. The mock was updated without removing assertions; that test and the administrator onboarding test then passed in a 25-test focused rerun. The broad run also reported six worker logging teardown rejections from the administrator onboarding file; the focused rerun reported none. Required exact-head CI remains the merge authority.
