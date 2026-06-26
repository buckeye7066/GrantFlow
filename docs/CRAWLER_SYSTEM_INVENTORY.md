# GrantFlow Crawler System Inventory

This inventory supersedes the generated 2026-06-22 crawler map. That earlier map described the retired strategy registry, domain engines, National Crawler V2, and broad catalog matching paths.

## Active Crawler

Crawler OS is the active discovery crawler:

- `backend/crawler-os/sourceRegistry.js`
- `backend/crawler-os/adapters/`
- `backend/crawler-os/pipeline.js`
- `backend/crawler-os/profileIntelligence.js`
- `backend/services/crawlerOsService.js`
- `backend/services/crawlerOsPersistence.js`

## Runtime Invariant

Runtime discovery must not import the retired crawler families. The enforceable guard is:

```bash
npm run runtime-imports:check
```

Expected result:

```text
[legacy-crawler] ok - no legacy crawler modules reachable from the backend runtime
```

## Verification

Use the OS verification commands:

```bash
npm run crawler-os:test
npm run crawler-os:lint
npm run crawler:verify
npm run crawler:smoke
```

`crawler:verify` writes `test-results/crawler-os-report.json` and `.md`.

## Retired Material

The following are not active crawler authorities:

- `backend/services/crawlers/*`
- National Crawler V2
- strategy registry/domain engines
- scholarship web discovery side lanes
- legacy catalog matching fallback

Historical docs may mention them for audit context only. New crawler work belongs in Crawler OS.
