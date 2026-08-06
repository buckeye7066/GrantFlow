# SIMPLIFICATION LEDGER — GrantFlow recovery

Anchor: `9dfbfaff`. Only VERIFIED removals get a "done" mark; candidates stay listed
until their PR merges.

Last source recheck: `ac578a7`, 2026-08-06. Candidate status was revalidated;
line counts remain tied to that source checkpoint unless stated otherwise.

| Item | Lines | Status | Evidence |
|---|---|---|---|
| Source-materialization stack (`scripts/source-materialization/` 28 files + driver + 8 npm hooks + 2 Docker steps + lock tests) | ~5,100 removed | **DONE — merged #1149, prod image live-verified at fc30ee3f** | Equivalence proven pre-merge (zero content diff); F-01 FIXED |
| `tests/unit/materialize-lock.test.mjs`, `source-materialization-contract.test.mjs` → replaced by `deployment-entry-points.test.mjs` (stays-removed guard) | ~140 removed / +40 | **DONE — merged #1149** | failing-first proven |
| Dead schedulers: `backgroundServices.js` (749), `queueRecovery.js`, `crawler-os/scheduler.js`, `anyaBootstrap.js`, `bootstrap.js` (594) | ~1,800 | CANDIDATE — decide emailGrantScheduler fate first (only consumer is dead code) | F-06 |
| Unreachable item crawlers: `backend/services/crawlers/itemFundingCrawler.js` (1,148), `itemCrawler.js` (326), `itemGiftCrawler.js` (213) | ~1,690 | CANDIDATE — superseded by itemNeedSearch; on check-runtime-imports legacy list | F-06 |
| Dormant rival engines: `profileIntelligence/relevanceScorer.js` + `eligibilityFilter.js` | 1,139 | CANDIDATE — delete or fold behind engine; live landmine if imported | F-02/HZ-15 |
| `matchingEngine.js` compatibility shim | 55 | CANDIDATE — migrate remaining callers/tests before deletion | census (b)/(d) |
| `crawlerOsCompatibility.js` compatibility facade | 197 | **KEEP — active runtime facade, not a whole-file deletion candidate** | Runtime consumers remain in admin, crawler, real-crawler, legacy-function, scheduled-discovery, and framework paths |
| Second dedup identities: `persistedMatchTruth` loose keys + client `fundingDedupe` → canonical `canonicalOpportunityKey` only | consolidation | CANDIDATE — needs F-02 sequencing | HZ-7 |
