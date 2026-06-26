# Retired National Crawler V2 Architecture

This document is retained for audit context only. National Crawler V2 is no longer the active discovery crawler in GrantFlow.

Current crawler authority:

- `backend/crawler-os/`
- `backend/services/crawlerOsService.js`
- `backend/services/crawlerOsPersistence.js`
- `scripts/crawler-system-verify.mjs`

Operational status:

- `/api/crawler-v2/run` returns `410`.
- `npm run crawler:run` requires a profile id and runs Crawler OS.
- `npm run crawler:smoke` runs the Crawler OS deterministic doctor.
- New source work belongs in `backend/crawler-os/sourceRegistry.js`, not in the retired V2 registry.

Historical note:

V2 previously normalized broad national funding/benefit sources into separate Track A and Track B tables. That design was intentionally profile-free and is therefore not the live GrantFlow discovery path under the current rules.
