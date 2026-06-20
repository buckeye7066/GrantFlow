# Backend Crawler / Ingestion Subsystem Audit

Read-only audit of `backend/services/{crawlers,connectors,geo,nationalCrawlerV2,nationalPrograms,sources,portalAdapters}`.
Findings tagged `[critical|important|nit]` with real `file:line`. Static data-only fixtures under `crawlers/data/**` were skimmed (no logic; noted at end).

---

## crawlers/ (core dispatch / fetch / parse)

### backend/services/crawlers/httpClient.js

- **[important]** `backend/services/crawlers/httpClient.js:130` — `headForVerification` uses `maxRedirects: 5` with no host validation. A crawled/verified URL that 30x-redirects to an internal host (`127.0.0.1`, `169.254.169.254`, RFC1918) will be followed. SSRF surface for any caller passing untrusted URLs (e.g. domainCorpusCrawler verifies arbitrary crawled `application_url`/`source_url`).
- **[important]** `backend/services/crawlers/httpClient.js:37` — Default `retries = 1` but `requestWithRetry` has no host/scheme allowlist anywhere; every caller can request arbitrary URLs. The 429 path only retries when `attempt < retries`; with the default of 1 retry, a 429 burst is given up after 2 attempts and `Retry-After` is ignored entirely (uses fixed exponential backoff).
- **[nit]** `backend/services/crawlers/httpClient.js:32` — `ENOTFOUND` is deliberately treated as non-retryable (commented out). Reasonable, but transient DNS (`EAI_AGAIN` is retried, `ENOTFOUND` is not) can split-classify the same flapping host. Minor.
- **[nit]** `backend/services/crawlers/httpClient.js:74` — On non-2xx, the body snippet (up to 200 chars of upstream response) is logged via `console.warn`. Crawled error pages may contain reflected/sensitive content; low risk but unsanitized upstream data into logs.

### backend/services/crawlers/robotsPolicy.js

- **[important]** `backend/services/crawlers/robotsPolicy.js:135` — `isUrlAllowed` derives `robotsUrl` from `parsed.origin` and calls the injected `fetchText`. The robots.txt fetch itself is unvalidated outbound and (depending on the injected fetcher) may follow redirects to an internal host — same SSRF class as the page fetch. Fail-open on error (line 140) is the documented convention but means a forced robots.txt failure disables robots enforcement.
- **[nit]** `backend/services/crawlers/robotsPolicy.js:26` — `patternToRegExp` builds a `RegExp` from origin-controlled robots paths. Escaping is reasonable, but `*`→`.*` on an adversarial robots.txt with many `*` can produce a pathological regex (ReDoS-ish). Origin-controlled input, low severity.

### backend/services/crawlers/grantsGovClient.js

- **[important]** `backend/services/crawlers/grantsGovClient.js:68,116` — Application URL fallback interpolates the opportunity `number` into a search URL: `...?query=${encodeURIComponent(String(number))}`. `encodeURIComponent` is applied (good), but the `id`-based branch `${GRANTS_GOV_DETAIL}${id}` (line 67/114) does NOT encode `id`. A malformed/garbage `id` from the upstream API is concatenated raw into the stored `url`/`application_url`/`source_url` written to the DB.
- **[nit]** `backend/services/crawlers/grantsGovClient.js:222-249` — `querySimplerAPI` always sends `page_offset: 1` and never paginates; only the first page (≤25 rows) is ever fetched per keyword. `searchGrants`/`searchGrantsBatch` likewise never advance offset — total coverage is silently capped at `MAX_ROWS_PER_QUERY` per query with no signal that more results exist (`hit_count`/total is logged but unused for paging).
- **[nit]** `backend/services/crawlers/grantsGovClient.js:329-343` & `408-421` — Two near-identical dedup blocks (compound `_api_source::source_id` key, else title) are copy-pasted between `searchGrants` and `searchGrantsBatch`; divergence risk.
- **[nit]** `backend/services/crawlers/grantsGovClient.js:196-198` — When `hitCount > 0` but 0 hits extracted, it logs a "PARSING BUG" error but still returns `ok:true, hits:[]` — the parse failure silently drops every record for that keyword rather than surfacing an error to the caller.

### backend/services/crawlers/domainCrawlerEngine.js

- **[important]** `backend/services/crawlers/domainCrawlerEngine.js:226-237` — `liveFetchers` are awaited sequentially in a `for` loop with a try/catch that swallows ALL errors silently (`catch (_) {}`, line 234). A fetcher that always throws (or hangs — there is no per-fetcher timeout here; timeout is only imposed by the caller `domainCorpusCrawler.withTimeout` around the whole crawler) drops all its records with zero diagnostics.
- **[nit]** `backend/services/crawlers/domainCrawlerEngine.js:262` — `pre_score_note` string contains a mojibake character (`â`) where an em-dash/arrow was intended — same UTF-8/encoding corruption that recurs across this codebase (also crawlerManager.js:746, benefitsGovConnector.js:148, stateWaiverBenefitsCrawler.js:48-53,79).
- **[nit]** `backend/services/crawlers/domainCrawlerEngine.js:266-269` — Top-level `catch` logs `console.error('Domain crawler error:', error)` and returns `[]`. A config/programming error inside `runDomainCrawler` is indistinguishable from "no results"; the corpus crawler counts this as a successful (empty) crawler run.

### backend/services/crawlers/domainCorpusCrawler.js

- **[important]** `backend/services/crawlers/domainCorpusCrawler.js:222-288` — URL verification only HEAD-checks `inserted.slice(0, VERIFY_URL_LIMIT)` (first 20). All remaining persisted rows keep `link_status: 'unverified'` yet are already written and active. Broken direct opportunities beyond the first 20 are not deactivated by this pass (relies on a separate recurring verifier).
- **[important]** `backend/services/crawlers/domainCorpusCrawler.js:251-252` — `headForVerification(url, { timeoutMs: 4000 })` is called per row inside the loop, but `url = row.application_url || row.source_url` is a crawled value with `maxRedirects:5` (see httpClient finding) — verification itself can be redirected to an internal host (SSRF). No host allowlist before probing crawled URLs.
- **[nit]** `backend/services/crawlers/domainCorpusCrawler.js:184-187` — Domain-engines phase failure `throw`s and aborts the entire corpus crawl AFTER per-registry crawlers already ran but BEFORE any DB insert (insert happens at line 208). A late engine failure discards all the registry-crawler results gathered above — they are never persisted.
- **[nit]** `backend/services/crawlers/domainCorpusCrawler.js:189-197` — Dedup key is `url.toLowerCase()` only; the same opportunity reachable via `application_url`/`source_url` but a differing `url` is not deduped (the per-crawler dedupe in the engine uses url||application||source, but here only `url` participates first).

### backend/services/crawlers/crawlerManager.js

- **[important]** `backend/services/crawlers/crawlerManager.js:90` — `loadStateData` does `await import(\`./data/states/${stateCode}.js\`)` with `stateCode` derived from `analysis.location?.state`. It is not validated against a 2-letter allowlist before interpolation into the dynamic import path. A profile-supplied state with path characters (`../`) is a path-traversal/arbitrary-module-load vector into the dynamic import. (Practically `analysis.location.state` is normalized upstream, but this function does not enforce it.)
- **[important]** `backend/services/crawlers/crawlerManager.js:654` — `storeResults` does `DELETE FROM crawl_results WHERE profile_id = ?` then re-inserts, with no surrounding transaction. If the process dies mid-insert (or an insert throws — it re-throws at line 678), the profile is left with zero/partial crawl_results. Not atomic; concurrent runs for the same profile race (delete-then-insert interleave).
- **[nit]** `backend/services/crawlers/crawlerManager.js:674` — `source_type` is derived via `result.id?.startsWith('school-') ? ... : (result.stateRestriction ? 'state' : (result.id?.startsWith('fed-') ? 'federal' : 'national'))` — a brittle id-prefix heuristic; any program whose id doesn't follow the `fed-`/`school-` convention is silently classified `national`.
- **[nit]** `backend/services/crawlers/crawlerManager.js:723` — `state: result.stateRestriction || 'nationwide'` writes the literal `'nationwide'` sentinel into the state column (same divergence as sources/samGov.js); other paths use `null`.
- **[nit]** `backend/services/crawlers/crawlerManager.js:39` — `crawlSchemaEnsured` is a module-level boolean memo. In a multi-db / multi-tenant process the schema is ensured only against the first `db` seen; a second `db` (e.g. test vs prod handle) skips `ensureCrawlSchema`.

### backend/services/crawlers/foundation990Crawler.js

- **[important]** `backend/services/crawlers/foundation990Crawler.js:55-102` — Pagination loop runs `for (page = 0; page < max_pages; page++)` but the only early-stop signals are `orgs.length === 0` (line 70) and `(page+1)*25 >= result.total_results` (line 95) which hardcodes a page size of 25. If the upstream page size is not 25, or `total_results` is absent/incorrect, the loop either stops early (data loss) or walks all `max_pages` (default 20) unnecessarily. Page size is assumed, not read from the response.
- **[nit]** `backend/services/crawlers/foundation990Crawler.js:78-81` — Qualification filter uses `org.grant_amount ?? org.income_amount ?? 0`; falling back to `income_amount` when `grant_amount` is absent conflates total revenue with grant payout, admitting non-grantmaking orgs above the threshold.
- **[nit]** `backend/services/crawlers/foundation990Crawler.js:97-101` — Per-page errors are pushed to `errors[]` and the loop continues, but a persistent upstream failure for a `(state,ntee)` combo silently produces zero records with only a `console.warn`; the job still returns `success: true`.

### backend/services/crawlers/itemFundingCrawler.js

- **[critical]** `backend/services/crawlers/itemFundingCrawler.js:457-588` — `searchWebForItem` scrapes DuckDuckGo HTML results and extracts `actualUrl` from the `uddg=` redirect param, then these crawled URLs are written into opportunities (`url`/`application_url`/`source_url`) and persisted with NO host/scheme validation beyond a denylist of social/search domains (lines 555-566). An attacker who can rank a result (SEO/poisoning) gets an arbitrary URL — including `http://internal-host/` or non-http schemes after `decodeURIComponent` (line 549) — stored and later HEAD-verified/followed. No `isValidHttpUrl` gate on web-search results before they become opportunity URLs.
- **[important]** `backend/services/crawlers/itemFundingCrawler.js:440-443` & `466-468` — Search queries are built by interpolating the raw user `request`/`itemRequest` into query strings (`\`free ${request}\``, `\`"${itemRequest}" free program\``) then `encodeURIComponent`'d into the DuckDuckGo URL (line 505). Encoding makes the outbound request safe, but the unbounded user string is also stored in `keywords`/`item_requested` and `_search_query` on every result with no length cap or sanitization.
- **[important]** `backend/services/crawlers/itemFundingCrawler.js:503` — `queries.slice(0,8).map(async ...)` fires up to 8 concurrent scraping requests to DuckDuckGo with a browser-spoofing User-Agent (line 511). No per-host rate limiting / robots check; aggressive concurrent scraping of a third party diverges from the politeness conventions used elsewhere (robotsPolicy, per-host delays).
- **[nit]** `backend/services/crawlers/itemFundingCrawler.js:698` — `Array.isArray(rawWebResults) && rawWebResults !== null` — the `!== null` is dead (an array is never null after `Array.isArray` passes).
- **[nit]** `backend/services/crawlers/itemFundingCrawler.js:22,37` — Imports are interleaved with function definitions (`import * as cheerio` at line 22, then `buildSearchKeywords` at 25, then more imports at 37-44). Legal ESM (imports hoist) but obscures the dependency surface.

### backend/services/crawlers/orgContactEnrichment.js

- **[important]** `backend/services/crawlers/orgContactEnrichment.js:156,169` — `origin = \`https://${domain}\`` and pages are fetched as `\`${origin}${path}\``. `domain` comes from `domainOf(org.website)` which only strips scheme/`www`; there is no check that the resolved host is public (not `localhost`/RFC1918/`*.internal`). The injected `fetchImpl` is trusted to fetch it. SSRF surface if `org.website` is attacker/crawled-supplied. (Mitigated by same-origin-only and fixed paths, but host is unvalidated.)
- **[nit]** `backend/services/crawlers/orgContactEnrichment.js:19,54` — `EMAIL_RX`/`MAILTO_RX` are global (`/g`) regexes; `MAILTO_RX.exec` in a `while` loop (line 50) relies on `lastIndex` state. Reused module-level globals are fine here because each call re-runs from a fresh string, but `EMAIL_RX` used with `.match` (line 54) and as a module const is a latent statefulness footgun if ever used with `.test`/`.exec`.
- **[nit]** `backend/services/crawlers/orgContactEnrichment.js:111-112` — `TITLE_THEN_NAME`/`NAME_THEN_TITLE` regexes built from a large title alternation run against arbitrary stripped HTML; pathological inputs could be slow (ReDoS-ish). Crawled input, low severity.

### backend/services/crawlers/stateWaiverBenefitsCrawler.js

- **[nit]** `backend/services/crawlers/stateWaiverBenefitsCrawler.js:48-53,79` — Mojibake (`â`) in several `GENERIC_DIRECTORY` descriptions and a warning string (encoding corruption), persisted into stored descriptions.
- **[nit]** `backend/services/crawlers/stateWaiverBenefitsCrawler.js:106-109` — Top-level `catch` returns `[]` and logs `console.error`; a real error in the TN/ECF branch is indistinguishable from "no programs."

### backend/services/crawlers/ecfBenefitsCrawler.js

- **[important]** `backend/services/crawlers/ecfBenefitsCrawler.js:405-418` — `defaultLiveFetch` uses `axios.get` with `maxRedirects: 5` and no host validation against the curated `ECF_SOURCES` baseUrls — but more importantly, `discoverLiveBenefits` follows links extracted from the page (`resolveAbsoluteUrl`) and those candidate URLs are stored as opportunity `url`s. The discovered absolute URLs are validated as http(s) (line 427, good) but NOT validated against an internal-host blocklist, and they're never fetched here so risk is bounded — the concern is unvalidated crawled URLs persisted as application targets.
- **[important]** `backend/services/crawlers/ecfBenefitsCrawler.js:566-654` — Curated catalog entries hardcode `amount_min`/`amount_max` (e.g. SSI `amount_max: 914`, line 607) that are stale point-in-time figures presented as data. Not a code bug, but these fabricated-precise amounts are written into stored opportunities; the header comment claims "no fabricated numbers" while the curated floor does carry fixed amounts.
- **[nit]** `backend/services/crawlers/ecfBenefitsCrawler.js:735-739` — `isLoan` substring-matches `'interest'` in title+description; an unrelated program description containing "interested applicants" would be wrongly dropped as a loan. (The richer `opportunityPolicy.isLoanLike` avoids this with phrase patterns; this crawler uses its own naive matcher.)

### backend/services/crawlers/nationalZipCrawler.js

- **[important]** `backend/services/crawlers/nationalZipCrawler.js:816-823` — `searchOverpassLocalResources` POSTs to `https://overpass-api.de` with `timeout: timeoutMs` but no robots/politeness; OSM Overpass mapped elements (`mapOsmElementToOpportunity`, line 739) take `tags.website`/`contact:facebook`/etc. as the opportunity `url` via `pickFirstUrl` with only `normalizeUrl` (line 210) scheme-checking. Crawled OSM tag URLs are persisted as application targets with no host validation — stored-URL/SSRF-on-later-verify surface.
- **[important]** `backend/services/crawlers/nationalZipCrawler.js:1132` — Fallback `axios.get(\`https://api.zippopotam.us/us/${zip}\`)` interpolates `zip` into the path. `zip` is normalized to `^\d{5}$` / FSA upstream in most paths, but `getZipCoordinates` is also reachable with the raw `zip` arg; no `encodeURIComponent`. Low risk given normalization but unvalidated at this boundary.
- **[important]** `backend/services/crawlers/nationalZipCrawler.js:1883-2018` — The main batch loop is a single sequential walk with deadline checks and per-ZIP `Promise.race` timeout (good), but there is no run-level lock/idempotency key on `geo_crawl_runs`: two overlapping `runNationalZipCrawl` invocations (cron + manual) for the same scope both walk and `saveOpportunity`/`upsertGeoAssociation`. Global dedupe in `upsertFundingOpportunity` mitigates duplicate rows, but `incrementGeoCrawlRunCounts` and progress checkpoints race.
- **[nit]** `backend/services/crawlers/nationalZipCrawler.js:1955,1957` — Inside the `geoRunId` post-ZIP block, `regionForMeta(zipcodes.lookup(result.zip))` and `resolveCountyForZip(result.zip, eventState)` are called but `resolveCountyForZip` is async and is NOT awaited here (line 1957) — `eventCounty` is assigned a pending Promise, then passed to `appendGeoCrawlEvent` as the county. (Contrast line 1220 where it IS awaited.) County is logged as `[object Promise]`/null.
- **[nit]** `backend/services/crawlers/nationalZipCrawler.js:154-156,162-164,205-207` — Three `ensureGeoCrawlTables` try/catch blocks swallow all DDL errors silently with only a comment; a genuinely broken migration surfaces only as a later, less clear error.
- **[nit]** `backend/services/crawlers/nationalZipCrawler.js:2010-2012` — `if (global.gc) global.gc()` forces GC every 100 ZIPs; only active with `--expose-gc` and a manual GC call every 100 iterations can hurt throughput more than help.

### backend/services/crawlers/studentBridgeFundingCrawler.js

- **[nit]** `backend/services/crawlers/studentBridgeFundingCrawler.js:31-32` — `JSON.parse(job.parameters)` has no try/catch; a malformed `parameters` string throws an unhandled error that fails the whole job (other handlers guard JSON.parse). Idempotency is delegated to `addBridgeOpportunityToProfilePipeline` (not in scope here) — looks correct per the per-item try/catch.

### backend/services/crawlers/opportunityPolicy.js

- **[nit]** `backend/services/crawlers/opportunityPolicy.js:35,47` — `_rejectionCounts` is module-level mutable state; `enforceOpportunityPolicy` defaults to bumping it when no per-request `rejectionCounts` is passed. Concurrent crawl jobs share/clobber these global counters (cosmetic — counters only, not correctness — but cross-job contamination of diagnostics).
- **[nit]** `backend/services/crawlers/opportunityPolicy.js:245-255` — `isExpired` swallows `new Date(opp.deadline)` parsing oddities by returning `false` (treat as active). A genuinely-passed deadline in an unparseable format is kept as active. Conservative but can surface expired opportunities.

### backend/services/crawlers/crawlerHelpers.js

- **[nit]** `backend/services/crawlers/crawlerHelpers.js:1-69` — Deprecated compatibility shim; `calculateMatchScore` rebuilds `matchedSignals` via substring `oppText.includes(needle)` on every keyword — fine, but it is dead-for-new-code and explicitly non-authoritative. No bug.

### backend/services/crawlers/domainEngines/engineHelper.js

- **[nit]** `backend/services/crawlers/domainEngines/engineHelper.js:9-22` — `normalizeAndFilter` re-runs `looksLikeLoan`/`looksLikeMatchingFunds` only when `strict_*` flags are set; engines that omit the flags emit loan/matching records that are only caught later by `enforceOpportunityPolicy` (if the caller invokes it). No single chokepoint guaranteed at the engine layer.

### crawlers/data/** (static fixtures — skimmed)

- **[nit]** `backend/services/crawlers/data/**` — `federalBenefits.js`, `nationalPrograms.js`, `scholarships.js`, `states/*.js`, `knownSchools.js`, etc. are static curated arrays of `{title,url,...}` with hardcoded amounts/URLs and no executable logic. Risk is data staleness (dead URLs, outdated amounts) rather than code defects; they rely entirely on the downstream `opportunityPolicy`/verification gate for URL validity. Not individually enumerated.

---

## connectors/

### backend/services/connectors/nihNsfConnector.js
- **[important]** `backend/services/connectors/nihNsfConnector.js:28,52` — Module-level `lastRequestTime` mutated in `rateLimitedFetch` with no lock; concurrent crawl jobs both read a stale value and fire simultaneously — the rate limiter does not serialize concurrent callers (same pattern in every connector).
- **[nit]** `backend/services/connectors/nihNsfConnector.js:20,23` — `NIH_BASE_URL`/`NSF_BASE_URL` declared but never used (real RePORTER/NSF API calls in the doc comment are unimplemented; only static templates + HEAD verification of grants.nih.gov).
- **[nit]** `backend/services/connectors/nihNsfConnector.js:90-103` — `verifyUrlReachable` uses HEAD; hosts that reject HEAD return non-2xx and yield false `is_active:false`. Unreliable verification signal.

### backend/services/connectors/benefitsGovConnector.js
- **[important]** `backend/services/connectors/benefitsGovConnector.js:81,131` — `state` interpolated unsanitized into `application_url`/`source_url` (`...stateprofile.html?state=${state}`) and sponsor strings, then persisted; no 2-letter validation despite the JSDoc claim.
- **[nit]** `backend/services/connectors/benefitsGovConnector.js:33-57` — `rateLimitedFetch` is dead (not on the static-catalogue path) and lacks any timeout/AbortController, so it would hang indefinitely if wired up.
- **[nit]** `backend/services/connectors/benefitsGovConnector.js:148` — Mojibake (`â`) in a `console.warn`. `:18-21` stale comment references a removed `cheerio` import.

### backend/services/connectors/grantsGovConnector.js
- **[important]** `backend/services/connectors/grantsGovConnector.js:140,189` — `new Date(closeDate).toISOString()` unguarded; a malformed `closeDate` yields `Invalid Date` and `.toISOString()` throws `RangeError`, aborting the whole `searchOpportunities` map (one bad record kills the page).
- **[important]** `backend/services/connectors/grantsGovConnector.js:172-175` — `getOpportunityDetails` injects `opportunityId` into the URL path (`${SIMPLER_OPPORTUNITY_URL}/${opportunityId}`) with no `encodeURIComponent`/validation — path traversal / parameter smuggling.
- **[important]** `backend/services/connectors/grantsGovConnector.js:67-75` — Pagination uses `startRecordNum: params.offset` but no total/hit-count is read; callers must paginate blindly with no termination signal.
- **[nit]** `backend/services/connectors/grantsGovConnector.js:156` — `mapped.filter((o) => !o.is_loan && !o.requires_match)` drops loan/match records with no count log (hard to diagnose "0 results").
- **[nit]** `backend/services/connectors/grantsGovConnector.js:89` — Triple-nested `hitsNode` shape-guessing falls through to `[]` silently on unexpected shape.

### backend/services/connectors/stateOpenDataConnector.js
- **[critical]** `backend/services/connectors/stateOpenDataConnector.js:158-177` — Socrata records mapped into opportunities with no field sanitization/length cap; `evidence_url`/`source_url` come straight from `record.url` with no http(s)/internal-host check. Unsanitized crawled third-party data persisted verbatim — stored-injection / SSRF-on-later-fetch surface.
- **[important]** `backend/services/connectors/stateOpenDataConnector.js:155,212` — `socrataUrl` built from `portal.domain`; `configureStatePortal` accepts an arbitrary admin-supplied `config.domain` with no allowlist — `https://${portal.domain}/...` is an unvalidated outbound fetch (SSRF).
- **[important]** `backend/services/connectors/stateOpenDataConnector.js:212-219` — `configureStatePortal` omits `portal_grants_url`; later `searchStateData` falls back to bare `https://${portal.domain}`, silently dropping the authoritative portal URL.
- **[important]** `backend/services/connectors/stateOpenDataConnector.js:171` — Operator-precedence bug: `record.max_award || record.award_ceiling ? parseFloat(...) : null` parses as `(record.max_award) || (record.award_ceiling ? ... : null)`; a truthy non-numeric `max_award` returns the raw string unparsed.
- **[nit]** `backend/services/connectors/stateOpenDataConnector.js:168` — `min_award` parse doesn't strip `"$"` (unlike statePortals' `parseAmount`); currency strings become `NaN`.

### backend/services/connectors/usaspendingConnector.js
- **[important]** `backend/services/connectors/usaspendingConnector.js:26-50` — `rateLimitedFetch` has no timeout/AbortController; a hung POST blocks the crawl indefinitely.
- **[important]** `backend/services/connectors/usaspendingConnector.js:67-77` — Pagination never reads `page_metadata.hasNext`/total; one page returned, no signal for callers to stop/continue.
- **[nit]** `backend/services/connectors/usaspendingConnector.js:18` — `agencyCode` interpolated unvalidated into `${BASE_URL}/agency/${agencyCode}/` (path-injection surface; numeric by convention).
- **[nit]** `backend/services/connectors/usaspendingConnector.js:16` — Uses raw `console.error` instead of `createLogger` (convention divergence).

### backend/services/connectors/samGovConnector.js
- **[important]** `backend/services/connectors/samGovConnector.js:30-56` — `rateLimitedFetch` has no timeout and no 429 handling; a SAM.gov 429 throws immediately and aborts `searchAssistanceListings` (diverges from `sources/samGov.js`, which handles 429).
- **[important]** `backend/services/connectors/samGovConnector.js:104,111,139,149` — `programNumber`/`cfdaNumber` interpolated unencoded into `https://sam.gov/fal/${...}/view` and `${BASE_URL}/assistance-listings/${cfdaNumber}` — path injection / SSRF on the outbound detail fetch; malformed values produce broken stored `application_url`.
- **[nit]** `backend/services/connectors/samGovConnector.js:74-77` — `params.limit` not bounds-checked (unlike sources/samGov.js clamping to `SAM_GOV_MAX_LIMIT`).
- **[nit]** `backend/services/connectors/samGovConnector.js:135-137` — `getAssistanceListingDetails` doesn't guard for a missing API key before fetch; relies on a throw rather than graceful empty-result.

---

## sources/

### backend/services/sources/grantsGov.js
- **[nit]** `backend/services/sources/grantsGov.js:47` — `oppHits.map(_canonicalTransform)` has no per-record try/catch; one throwing hit fails the whole page (usaSpending/samGov wrap per-record).
- **[nit]** `backend/services/sources/grantsGov.js:55` — `Number(... ) || oppHits.length` masks a legitimate `0` total as `oppHits.length`.

### backend/services/sources/httpClient.js
- **[important]** `backend/services/sources/httpClient.js:28-100` — `fetchWithRetry` returns `response.data` (parsed axios body), NOT a Response object — but `statePortals.js` consumes it as a fetch `Response` (`.ok`/`.json()`). Contract mismatch (root cause of the statePortals break below).
- **[important]** `backend/services/sources/httpClient.js:70-83` — 429 treated as a non-retryable 4xx and thrown immediately without honoring `Retry-After`; rate-limit responses abort crawls instead of backing off.
- **[nit]** `backend/services/sources/httpClient.js:87` — Exponential backoff has no jitter (thundering herd across concurrent jobs).
- **[nit]** `backend/services/sources/httpClient.js:55` — `axios(config)` follows redirects (default maxRedirects=5) with no host validation (SSRF amplification for caller-supplied URLs).

### backend/services/sources/statePortals.js
- **[critical]** `backend/services/sources/statePortals.js:114-120` — `fetchWithRetry` returns a parsed body, but the code calls `if (!response.ok) throw` and `await response.json()`. `response.ok` is `undefined` (guard never fires) and `response.json` is not a function → `response.json()` throws `TypeError` on every successful fetch, caught at line 137 and converted to an empty result. State portal ingestion silently returns zero opportunities every time — total functional break.
- **[important]** `backend/services/sources/statePortals.js:211,174,188` — `raw_source_payload: JSON.stringify(record)` stores the entire untrusted record; `source_url: appUrl` taken verbatim from `record.url`/`record.link` with no http(s)/host validation (stored-injection / SSRF-on-fetch).
- **[nit]** `backend/services/sources/statePortals.js:117` — POST branch sets `body:` but axios expects `data:`; a future POST portal silently sends no body.
- **[nit]** `backend/services/sources/statePortals.js:10` — Mixed default+named import from the `crypto` builtin (stylistic divergence).

### backend/services/sources/usaSpending.js
- **[nit]** `backend/services/sources/usaSpending.js:264-273` — `parseDate` defined but never called (deadlines hardcoded `null` at line 161). Dead code.
- **[nit]** `backend/services/sources/usaSpending.js:61-68` — Pagination never inspects `page_metadata.hasNext`/total (blind paging).
- **[nit]** `backend/services/sources/usaSpending.js:242` — Keyword extraction runs on raw crawled description with no sanitization before `JSON.stringify` into the DB.

### backend/services/sources/ingestionService.js
- **[important]** `backend/services/sources/ingestionService.js:50-110,194` — Idempotency is not concurrency-safe: the "preflight existence check then insert-or-update" (`checkExists.get` → branch) is a TOCTOU race. Two concurrent runs for the same `(source, source_id)` can both see "not exists" and both INSERT (the comment at 46-49 deliberately avoids `ON CONFLICT`, but the alternative provides no cross-run atomicity).
- **[important]** `backend/services/sources/ingestionService.js:269-271` — "Stop if too many errors" `throw`s inside the transaction when `errors > 10`, rolling back ALL successfully-inserted rows in the batch (potentially thousands of good inserts discarded by 11 bad records).
- **[important]** `backend/services/sources/ingestionService.js:38,289,320` — Mixed sync/async DB usage: `await createRun.run(...)` (async-style) coexists with synchronous better-sqlite3 transaction semantics (`db.transaction(()=>{...})`, `.get()`/`.run()` un-awaited at 289/320). Latent correctness hazard depending on the actual driver.
- **[nit]** `backend/services/sources/ingestionService.js:142-144,170-172` — `is_active` null is treated as `true`/coerced to `1`; a source omitting the flag is force-activated and reality-gated.
- **[nit]** `backend/services/sources/ingestionService.js:191-194` — Source/source_id null check happens after validation; records missing `source_id` fail at DB time and count as `error` rather than a clean skip.
- **[nit]** `backend/services/sources/ingestionService.js:297,329` — Run accounting (`records_fetched` vs inserted/updated/rejected/errors) won't reconcile.

### backend/services/sources/samGov.js
- **[important]** `backend/services/sources/samGov.js:16-40` — `fetchWithRetry` retries 429/503 but ignores `Retry-After` (fixed `attempt*2000`), and on a thrown error blindly retries even non-retryable 4xx (400/401/403) up to 3×; the `timeout: 30000` (line 102) is a non-standard node-fetch option and likely ineffective.
- **[important]** `backend/services/sources/samGov.js:86,96` — API key placed in the query string (`URLSearchParams({api_key: apiKey,...})`); the full URL with the key risks leaking into logs/error messages. SAM.gov supports the `X-Api-Key` header (used by the sibling connector).
- **[important]** `backend/services/sources/samGov.js:115` — `has_more` math uses post-normalization `opportunities.length` (filtered) instead of the raw page count; when records are skipped, a caller computing offset advance from this skips/loops incorrectly.
- **[nit]** `backend/services/sources/samGov.js:203` — `state: state || 'nationwide'` writes a sentinel string while `is_national` is the canonical flag (divergence from usaSpending null).
- **[nit]** `backend/services/sources/samGov.js:140` — Response-shape probing yields `[]` on an unexpected/error-envelope shape, dropping all records with no warning.

---

## geo/

### backend/services/geo/geoCoverageService.js
- **[critical]** `backend/services/geo/geoCoverageService.js:99-118` — `fetchGeoIndexIds` interpolates `LIMIT ${limit}` directly into SQL (defaults to 3000). Un-parameterized numeric interpolation — SQL injection if any caller forwards a request-derived limit. Same risk for `${activeVal}` interpolations (87,110,131,276-277).
- **[important]** `backend/services/geo/geoCoverageService.js:278-279` — `buildGeoCoverageClause` unconditionally appends `state IS NULL` joined with `OR`; every geo query then matches all `state IS NULL` rows regardless of profile/scope — unscoped rows leak into every profile's results.
- **[important]** `backend/services/geo/geoCoverageService.js:76-94,99-118,123-138` — All three query helpers wrap the DB call in `catch { return 0/[] }`, so a real DB/SQL error is indistinguishable from "no coverage" and silently falls through to national.
- **[important]** `backend/services/geo/geoCoverageService.js:50-65,27` — `findNearbyZips` scans every ZIP (~42k) computing haversine per call; the unbounded `_nearbyCache` Map grows without eviction (CPU hot spot + memory leak over time).
- **[nit]** `backend/services/geo/geoCoverageService.js:290` — The broad `OR` group (ZIP-IN / state-IN / national / `state IS NULL`) is near-tautological given the always-on `state IS NULL`.

### backend/services/geo/zipCountyResolver.js
- **[nit]** `backend/services/geo/zipCountyResolver.js:30-32,47-49` — Both dataset-load catch blocks swallow errors silently; a corrupt map yields an empty mapping and every ZIP resolves to `null` with no diagnostic.
- **[nit]** `backend/services/geo/zipCountyResolver.js:10-11,51` — `loadMappingOnce` memoizes the empty-fallback `{}` permanently (truthy), so a transient first-call failure becomes a permanent negative cache that never retries.

---

## nationalCrawlerV2/

### backend/services/nationalCrawlerV2/fetchers.js
- **[critical]** `backend/services/nationalCrawlerV2/fetchers.js:21-35` — `fetchToBuffer` performs no SSRF validation before `fetcher.fetch(url)`: no scheme/host allowlist, no private-IP block (`169.254.169.254`, `127.0.0.1`, RFC1918), and the underlying fetcher follows redirects. Data-driven/live seed URLs and redirects can reach internal services.
- **[important]** `backend/services/nationalCrawlerV2/fetchers.js:35,54` — `contentHash: sha256(buffer.toString('base64'))` here, but `run.js:301` recomputes it as `sha256(buffer.toString('utf8'))`; file-path vs network-path use different hashing — change detection is inconsistent.
- **[important]** `backend/services/nationalCrawlerV2/fetchers.js:31` — `Buffer.from(await res.arrayBuffer())` with no size cap (memory exhaustion on a huge/streamed body).
- **[nit]** `backend/services/nationalCrawlerV2/fetchers.js:38-56` — `fetchFileUrl` reads any path from a `file://` URL with no confinement to a fixtures dir (unguarded arbitrary-file-read primitive).

### backend/services/nationalCrawlerV2/parsers.js
- **[important]** `backend/services/nationalCrawlerV2/parsers.js:43-45,67-69` — PDF/DOCX parse-failure fallback does `buffer.toString('utf8')` on binary bytes and runs it through the HTML parser, storing garbage as `extracted_text` instead of recording a parse failure.
- **[nit]** `backend/services/nationalCrawlerV2/parsers.js:16-17` — Parser routing by content-type/extension only; no magic-byte verification (wrong parser on mislabeled content).
- **[nit]** `backend/services/nationalCrawlerV2/parsers.js:24` — UTF-8 assumed everywhere; no charset handling.

### backend/services/nationalCrawlerV2/robots.js
- **[important]** `backend/services/nationalCrawlerV2/robots.js:89-103` — robots.txt fetch is fail-open and the empty (allow-all) ruleset is cached for the 6h TTL, so a transient robots failure suppresses enforcement for hours.
- **[important]** `backend/services/nationalCrawlerV2/robots.js:93` — `fetcher.fetch(robotsUrl)` is unvalidated outbound and follows redirects (same SSRF surface as fetchers.js).
- **[nit]** `backend/services/nationalCrawlerV2/robots.js:122-131` — Hand-rolled per-evaluation `RegExp` from `rule.path` double-processes `$`, is fragile (ReDoS-ish on crafted input), and diverges from RFC 9309 specificity.

### backend/services/nationalCrawlerV2/store.js
- **[critical]** `backend/services/nationalCrawlerV2/store.js:319-322` — `change_log` is rewritten on EVERY crawl including `changeType === 'unchanged'`, defeating idempotency; it reads the pre-update in-memory `existing.change_log`, so concurrent jobs lost-update the log (last writer wins).
- **[critical]** `backend/services/nationalCrawlerV2/store.js:35-332` — No transaction wrapping the up-to-four writes (main row, `nf_program_versions`, `change_log`). A later failure leaves rows inconsistent; concurrent runs race on `existing` (line 49) with no row lock / `ON CONFLICT` — both can INSERT.
- **[important]** `backend/services/nationalCrawlerV2/store.js:49,113,155,214,319` — Table name interpolated via `${table}`; guarded only by the single `ALLOWED_NF_TABLES` check at line 45 (convention risk — values are parameterized, but identifier interpolation relies on one guard).
- **[important]** `backend/services/nationalCrawlerV2/store.js:97-98,297` — `last_content_hash` stores `payloadHash` while `nf_program_versions.content_hash` stores the raw fetched-bytes `contentHash` — two hash semantics in adjacent columns; version dedup unreliable.
- **[nit]** `backend/services/nationalCrawlerV2/store.js:317` — Entire change_log array read/concatenated/`.slice(-50)`/rewritten every call (O(n) JSON-blob churn).

### backend/services/nationalCrawlerV2/normalize.js
- **[important]** `backend/services/nationalCrawlerV2/normalize.js:113,120-121` — `program_name`/`eligible_population`/`covered_services` taken verbatim from crawled HTML and flow unsanitized into the DB and `computeConfidence` (stored-injection / prompt-injection risk if interpolated downstream).
- **[important]** `backend/services/nationalCrawlerV2/normalize.js:186-190` — Both the `TRACK_A` branch and `else` set `provider_requirements = null`, so TRACK_B provider requirements can never be populated (dead/buggy branch → data loss).
- **[nit]** `backend/services/nationalCrawlerV2/normalize.js:169` — Defaults to `TRACK_A` when no track is inferred (silent misclassification).
- **[nit]** `backend/services/nationalCrawlerV2/normalize.js:29` — `pickSection` uses a fixed 2500-char window; the "until next blankline-ish chunk" comment is unimplemented.

### backend/services/nationalCrawlerV2/registry.js
- **[nit]** `backend/services/nationalCrawlerV2/registry.js:21-27` — `source_id: 'smoke-safe-fed-cms-waivers'` labeled "HUD Rental Assistance" with a hud.gov URL — id/name/agency mismatch (misleading for evidence/audit).
- **[nit]** `backend/services/nationalCrawlerV2/registry.js:113-198` — `buildRegistry` hardcodes live URLs with no health check; `useLive` swaps geography (King County→NYC at 167) so one `source_id` represents different jurisdictions → different `deterministicProgramId`s.

### backend/services/nationalCrawlerV2/run.js
- **[important]** `backend/services/nationalCrawlerV2/run.js:301` — `sha256(buffer.toString('utf8'))` on binary bytes is lossy (invalid sequences → U+FFFD); the content hash is not a faithful fingerprint — breaks change detection for binary sources (and diverges from fetchers.js base64 hashing).
- **[important]** `backend/services/nationalCrawlerV2/run.js:253-416` — Single sequential crawl loop with no concurrency guard or run-level idempotency/locking on `crawl_runs`; overlapping runs (cron + manual) race on the same `program_id` rows (compounded by store.js non-transactional RMW).
- **[important]** `backend/services/nationalCrawlerV2/run.js:312,322,340,403` — DB event writes (`insertEvent.run` for success states) are not in try/catch; a throw is caught by the per-URL handler and misclassified as a `fetch_error`/`parse_error`, corrupting failure stats.
- **[important]** `backend/services/nationalCrawlerV2/run.js:365-372` — `anySuccess = true` is set even when every track upsert failed; a source whose DB writes all failed is still counted as `sources_succeeded`.
- **[nit]** `backend/services/nationalCrawlerV2/run.js:301` — `buffer.toString` at line 301 runs before the `net.ok` check at 304; a null buffer throws on the friendly-HTTP-error path.
- **[nit]** `backend/services/nationalCrawlerV2/run.js:425-426` — Sampled `SELECT * ... LIMIT 5` rows (raw crawled text) written to `sample_output.json` with no PII scrubbing (`redact()` only applied to logs).

---

## nationalPrograms/

### backend/services/nationalPrograms/continuousRunner.js
- **[important]** `backend/services/nationalPrograms/continuousRunner.js:106` — Failure-recovery SQL uses double-quoted literal `SET status = "failed"`; on Postgres `"failed"` is an identifier, so the UPDATE throws and the stuck job is never marked failed, wedging the overlap guard (lines 27-42) indefinitely. Should be `'failed'`.
- **[important]** `backend/services/nationalPrograms/continuousRunner.js:33-37` — Overlap detection via `parameters LIKE '%"mode":"programs"%'` substring match; a hard-crashed job that never reaches a terminal state stays `queued`/`running` forever and permanently blocks the loop (no stale-job reaper).
- **[nit]** `backend/services/nationalPrograms/continuousRunner.js:19` — `Math.max(5, intervalMinutes)` doesn't guard NaN/non-numeric (an env string would yield NaN ms → immediate refire).

### backend/services/nationalPrograms/fetcher.js
- **[important]** `backend/services/nationalPrograms/fetcher.js:99-104` — `fetch(url, { redirect: 'follow' })` follows redirects with no internal-host blocklist; discovered/seed/redirected links can reach `localhost`/`169.254.169.254`/RFC1918 (`sameHost`/`isLikelyProgramUrl` filter only by host-equality/keywords).
- **[important]** `backend/services/nationalPrograms/fetcher.js:95-113` — No 429/`Retry-After`/status-based retry; any HTTP status (429/500/503) returns immediately, only thrown exceptions retry.
- **[important]** `backend/services/nationalPrograms/fetcher.js:80-87` — Race on `state.lastAt`: with `perHostConcurrency = 2`, two same-host tasks read `now`/compute `wait` before either writes `lastAt`, so two requests can fire with no enforced delay.
- **[nit]** `backend/services/nationalPrograms/fetcher.js:110-111` — Backoff sleeps even after the final attempt before throwing (needless latency on the error path).

### backend/services/nationalPrograms/normalize.js
- **[important]** `backend/services/nationalPrograms/normalize.js:84-85,126` — Crawled `program_name`/`extractedText` flow unsanitized into the DB and downstream (potential LLM-prompt/stored-injection); no length cap / control-char stripping at this layer.
- **[nit]** `backend/services/nationalPrograms/normalize.js:102,127` — `source_url` rejected unless http(s), but `source_url_hash = sha256(url)` is computed unconditionally, so the hash can correspond to a URL that was nulled out — inconsistent record.

### backend/services/nationalPrograms/confidence.js
- **[nit]** `backend/services/nationalPrograms/confidence.js:44-49` — `placeholderPenalty` inspects only top-level string values (nested placeholder strings not penalized).
- **[nit]** `backend/services/nationalPrograms/confidence.js:34-37` — `REQUIRED_FIELDS_CLIENT` includes `funding_track`, which `normalizeFromDocument` doesn't set (added later in store.js); a direct call with a normalize-shaped object under-counts.

### backend/services/nationalPrograms/store.js
- **[critical]** `backend/services/nationalPrograms/store.js:57,234,239,295,351` — Table name interpolated into SQL via template literals (`SELECT/INSERT/UPDATE ${table}`); guarded only by the `ALLOWED_TRACKS` check at line 43 — convention violation and latent injection if any path bypasses the guard.
- **[important]** `backend/services/nationalPrograms/store.js:398-409,417-448` — `program_change_events` insert is not idempotent; the post-insert version re-SELECT by `(track,program_id,content_hash)` returns a pre-existing row when `INSERT OR IGNORE` dedups, so a non-`unchanged` transition on identical content emits a duplicate/mislinked change event. Overlapping jobs double-write events.
- **[important]** `backend/services/nationalPrograms/store.js:56-58,234,367` — Mixed sync/async DB API (`await db.prepare().get()` here vs synchronous `.get()`/`.run()` in continuousRunner) plus `db?.dialect === 'postgres'` branch — dual-dialect ambiguity; no transaction wraps upsert + version + event writes (read-your-writes race under Postgres).
- **[important]** `backend/services/nationalPrograms/store.js:147,95` — `nextIsActive = deactivateDueToStatus ? 0 : 1` forces `is_active = 1` for any non-404/410 status (incl. 5xx/403); a transient 500 error page can overwrite good program data and re-activate it (index.js never gates on `response.ok`).
- **[nit]** `backend/services/nationalPrograms/store.js:118,130` — Full `extracted_text` (≤200k chars) written to `program_versions` on every changed crawl; unbounded version-table growth.

### backend/services/nationalPrograms/index.js
- **[important]** `backend/services/nationalPrograms/index.js:107-167` — No `response.ok`/status check before parse+upsert; a 403/500/soft-404 error page is parsed into a "program" and upserted (compounding store.js:147 force-active).
- **[important]** `backend/services/nationalPrograms/index.js:114` — `Buffer.from(await response.arrayBuffer())` with no size cap (memory-exhaustion DoS).
- **[important]** `backend/services/nationalPrograms/index.js:54,42` — `buffer.toString('utf8')` assumes UTF-8 for all non-PDF/DOCX content; the content-type charset is parsed then discarded, so Windows-1252/Latin-1 `.gov` pages produce mojibake in `extractedText`/`content_hash`/stored fields.
- **[important]** `backend/services/nationalPrograms/index.js:202-209` — Discovery cap semantics are muddled: the per-page `break` caps additions, but the cross-page `queue` is unbounded and `maxUrls` counts visited, so queue memory isn't strictly bounded.
- **[nit]** `backend/services/nationalPrograms/index.js:146-147` — PROVIDER track injects `provider_requirements: 'See source URL'`, a placeholder that counts as a "filled" required field and inflates confidence (contradicts normalize's leave-null philosophy).
- **[nit]** `backend/services/nationalPrograms/index.js:170-199` — `program_crosslinks` insert has no idempotency key; re-crawls accumulate duplicate crosslinks (unless an unseen DB unique constraint exists).

### backend/services/nationalPrograms/audit.js
- **[nit]** `backend/services/nationalPrograms/audit.js:25-34` — `logAuditEvent(db, ...)` called without `await`; if async, post-sync errors escape the try/catch and the durable platform-log fallback is skipped. Default call sites pass no `db`, so the DB-audit branch is effectively dead.

### backend/services/nationalPrograms/fetcher / parsers / agents
- **[important]** `backend/services/nationalPrograms/parsers/html.js:27-36` — `new URL(href, url)` resolves `javascript:`/`mailto:`/`data:`/`file:` links into the discovery queue; no scheme allowlist at extraction time (filtering relies on `sameHost` downstream).
- **[important]** `backend/services/nationalPrograms/parsers/pdf.js:12-27` — `pdfParse(buffer)` runs on the raw buffer with no page/size limit or timeout (PDF-bomb CPU/memory).
- **[nit]** `backend/services/nationalPrograms/parsers/docx.js:27-36` — DOCX parse failure returns `extractedText: ''` silently; index.js still upserts, overwriting good fields with empty/`Unknown Program`.
- **[nit]** `backend/services/nationalPrograms/parsers/pdf.js:16` vs `docx.js:17` — Inconsistent truncation signaling (`[CONTENT_TRUNCATED]` marker on docx only).
- **[nit]** `backend/services/nationalPrograms/agents/tn.js:5` — Single combined `administeringAgency` ("DHS / TennCare") applied to every seed URL regardless of which agency owns the page; conflates agencies into `canonical_key`.
- **[nit]** `backend/services/nationalPrograms/agents/federal.js:3` — `administeringAgency: null` for all federal programs → permanent confidence penalty on a REQUIRED field and empty agency segment in `canonical_key` (collision risk).

---

## portalAdapters/

### backend/services/portalAdapters/externalApplicationAdapter.js
- **[important]** `backend/services/portalAdapters/externalApplicationAdapter.js:36-40,103-105` — `canHandle` matches a broad regex (`college[\s-]?board|bigfuture|niche|appily…`) over crawled `application_url`/`source_url`; loose substring matching can route an unrelated opportunity into the auto-draft path. No profile/source scoping.
- **[nit]** `backend/services/portalAdapters/externalApplicationAdapter.js:62-68` — Methods depend on `this` binding (object is `Object.freeze`d, plain methods); a destructured call (`const { fillApplication } = adapter`) throws. Currently safe (registry calls as methods) but fragile.

### backend/services/portalAdapters/universityFinancialAidAdapter.js
- **[important]** `backend/services/portalAdapters/universityFinancialAidAdapter.js:52` — `RegExp.test` over `${opportunity?.title} ${opportunity?.description}` drives FAFSA gating on unbounded crawled free-text (static regex, so no ReDoS-from-user-pattern; flagging that crawled description length should be bounded upstream).
- **[nit]** `backend/services/portalAdapters/universityFinancialAidAdapter.js:90-91` — `getMissingInfo` recomputes the full `inspectRequirements` result just to extract `.requirements` (wasted work + `this`-binding dependency).

### backend/services/portalAdapters/portalAdapterRegistry.js
- **[nit]** `backend/services/portalAdapters/portalAdapterRegistry.js:42-46` — `resolveAdapter` swallows all `canHandle` exceptions silently (`catch {}`); a buggy adapter is invisibly skipped (no warn).

### backend/services/portalAdapters/portalAdapterTypes.js + others
- **[nit]** `backend/services/portalAdapters/portalAdapterTypes.js:142-152` — `readPath` here lacks the array-index handling present in the three concrete adapters; four divergent copies of `readPath` (externalApplicationAdapter, scholarshipPortalAdapter, universityFinancialAidAdapter) — maintenance/divergence hazard.
- **[nit]** `backend/services/portalAdapters/portalAdapterTypes.js:122-128` — `detectMissingDocuments` calls user-supplied `spec.match(d)` with no try/catch (a throwing matcher propagates out of the adapter).
- **[nit]** `backend/services/portalAdapters/basePortalAdapter.js:28-32` — `inspectRequirements` default returns `READY`; a subclass that forgets to override would report "ready" with nothing checked (unsafe default).
- **[nit]** `backend/services/portalAdapters/manualPortalAdapter.js:26,59,68` — Raw `opportunity.application_url` interpolated into user-facing description/status strings with no escaping (rendering layer must escape).
- **[nit]** `backend/services/portalAdapters/scholarshipPortalAdapter.js:118-128` — Duplicate `readPath` (see types divergence); `submitApplication` correctly safe-blocks by default.
