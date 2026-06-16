# Funding Library

The **Funding Library** is GrantFlow's user-facing read-only view of
*every verified funding opportunity in the general resources pool*.

It is **not** a profile pipeline.

- The Library shows what GrantFlow knows about, regardless of whether any
  profile currently matches it.
- To save something to a profile pipeline, use the Robert recommendation
  flow on the Profile page. Robert may auto-add to the Funding Library;
  he may **not** add to a profile pipeline without user approval.

## Why a separate page

Two distinct mental models exist in GrantFlow:

1. **Pipeline / matched results** — "what's a good fit for me right now?"
   Lives in `FundingOpportunities`, `FundingResults`, `Pipeline`, etc.
2. **General resources pool** — "what does GrantFlow know about?"
   Lives here.

This separation lets directory-style records (which the mission rules
require to *always survive filtering* unless explicitly excluded) live
somewhere users can browse them without polluting a profile-specific
pipeline.

## Route

- App route: `/FundingLibrary`
- API: `GET /api/funding-library`
- API single record: `GET /api/funding-library/:id`

Both API routes require authentication.

## Filters

Backed by `backend/services/fundingLibraryService.js#listFundingLibrary`.

| query param          | accepts                          | default      |
| -------------------- | -------------------------------- | ------------ |
| `q`                  | full-text on title/sponsor/desc  | —            |
| `state`              | 2-letter US state code           | —            |
| `applicant_type`     | individual / nonprofit / etc.    | —            |
| `category`           | category slug                    | —            |
| `deadline`           | `open` / `soon` / `expired_excluded` | —          |
| `source_trust`       | `official_api`, `verified_directory`, … | —     |
| `record_origin`      | `curated_verified`, `live_crawl`, … | —          |
| `kind`               | `direct_only` to hide directories | —           |
| `include_unverified` | `1` to include unverified rows   | `false`     |
| `include_loans`      | `1` to include loans / matching funds | `false` |
| `sort`               | `discovered_at`, `last_verified_at`, `deadline`, `amount_max` | `discovered_at` |
| `sort_dir`           | `asc` / `desc`                   | `desc`      |
| `limit`              | 1–200                            | 50          |
| `offset`             | ≥ 0                              | 0           |

## Default exclusions (mission-aligned)

By default the Library:

- **excludes** rows where `is_hidden = 1`
- **excludes** unverified rows (override with `include_unverified=1`)
- **excludes** loans + matching funds (override with `include_loans=1`)
- **includes** directory-style and curated records — these always survive
  filtering unless `kind=direct_only` is set.

## Response shape

```json
{
  "ok": true,
  "total": 1234,
  "items": [ /* funding_opportunities rows, JSON-decoded */ ],
  "facets": {
    "by_state":  [{ "state": "OH", "count": 87 }, ...],
    "by_origin": [{ "origin": "curated_verified", "count": 42 }, ...],
    "by_trust":  [{ "tier": "verified_directory", "count": 31 }, ...]
  },
  "filters_applied": { /* echo of the resolved query */ }
}
```

## Tests

`tests/unit/funding-library-service.test.mjs` covers:
- empty pool returns empty result + default facets
- verified rows visible by default; unverified opt-in
- loans excluded by default; opt-in
- hidden records always excluded
- curated records bypass the unverified gate (directory-survival rule)
- state filter respects the national flag
- search across title / sponsor / description
- pagination via `limit` / `offset`
- JSON-array column decoding for the row
- single-record fetch with 404 path
- facet counts by state and origin
- graceful handling of a missing `db` argument
