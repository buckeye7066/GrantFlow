# Owner advertisements and safe app sharing

## Changed

- GrantFlow's authenticated layout carries an inline, clearly labeled
  Advertisement slot. Only currently published, scheduled creatives are returned.
  It does not interrupt grant work and is excluded from printing. No application,
  letter, report, profile, matching, crawler, or export data model is changed.
- The owner manager supports one to eight distinct raster uploads per batch,
  advertiser/headline/plain-text body/HTTPS destination, 15/30/custom seconds,
  week/two-week/month/custom dates, and edit/pause/remove for each creative.
  Images, schedules, and counters live in the existing database, independently
  of ephemeral deployment filesystems. Additive SQLite/Postgres migration 1005
  and the schema-invariant registry share the same table definitions.
- Management requires the server-configured `ADVERTISING_OWNER_USER_ID` to match
  the authenticated immutable user ID AND current `users.is_admin` authority.
  Names, emails, generic admin/developer labels, service tokens, and profile
  bearer tokens cannot grant management. Missing configuration fails closed.
  Set this private variable only after verifying the actual owner's existing
  account against deployment configuration and the authoritative database.
- The browser requests a cryptographically random, database-issued display
  ticket only after a loaded image is at least 50% visible in the foreground.
  An impression then waits a continuous 1.1 seconds. The server independently
  enforces account/creative binding, minimum one-second dwell, bounded expiry (at least two minutes, extended for
  longer custom slides),
  and one event of each kind per ticket. A second unique constraint deduplicates
  repeated tickets within a 30-second creative/viewer window. Clicks require an
  impression for the same ticket. Owner previews are excluded on the server.
- Analytics return real aggregate impressions, clicks, pseudonymous account
  unique-viewer counts, and per-creative daily counts. Raw account IDs, profiles,
  IP addresses, and grant data are never returned in analytics. Browser-reported
  visibility is not fraud-proof; signed-in automated traffic can affect counts.
- The sidebar's Share GrantFlow action sends only the fixed public welcome URL.
  It never copies the current route, selected profile, account details, tokens,
  or session. Recipients authenticate with their own accounts.

## Verified locally

Behavioral tests cover owner/guest/other-admin/malicious-role denials, multipart
CRUD, bad URLs/text/images/dates, distinct multi-image batches, publication and
media access, database reopening, concurrent dedupe, ticket spoofing/binding/
expiry/replay/dwell, aggregate metrics, visible-image timing, background/offscreen
rotation, and safe sharing from a private profile URL. Existing request-context
admin-resolution and schema-invariant tests exercise the unchanged access gates.
The pre-push release gates are required before pushing; `test` and `test-suite`
must pass before the mandatory `scripts/codex-merge-pr.sh` merge path.

## Runtime verification still required before completion

Verify the private owner pin against production, deployed revision, owner-only
management, a fresh recipient session's authorization boundary, and responsive
UI. Do not seed fictional advertisements into production. Existing staged
Railway changes are unrelated and must not be accepted wholesale.
