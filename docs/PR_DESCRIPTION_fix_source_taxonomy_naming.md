# PR: fix/source-taxonomy-naming → main

## Rationale

`source_type` was being used to represent **two distinct concepts**:

1. **Organization/source classification** (many values) used by UI/forms (e.g. `university`, `faith_based`, `community_foundation`, etc.)
2. **Listing/record type** (few values) used by crawler logic (`OPPORTUNITY`, `PROGRAM`, `DIRECTORY`)

Using the same field name for both concepts is a naming collision that risks incorrect filtering, confusing analytics, and accidental semantic changes.

## What Changed (Exact Rename)

- **Crawler listing taxonomy**: renamed from `source_type` → **`listing_type`** (canonical)
- **Organization/source classification**: remains **`source_type`** (unchanged)

## Backward Compatibility Plan (1 release)

- For ZIP crawl storage, we **write both**:
  - `listing_type` (canonical)
  - `source_type` (legacy, deprecated for listing type)
- Existing rows are backfilled so reads can use `listing_type` moving forward without breaking historical data.

## Database / Migration Safety

- Adds a **new nullable column** `listing_type` to `zip_funding_sources` and backfills from legacy `source_type`.
- No destructive schema changes; existing rows remain valid.

## Files Touched

- `backend/services/nationalZipCrawler.js`
  - Uses `listing_type` in memory + stats
  - Inserts `listing_type` and (for compatibility) still populates legacy `source_type`
  - Ensures `listing_type` column exists and backfills it if needed
- `backend/db/migrations/004_add_listing_type_to_zip_funding_sources.sql`
  - Adds/backfills `listing_type`
- `backend/db/schema.sql`
  - Documents/creates `zip_funding_sources` with `listing_type` + legacy `source_type`
- `docs/PR_NOTES_141.md`
  - Documents why PR #141 must not be merged

## Test Results

Run locally (required):

```bash
npm install
npm run lint
npm run build
npm test

# If Playwright is configured for your environment:
npx playwright install
npx playwright test
```

