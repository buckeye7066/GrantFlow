# Verify current signup and welcome journeys

The Foundation browser assertions watched root `/api` paths while the deployed
application uses the configured `/grantflow` basename. They now match that
same basename. The welcome journey follows the current password-setup and
required-profile flow, then verifies the optional end-user welcome guide:
refresh retains it, skipping persists through the authenticated onboarding
endpoint, and a later refresh keeps it dismissed.

Four browser tests passed against fresh local databases and a real Chromium
browser: Foundation signup/resume/independent login/profile persistence, ZIP+4
resolution, stale geography blocked during a pending ZIP lookup, and welcome
guide persistence plus bare GrantDetail navigation. Every command exited zero
and its owned server was terminated afterward. Production authentication rate
limits were unchanged; authentication-heavy journeys used separate disposable
servers. No real mailbox or production account was used.

This verifies these journeys only. The separate broad admin/discovery browser
test remains under investigation: its automatically chosen demo profile has
incomplete geography and returns no visible matches with inference disabled.
Its nonzero-results assertion has not been removed or treated as passing.
