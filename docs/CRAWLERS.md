# GrantFlow Crawlers — Unified Reference

Single reference for crawler goals, implementation, and operations. **Goals and rules for Cursor:** see **[CURSOR_MASTER_PROMPT_CRAWLERS.md](CURSOR_MASTER_PROMPT_CRAWLERS.md)**.

---

## 1. Goals (summary)

- **Real only:** Every funding source has a valid http/https URL. No placeholders, example.com, or TBD links.
- **No loans, no matching funds:** Exclude loans, microloans, and matching-fund/cost-share programs everywhere (crawlers, API, DB query).
- **Profile-driven (except Geo):** All crawlers except Geo use full profile data and respect the Discover Grants slider (`min_match_score`). ECF and similar state benefit programs are eligibility-based only (no slider).
- **Local:** 25 miles from profile ZIP and from each interested-school ZIP (students).
- **Student:** School portals, FAFSA-style need, GPA, test scores, gender, location; grants/scholarships only.
- **Geo:** Not profile-based; every US ZIP; store by state → ZIP; real URL only.

Full rules and per-crawler goals: **[CURSOR_MASTER_PROMPT_CRAWLERS.md](CURSOR_MASTER_PROMPT_CRAWLERS.md)**.

---

## 2. Policy implementation

Central enforcement lives in **`backend/services/crawlers/opportunityPolicy.js`**:

- `isValidRealUrl`, `isPlaceholderOpportunity`, `isLoanLike`, `isMatchingFunds`, `enforceOpportunityPolicy`, `filterByPolicy`
- Applied on: **live path** (after normalize + after rescore), **DB fallback** (after scoring), **persist** (before `bulkUpsertFundingOpportunities`), **run-multiple**
- **DB query** (`buildCandidateOpportunityQuery`): always excludes `requires_match = TRUE`, `match_percentage > 0`, and loan types (no env toggles)

**Tests**

```bash
node --test tests/unit/opportunityPolicy.test.mjs
node --test tests/unit/real-crawlers-policy.test.mjs
node --test tests/unit/real-crawlers-local-funding.test.mjs
```

**Debug “why 0 results”**

- Run `POST /api/real-crawlers/run`; check `response.debug.live.validation_rejection_counts` and `response.debug.policy_rejections_db`
- `scripts/check-crawler-results.mjs` prints DB counts and reminds where policy rejection counts appear in the API response

---

## 3. Data sources

- **Real crawlers (Discover Grants):** Grants.gov, Benefits.gov, studentaid.gov, state and directory URLs. Details: **[DATA_SOURCES.md](DATA_SOURCES.md)**.
- **National Zip / Geo crawler:** Stores by state and ZIP; uses real URLs only; no profile.
- **National Crawler V2** (separate pipeline): registry in `backend/services/nationalCrawlerV2/registry.js`; modes SMOKE_MODE, STATE_MODE, NATIONAL_MODE. See **[CRAWLER_ARCHITECTURE.md](CRAWLER_ARCHITECTURE.md)** and **[CRAWLER_SCHEMA.md](CRAWLER_SCHEMA.md)**.

---

## 4. Crawler environment variables

**Real crawlers (backend/routes/realCrawlers.js)**

- `LIVE_CRAWL_TIMEOUT_MS` — timeout per crawler (default `12000`)
- `MIN_LIVE_RESULTS_BEFORE_SKIP_FALLBACK` — if live returns at least this many, skip DB fallback (default `3`)
- `LIVE_CRAWL_PERSIST_OPPS` — persist live results to DB (default `true`)
- `ENABLE_TOKEN_NARROWING` — use profile tokens in DB candidate query (default `true`)
- `DISABLE_ECF_UNLOCK_GATING` — set `true` to run ECF crawler regardless of eligibility (default `false`)

**National Crawler V2 (scripts)**

- `CRAWLER_MODE` — `SMOKE_MODE` | `STATE_MODE` | `NATIONAL_MODE`
- `CRAWLER_STATE` — 2-letter state for STATE_MODE
- `CRAWLER_USE_LIVE_SOURCES` — use live URLs vs fixtures (default `false`)
- `CRAWLER_MAX_SOURCES`, `CRAWLER_MAX_URLS_PER_SOURCE`, `CRAWLER_TIMEOUT_SECONDS`

Full app env: **[ENVIRONMENT.md](ENVIRONMENT.md)**. Generated inventory: run `node scripts/inventory-env.mjs` (see ENV_VARS.md).

---

## 5. Defect log (recent)

- **cof.org foundation-locator:** Switched to `community-foundation-locator` (valid TLS); local + nationalZip use it.
- **Cheerio ESM:** Use named import `import { load } from 'cheerio'`.
- **Windows file:// paths:** Use `pathToFileURL()` / `fileURLToPath()` for fixture paths.
- **crawler:doctor scope:** Runs only nationalCrawlerV2 smoke tests.

---

## 6. National Crawler V2 (separate pipeline)

V2 discovers and normalizes U.S. funding/benefits into **TRACK_A** (client/beneficiary) and **TRACK_B** (provider/org). It does **not** drive the Discover Grants UI; that uses the real crawlers (local, government, student, health, special needs, ECF) and Geo crawler.

- Architecture and flow: **[CRAWLER_ARCHITECTURE.md](CRAWLER_ARCHITECTURE.md)**
- Normalized schema (nf_programs_a/b): **[CRAWLER_SCHEMA.md](CRAWLER_SCHEMA.md)**
- Registry and scope: **[CRAWLER_SOURCES.md](CRAWLER_SOURCES.md)** (V2 registry and smoke sources)
