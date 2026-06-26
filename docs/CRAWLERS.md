# GrantFlow Crawlers - Unified Reference

Single reference for crawler goals, implementation, and operations. Product rules live in [canonical_rules.md](canonical_rules.md); crawler planning rules live in [CURSOR_MASTER_PROMPT_CRAWLERS.md](CURSOR_MASTER_PROMPT_CRAWLERS.md).

---

## 1. Goals

- **Real only:** Every funding source must have a valid http/https URL. No placeholders, example.com, TBD links, or generic informational pages passed off as funding.
- **Rules over score:** Funding can be high-scoring and still disallowed. Rules and goals decide eligibility.
- **No loans or matching funds:** Exclude loans, microloans, matching-fund, and cost-share programs everywhere.
- **Profile-driven:** Crawler OS builds a thesis from the active profile before source selection and matching. Profile-free discovery is retired.
- **No cross-profile bleed:** Matches are written and read per profile. A source found for one profile cannot silently become a result for another profile.
- **Honest zero results:** Sparse or zero Crawler OS coverage must be visible and explainable. Do not backfill generic legacy catalog results.
- **Directories are labeled:** Directory-style resources may survive when rules allow them, but they must be labeled as directories rather than grants.

---

## 2. Active Implementation

The active crawler is **Crawler OS**:

- `backend/crawler-os/sourceRegistry.js` - active source registry and per-source kind/trust metadata.
- `backend/crawler-os/profileIntelligence.js` - profile thesis used for planning and matching.
- `backend/crawler-os/pipeline.js` - fetch, parse, reality checks, per-profile matching, and source telemetry.
- `backend/crawler-os/contract.js` - normalized opportunity kinds, reality status, and trust tiers.
- `backend/services/crawlerOsService.js` - live app boundary used by routes, schedulers, and agents.
- `backend/services/crawlerOsPersistence.js` - persistence into opportunities, matches, source runs, and profile discovery stamps.

The matching route serves `profile_opportunity_matches` from Crawler OS by default. The old catalog matcher is retired unless the server-only emergency flag `CRAWLER_OS_ALLOW_LEGACY_MATCHING=1` is deliberately set.

---

## 3. Commands

```bash
npm run crawler-os:test
npm run crawler-os:lint
npm run crawler:verify
npm run crawler:doctor
npm run crawler:smoke
npm run crawler:run -- <profileId> [--floor=N]
```

Notes:

- `crawler:doctor` and `crawler:smoke` run deterministic Crawler OS checks.
- `crawler:run` requires a profile id because active discovery is profile-driven.
- `crawler:verify` writes `test-results/crawler-os-report.json` and `.md`.

---

## 4. Environment

- `CRAWLER_PROFILE_ID` - optional profile id for `npm run crawler:run`.
- `CRAWLER_MIN_FLOOR` / `CRAWLER_FLOOR` - optional minimum floor for the OS CLI runner.
- `CRAWLER_OS_ALLOW_LEGACY_MATCHING` - emergency-only escape hatch for the retired catalog matcher. Leave unset.

Retired National Crawler V2 variables such as `CRAWLER_MODE`, `CRAWLER_STATE`, and `CRAWLER_USE_LIVE_SOURCES` are no longer used by the active crawler commands.

---

## 5. Debugging Zero Results

- Run `POST /api/real-crawlers/run` or `npm run crawler:run -- <profileId>`.
- Check per-source outcomes in `crawler_source_runs`.
- Check profile matches in `profile_opportunity_matches` where `matcher_version = 'crawler-os'`.
- Run `npm run crawler:verify` and inspect `test-results/crawler-os-report.md`.

Zero results are a mission-relevant state. Fix source coverage, profile extraction, or rule interpretation; do not patch over zero results with generic fallback matches.

---

## 6. Retired Crawlers

National Crawler V2 and the old strategy/domain crawler family are retired for discovery. Historical docs and archived files may remain for audit context, but they are not the live crawler authority.

- `/api/crawler-v2/run` returns `410`.
- `crawler:run` and `crawler:smoke` execute Crawler OS.
- Runtime import checks must keep old discovery crawler modules unreachable from the backend runtime.
