# Crawler Sources (Registry + Scoping)

## Source definition

Sources are defined as registry entries with:

- `source_id` (stable identifier)
- `jurisdiction` (`federal|state|county|tribal|mco|other`)
- `state` (2-letter if applicable)
- `county` (nullable)
- `source_family` (how to parse/fetch)
- `seed_urls[]`
- `configuration` (parser hints, track hints, agency labels, etc.)

The canonical registry lives in:

- `backend/services/nationalCrawlerV2/registry.js`

At runtime, selected sources are also persisted in the DB table:

- `crawler_sources`

## Scope control (mandatory)

Run mode is selected by the orchestrator:

- **SMOKE_MODE**
  - Tiny curated list
  - Defaults to **offline fixtures** (file://) + a mock MCO portal
  - Strict timeouts / minimal crawl

- **STATE_MODE**
  - Federal sources + one state
  - Requires `CRAWLER_STATE=XX`

- **NATIONAL_MODE**
  - Full registry
  - Intended to scale gradually by adding sources, not by widening selectors

Mode filtering is performed in:

- `backend/services/nationalCrawlerV2/run.js` (source filtering)

## Smoke-mode curated sources (proven)

Smoke mode includes at least one source for each category:

- **Federal**: SSA benefits (fixture: `tests/crawler/fixtures/federal-ssa-benefits.html`)
- **State**: TN ECF CHOICES (fixture: `tests/crawler/fixtures/state-tn-ecf-choices.html`)
- **County/Municipal**: King County housing assistance (fixture: `tests/crawler/fixtures/county-king-housing-assistance.html`)
- **Tribal**: Cherokee Nation health services (fixture: `tests/crawler/fixtures/tribal-cherokee-health.html`)
- **MCO/Contractor**: mock portal (`mock://mco-portal-example`)

These are intentionally stable to satisfy:

- evidence-based execution
- deterministic tests
- no broad crawling during CI

## Adding a new source

1. Add a new registry entry in `backend/services/nationalCrawlerV2/registry.js`.
2. Choose the correct `source_family`:
   - `agency_html` (default resilient HTML extraction)
   - `pdf_page` (PDF)
   - `mock` (test-only stubs)
3. Set `configuration.track_hints`:
   - `["TRACK_A"]` or `["TRACK_B"]` or `["TRACK_A","TRACK_B"]`
   - Hints are treated as authoritative (prevents accidental cross-track inference).
4. Run:

```bash
npm run crawler:doctor
```

and verify the new source appears in:

- `artifacts/crawler/YYYY-MM-DD/crawl.log`
- `crawl_runs` and `crawl_events` tables

