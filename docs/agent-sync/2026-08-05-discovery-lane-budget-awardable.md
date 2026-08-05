# Agent sync — 2026-08-05 — discovery lane budget + Discover awardable counts

## Shipped (this session, follow-on to #1148)
1. **Cooperative crawl time budget** — `runDiscovery` skips remaining sources as `time_budget_exhausted` when `deadlineMs` is past. Planner tier order (topic→stage→default) means truncation keeps the highest-signal lanes. Wired from `runProfileDiscoveryLive({ timeBudgetMs })` and `realCrawlers` HTTP budget.
2. **Discover awardable counts** — `partitionDiscoverResults` / `isDiscoverPointer` in `discoverResultsMerge.js`. Headline + toast + FundingResults `returned`/`totalFound` = awardable only; directories named separately; display order awardable then directories.
3. Stale `enforceCatalogRescoreConvergence` comment updated (writes DEFAULT ON).

## Guard tests
- `backend/crawler-os/tests/pipeline.test.mjs` — expired deadline skips all as time_budget_exhausted
- `src/pages/discoverResultsMerge.test.js` — partition + POINTER_KINDS drift tripwire vs backend registry

## Not in this change
- Funder intelligence / COMPARABLE_AWARDS card facets (P2 assessment item 5)
- Nightly crawls still run without deadline (full plan) by design
