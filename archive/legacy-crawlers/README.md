# Legacy crawler engine — superseded by the Crawler OS (non-runtime reference)

The legacy grant-**discovery** crawl engine has been fully replaced by the
**Crawler OS** (`backend/crawler-os/`). As of the cutover it is **not reachable
from the backend runtime** — `npm run runtime-imports:check` enforces this and
fails CI if any runtime file imports a legacy crawler module again (emergency
escape hatch: `CRAWLER_OS_ALLOW_LEGACY=1`).

The legacy modules below remain physically in the tree **only** because they are
still referenced by legacy unit tests. They are dead code at runtime and may be
deleted once their tests are removed/migrated. Do **not** import them from
`backend/start.js` / `backend/server.js` runtime paths.

## Superseded modules (runtime-unreachable)
- `backend/services/comprehensiveCrawlerOptimized.js`, `autoDiscoveryCrawlers.js`,
  `scheduledAutoDiscovery.js`, `grantsDotGovCrawler.js`, `realFundingCrawler.js`,
  `realLocationFundingCrawler.js`, `localCrawler.js`, `countyFundingCrawler.js`
- `backend/services/crawlers/**` — the legacy discovery engine (crawlerManager,
  domain crawlers, domainEngines, strategyRegistry, queryPlanner, foundation990,
  ecfBenefits, stateWaiver, itemFunding, nationalZip, studentBridge, …)

## What replaced them
- Discovery + matching: `backend/crawler-os/` (pipeline, reality gate, match
  engine, adapters), driven by **Robert** and the per-profile seam
  `backend/services/crawlerOsService.js#runProfileDiscoveryLive`.
- Legacy crawl-trigger call sites now route through the explicitly-named
  compatibility shim `backend/services/legacyCrawlSuperseded.js` (no-ops; the
  user-facing "discover" trigger drives the OS).
- Shared utilities that used to live under `services/crawlers/` were relocated to
  `backend/services/shared/` (httpClient, robotsPolicy, opportunityPolicy,
  needTaxonomy, web search, static data, grantsGovApiClient).

## Not superseded (kept; not part of the old crawler)
- `crawlerDispatcher` / `crawlerJobState` — the shared job runner (still runs
  document_ingest / avatar_lookup / pipeline_automation / profile_enrichment /
  anya_match_scout / portal_check). Discovery job types are superseded at the
  dispatch choke point.
- `services/matchEngine.js` / `opportunityMatcher.js` — matchers used by Anya's
  scout, the validation gates, and non-discovery routes.
- `anyaAutonomousCrawler.js` — Anya's autonomous **code-audit** tool (not a grant
  crawler, despite the name).
