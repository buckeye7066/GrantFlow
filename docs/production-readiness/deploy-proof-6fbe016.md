# Live deploy proof for GrantFlow 6fbe016

Recorded: 2026-08-18T20:51Z
This sidecar is not the release-identity evidence artifact.
This does not prove Production Ready.

## Closed: exact-SHA dual deploy

GitHub main, Railway /api/version, and Vercel /deployment-version.json all reported:

6fbe01637605d95a265b47b1d850c9708866c771

- GitHub main: 6fbe016 (#1272)
- Railway /api/version: same SHA, RAILWAY_GIT_COMMIT_SHA, matches_release true, migrations 178/178
- Vercel /deployment-version.json: same SHA, VERCEL_GIT_COMMIT_SHA, manifest ee6eb7bc
- /api/health: ok, about 25399 opportunities, recentFailures 0

Public health is not the visible-direct 100% or complete-catalog 95% fresh-link census.
