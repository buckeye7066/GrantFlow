# Backend Services Audit — Loose files g–o (`backend/services/*.js`, maxdepth 1)

Read-only audit. Scope: top-level service files in `backend/services/` whose filename starts with letters g–o. Subdirectories excluded.

Severity legend: **critical** (exploitable / data-loss / cross-tenant), **important** (real bug or security gap, conditional on caller), **nit** (minor / cosmetic / latent trap).

---

### backend/services/geoCrawlRunStore.js

- **[important]** `backend/services/geoCrawlRunStore.js:390` — `findCrawlerJobByGeoRunId` builds the Postgres LIKE pattern via string interpolation `` const likePat = `%"geo_run_id":"${id}"%` `` then binds it (`.get(likePat)`). Bound, so not classic injection, but `id` is not escaped for LIKE metacharacters (`%`, `_`); an `id` containing `%` broadens the match. SQLite branch (line 446) has the same unescaped-LIKE issue.
- **[nit]** `backend/services/geoCrawlRunStore.js:18-180` — `ensurePromise` once-guard has a (effectively zero) race window: ordering relies on single-threaded async execution where `ensured=true` (line 170) is set immediately before the promise is cleared (line 172).
- **[nit]** `backend/services/geoCrawlRunStore.js:335` — `appendGeoCrawlEvent` logs `zip` and free-form `message` at warn level when `runId` is missing; borderline geo PII in logs.

### backend/services/githubSyncVehicles.js

- **[important]** `backend/services/githubSyncVehicles.js:29-39` — `fetchVehicleOpportunities` queries `grant_opportunities` though the file/JSON output is named `vehicle_opportunities` (`data/vehicle_opportunities.json`). Table-name mismatch suggests a copy/paste bug; confirm intended table. No tenant/profile scoping — writes last-100 rows of (presumably global) data to a GitHub repo file; confirm none are profile-scoped/PII.
- **[important]** `backend/services/githubSyncVehicles.js:147` — GitHub PUT failure embeds the full raw response body into the returned message: `` `GitHub API error ${response.status}: ${responseBody}` ``. Unbounded body can leak repo internals if surfaced to client/insecure log.
- **[nit]** `backend/services/githubSyncVehicles.js:166-182` — `scheduleDebouncedVehicleSync` debounce is process-local (`pendingSyncTimer`, `lastSyncAt`). Multiple worker processes each commit independently, defeating the one-commit-per-5-min guarantee and risking GitHub 409 (stale `sha`).
- **[nit]** `backend/services/githubSyncVehicles.js:151` — `lastSyncAt` only updates on success; repeated failures compute debounce delay of 0 each time, so a failing sync retries with no backoff.

### backend/services/grantApplicationApproachAdvisor.js

- **[important]** `backend/services/grantApplicationApproachAdvisor.js:206-239` — Prompt injection into persisted data: untrusted crawled opportunity/grant fields (`description`, `contact_info`, titles, URLs) are fed into the LLM prompt, then `JSON.parse(text)` of model output is persisted to the `grants` table. `application_url`/`portal_url` are re-validated via `normalizeUrl` (good), but `contact_email`, `contact_name`, `contact_phone`, and `application_method` are persisted unvalidated — attacker-chosen contact info could become the grant's official application path.
- **[nit]** `backend/services/grantApplicationApproachAdvisor.js:158-162` — `analyzeAndPersistGrantApplicationApproach` loads grant/funding opportunity with no profile/tenant scoping (`SELECT * FROM grants WHERE id = ?`); relies on the background-task caller to authorize `grantId`.
- **[nit]** `backend/services/grantApplicationApproachAdvisor.js:239` — model output only loosely bounded (`.slice(0, 10)` on steps); acceptable.

### backend/services/grantsDotGovCrawler.js

- **[important]** `backend/services/grantsDotGovCrawler.js:78` — on a 0-result response logs the entire upstream body: `console.warn('[GrantsGov] search2 returned 0 results; full response:', JSON.stringify(body, null, 2))`. Unbounded log dump on every empty keyword search (20 keywords × pages); noisy, not sensitive.
- **[nit]** `backend/services/grantsDotGovCrawler.js:152-164` — `cryptoSafeId` is a weak non-crypto hash (`hash * 31 + charCode`) despite the name; collisions for opps lacking both `oppNumber` and `oppId` produce duplicate `grants-gov-<hash>` IDs.
- **[nit]** `backend/services/grantsDotGovCrawler.js:130-131` — `parseAmount(opp?.awardFloor) || null`: a legitimate award floor of `0` becomes `null` (0 is falsy). Minor data-fidelity loss.
- **[nit]** `backend/services/grantsDotGovCrawler.js:74` — `hitsNode` shape heuristic is brittle; guarded downstream at line 254 (`!data.oppHits`), so handled.

### backend/services/hamiltonApplicationAgent.js

- **[important]** `backend/services/hamiltonApplicationAgent.js:122-125` — `loadProfile` calls `await withProfileScope({ bypass: true }, async () => null)` (a no-op whose return is discarded) then runs `SELECT * FROM profiles WHERE id = ?` outside any scope. Profile/opportunity/document loads (`loadProfile`/`loadOpportunity`/`loadDocuments`) have no org/tenant guard; only `runHamiltonCycle:330` checks `task.profile_id` vs `profileId`. Relies entirely on the caller passing a correct `profileId`.
- **[important]** `backend/services/hamiltonApplicationAgent.js:380-396, 401-415, 426-440` — `adapter.inspectRequirements(ctx)`, `fillApplication(ctx)`, and `submitApplication(ctx)` are called without `await`. If any adapter method is async, `result` is a Promise and all downstream logic (`result.outcome`, `result.requirements.filter`) operates on a Promise, silently misbehaving. Correctness bug if the adapter contract permits async.
- **[nit]** `backend/services/hamiltonApplicationAgent.js:473-475` — `result.requirements.filter(...)` assumes `requirements` is always an array; an adapter omitting it would throw uncaught. `(result.requirements || [])` would be safer.
- **[nit]** `backend/services/hamiltonApplicationAgent.js:42` — `TASK_STATUSES` imported but never used — dead import.

### backend/services/hourlyRounding.js

- _No issues found._

### backend/services/housingScholarshipCrawler.js

- **[important]** `backend/services/housingScholarshipCrawler.js:611-642` — `isLiveUrl` fetches catalog URLs with `redirect: 'follow'` and no host allow-listing. URLs are a hardcoded curated catalog (low risk today), but it is a general outbound-fetch-on-any-URL sink that follows redirects — an SSRF sink if ever reused with caller-supplied URLs.
- **[nit]** `backend/services/housingScholarshipCrawler.js:709` — success counted when `result.inserted || result.id`; a skipped result with a truthy `id` would over-count `inserted`.
- **[nit]** `backend/services/housingScholarshipCrawler.js:700` — `last_verified_at` stamped even when `validateUrls` is false; the verification gate (opportunityInserter.js:292-294) likely strips it absent proof — harmless dead value.

### backend/services/itemCatalogService.js

- **[important]** `backend/services/itemCatalogService.js:324-330` — `inferNeedsWithAI` interpolates profile-derived `contextSummary` (user-supplied goal/intent text) directly into the LLM `userPrompt` with no delimiting/escaping. Prompt-injection vector; impact limited (output is suggestion names for display) but text is unbounded/unsanitized.
- **[nit]** `backend/services/itemCatalogService.js:533, 540-550` — two `SELECT ... LIMIT 800` scans of `item_catalog`/`funding_opportunities` with no profile scoping in `discoverNewCatalogItems` (admin/global by design; confirm route enforces admin auth).
- **[nit]** `backend/services/itemCatalogService.js:55, 105-116, 364-381` — catalog read/seed/suggest queries not tenant-scoped (`item_catalog` appears global by design); `suggestItemsForProfile` scopes only via `buildProfileContext`.
- **[nit]** `backend/services/itemCatalogService.js:96-98, 510-523, 597-625` — multiple `try {} catch {}` blocks silently swallow per-row insert/update errors; schema drift / constraint violations during discovery are invisible.

### backend/services/itemCrawler.js

- **[nit]** `backend/services/itemCrawler.js:143-150` — dynamic `keywordConditions` are parameterized correctly (bound `?`), and LIKE metacharacters are escaped at line 130, but the SQL lacks an `ESCAPE '\'` clause so the backslash escaping is not honored — `%`/`_` in keywords still act as wildcards. Functional nit, not injection.
- **[nit]** `backend/services/itemCrawler.js:69` — `processItemCrawlerJob` queries `funding_opportunities` with no profile/tenant filter (table appears global).
- **[nit]** `backend/services/itemCrawler.js:57-64` — `loadJSON` returns `[]` on parse failure; assumes a direct-array JSON shape. If `item_funding_sources.json` is an object (`{sources:[...]}` like the gift crawler), iteration silently yields nothing. Verify shape.

### backend/services/itemGiftCrawler.js

- **[nit]** `backend/services/itemGiftCrawler.js:128-184` — upsert loop has no per-row try/catch around `await upsertFundingOpportunity`; a single throwing row aborts the whole job, unlike the sibling `itemCrawler.js:228-301`. Inconsistent error isolation.
- **[nit]** `backend/services/itemGiftCrawler.js:169-170` — persists source-provided `contact_info` with `profile_id: profileId`; `profileId` may be `null` (fallback chain line 75), inserting a null-profile directory row that may not be the intended association.
- **[nit]** `backend/services/itemGiftCrawler.js:95` — passes `{ profile: null }` to `scoreOpportunity` when no profile; throws if `scoreOpportunity` dereferences `profile.*` unguarded. Verify null-safety.

### backend/services/jobBackpressure.js

- **[important]** `backend/services/jobBackpressure.js:205` — `getJobsReadyForRetry` uses `dlq.resolved = FALSE` (and `markExhaustedJobs` relies on Postgres boolean semantics) with no `db.dialect` guard, diverging from the pattern in linkVerificationService.js:228-229 / localCrawler.js:131. On SQLite (test/dev), `resolved = FALSE` won't match `0` rows, silently returning zero retry-ready jobs.
- **[important]** `backend/services/jobBackpressure.js:187` — `now` is built by string-munging an ISO timestamp and compared to `next_retry_at` with `<=`, assuming an exact `YYYY-MM-DD HH:MM:SS` text format. `scheduleJobRetry`/`incrementRetryCount` pass a `Date` (line 163); any format/timezone divergence makes the lexicographic comparison wrong. No try/catch here, so a query error is an unhandled rejection.
- **[nit]** `backend/services/jobBackpressure.js:143` — logs raw `errorForDecision` text which can contain PII/secrets from upstream error messages; also inconsistent use of `console.*` despite importing structured `log`.
- **[nit]** `backend/services/jobBackpressure.js:228-233` — `markExhaustedJobs` uses `retry_count > MAX` while `shouldRetryJob` stops at `>= MAX` (line 48); a job at exactly `retry_count === MAX` and `status='queued'` is never retried *and* never marked `failed` — off-by-one, can linger in `queued`.

### backend/services/knowledgeBaseProcessor.js

- **[important]** `backend/services/knowledgeBaseProcessor.js:84` — Prompt injection: raw `extractedText` from an uploaded KB doc is concatenated into the user message (`Analyze this document:\n\n${textToAnalyze}`) with no delimiting. A malicious doc can override system instructions and emit attacker-chosen `funding_source_urls` that flow downstream; URL-scheme validation (line 265) does not stop syntactically-valid hostile https URLs.
- **[important]** `backend/services/knowledgeBaseProcessor.js:165-219, 226-240` — No profile/tenant scoping: `processPendingKBDocuments` selects `documents WHERE type='knowledge' AND processing_status IN ('pending')` across all tenants, and `extractFundingOpportunitiesFromKB` reads every analyzed KB doc with no tenant filter. Cross-tenant leak if invoked per-request rather than as a single trusted background job.
- **[important]** `backend/services/knowledgeBaseProcessor.js:97` — `JSON.parse(analysisText)` is only caught by the outer try/catch and never schema-validated; `metadata.document_type`, `funding_source_urls`, etc. are trusted as-is downstream (lines 246-298).
- **[nit]** `backend/services/knowledgeBaseProcessor.js:65` — `db.prepare('SELECT 1')` is prepared but never executed; on async drivers it may not validate the connection, so the "fail fast before spending tokens" intent may not hold.
- **[nit]** `backend/services/knowledgeBaseProcessor.js:273,294` — mojibake in warning strings (`'â funding_urls...'`), encoding issue in log/audit text.

### backend/services/linkVerificationService.js

- **[critical]** `backend/services/linkVerificationService.js:101-119` — SSRF: `checkUrl` does `fetch(url, { redirect: 'follow' })` on URLs from untrusted ingested/KB-extracted data with no allow-list and no block on loopback/link-local/RFC1918 hosts. `shouldSkipUrl` only filters a configured skip list and placeholders — it does not block `http://169.254.169.254/`, `http://localhost`, etc. A crafted `application_url` can probe internal services (and follow redirects to them).
- **[important]** `backend/services/linkVerificationService.js:231-288` — Concurrency hazard: each batch fans out with `Promise.all` over rows, all awaiting `update.run`/`recordVerificationEvent`/`hide.run`/`deactivate.run` on the same shared prepared statements/connection concurrently. Fine on sync better-sqlite3, but on an async/pooled Postgres driver interleaving concurrent `.run()` on one shared statement is a correctness/connection-state hazard; the hide+deactivate pair (lines 278-279) is not transaction-wrapped.
- **[nit]** `backend/services/linkVerificationService.js:174,184` — `last_verified_at < ?` compares against an ISO-8601 string; correct only because writes use `new Date().toISOString()` (line 239). Mixing with any non-ISO writer breaks the cutoff filter.
- **[nit]** `backend/services/linkVerificationService.js:336-338` — `getLinkHealthSummary` is not `async` and returns `db.prepare(...).all()` directly; on async dialects the caller gets a Promise, inconsistent with awaited usage elsewhere.

### backend/services/localCrawler.js

- **[important]** `backend/services/localCrawler.js:164-204` — Dedup keys only on `title`; a file opp and a DB opp (or two distinct programs) sharing a title collide and the later is dropped even when application_url/sponsor differ — silent data loss, no logging of the dropped duplicate.
- **[nit]** `backend/services/localCrawler.js:24-31, 121-126` — `loadJSON` catches and returns `[]` (never throws), so the caller's try/catch at 123-126 is dead; a corrupt `local_opportunities.json` silently yields zero file opps with only a `console.warn`.
- **[nit]** `backend/services/localCrawler.js:216-244` — `scoreOpportunity` (non-authoritative ranking score) is used to gate `filteredOpps`/`topOpps` before pipeline insertion via a threshold filter, a soft divergence from the matchingEngine contract that score must not be an acceptance gate (re-routed through `computeMatchDecision` at line 302, so soft).
- **[nit]** `backend/services/localCrawler.js:172,191` — mojibake in skip warnings (`"â missing application_url"`).

### backend/services/matchDecisionEngine.js

- _No issues found._ (Pure re-export shim; every named export exists in matchEngine.js.)

### backend/services/matchEngine.js

- **[important]** `backend/services/matchEngine.js:43` — Dead imports: `DECISION_ACCEPT_MIN` and `DECISION_CONFIDENCE_MIN` imported from `../config/matchThresholds.js` but never referenced (decisioning uses only `ACCEPT_SCORE`/`REVIEW_SCORE`); likely an abandoned confidence gate.
- **[important]** `backend/services/matchEngine.js:2047` — `results._relaxed = relaxed` sets an expando property on an Array; any consumer that spreads/maps/JSON-serializes `results` silently drops `_relaxed`, losing the "threshold relaxed" signal on the wire.
- **[nit]** `backend/services/matchEngine.js:1626-1628` — `scoreOpportunity` mutates the caller-supplied `profileContext` (`profileContext.profileNorm = ...`). Intentional memoization across the loop (lines 2019-2022) but an undocumented input side effect and a race hazard if the same context is scored concurrently.
- **[nit]** `backend/services/matchEngine.js:2260-2265` — `computeMatchDecision` detects "already normalized" via `rawProfile?.entityType !== undefined` / `rawOpportunity?.entityTypesAllowed !== undefined`; raw data that happens to carry those fields bypasses normalization silently, producing inconsistent scoring.
- **[nit]** `backend/services/matchEngine.js:758` — `calculateDeadlineUrgency` treats an unparseable deadline (`NaN` date) the same as "no deadline" (returns 0 urgency) rather than flagging an invalid date string.
- **[nit]** `backend/services/matchEngine.js:907` — `MATCHING_ENGINE_FACET_DEBUG` path logs full opportunity title and facet reasons via `log.info`; increases log volume with opportunity/profile-derived text if enabled in prod.

### backend/services/matchingEngine.js

- _No issues found._ (Deprecated shim delegating to `scoreOpportunity`; behavior matches its documented contract.)

### backend/services/medicalNecessity.js

- **[critical]** `backend/services/medicalNecessity.js:40-46, 282-309` — No tenant/ownership scoping on PHI. `extractMedicalProfile` runs `SELECT * FROM profiles WHERE id = ?` and `generateMedicalNecessityDocument` runs `SELECT * FROM funding_opportunities WHERE id = ?` / `SELECT * FROM grants WHERE id = ?` (lines 301-307) using only raw IDs with no owner/tenant predicate. If IDs come from a request without a route-layer authorization check, any caller can extract another user's full medical/disability profile and generate a medical-necessity letter (IDOR on PHI).
- **[important]** `backend/services/medicalNecessity.js:340-343, 489-499` — Prompt injection of PII into the LLM: `buildDocumentPrompt` interpolates raw profile free-text (conditions, physician name), `additionalContext` from `options` (line 498, attacker-controllable), and opportunity title/description (untrusted ingested data) directly into the OpenAI user message with no sanitization — a meaningful injection surface for a document a physician is told to sign.
- **[important]** `backend/services/medicalNecessity.js:48, 59, 349` — PII-in-logs exposure: `console.error` calls log full DB errors alongside `profileId`; member/insurance IDs are assembled (lines 540-541) and flow into the prompt. One `console`-level change from leaking diagnoses/member IDs; ensure none reach logs.
- **[nit]** `backend/services/medicalNecessity.js:66-69` — `JSON.parse(r.data)` guarded by try/catch (good) but on failure silently skips the section, so corrupt `health_medical` makes the engine behave as if there are no conditions, surfacing later as the confusing "No medical conditions" error (line 295-297).
- **[nit]** `backend/services/medicalNecessity.js:139,144` — `medHist.primary_condition.toLowerCase()` / `sc.toLowerCase()` assume strings; a non-string entry from malformed JSON throws, crashing `extractMedicalProfile` (no try/catch in `extractConditions`).

### backend/services/missionAuditService.js

- **[nit]** `backend/services/missionAuditService.js:19` — `REPO_ROOT = path.resolve(process.cwd())` ties the audit to process CWD; on the Railway backend deploy (no `src/`), `walk()` scans whatever the runtime CWD is, producing noisy/empty results. `missionHealthService.js` pins via `GRANTFLOW_REPO_ROOT` instead.
- **[nit]** `backend/services/missionAuditService.js:152` — dynamic-SQL detector only matches `` db.(prepare|get|all|run)`...` `` on one line; multi-line template SQL or concatenation is undetected. Heuristic gap (acknowledged narrow design).
- **[nit]** `backend/services/missionAuditService.js:173-187` — duplicate tool-registration detection only inspects the same/previous line for `registerTool(`; registrations with `name:` further below are uncounted.

### backend/services/missionHealthService.js

- **[important]** `backend/services/missionHealthService.js:232-236` — `events24h` ORs two dialect-specific clauses in one statement: `WHERE created_at >= datetime('now','-1 day') OR created_at >= NOW() - INTERVAL '1 day'`. One side always throws (SQLite has no `NOW() - INTERVAL`, Postgres has no `datetime()`); `safeGet` wraps it as `{ __error }` and the `.catch(() => null)` never fires (safeGet doesn't reject), so the 24h-events metric is effectively always `null` in production.
- **[nit]** `backend/services/missionHealthService.js:65-79, 239` — `safeAll` returns `[{ __error: ... }]` on failure, a sentinel callers must special-case; only `funnel` (line 259) does, so `coverage_by_source` (line 239) would surface an `{__error}` object straight into the API payload on failure.
- **[nit]** `backend/services/missionHealthService.js:110-114` — `detectModuleUsage` cache key is `JSON.stringify({serviceFiles, consumerFiles})`; object key stability depends on property order, causing silent cache misses.

### backend/services/nationalJobRouter.js

- _No issues found._

### backend/services/needsBasedQueryExpander.js

- **[important]** `backend/services/needsBasedQueryExpander.js:526` — Rule `high_school_college_bound_tennessee` checks `s.applicantTypes?.has(...)` (plural) but `extractSignals` only exposes `applicantType` (singular, line 957), so `s.applicantTypes` is always `undefined` and `?.has(...)` short-circuits. The fallback `s.applicantType === 'student'` compares a `Set` to a string and is always false. The entire applicant-type condition is dead — a real logic bug producing missed TN student-program matches (Tennessee Promise/TSAA/Reconnect).
- **[nit]** `backend/services/needsBasedQueryExpander.js:614` — singular/plural drift (`s.applicantType?.has('youth')` works but the codebase mixes singular/plural freely); a latent trap for future rules.
- **[nit]** `backend/services/needsBasedQueryExpander.js:17-26` — `isTruthy()` (line 17) and `includes()` (line 23) helpers are never called/exported — dead code.

### backend/services/nextStepGuidance.js

- **[nit]** `backend/services/nextStepGuidance.js:218-220` — `buildProfileOnlyGuidance` iterates `coverage.suggestions` with no upper bound (the per-match path slices to 3 at line 79); a profile with many gaps emits an unbounded step list. Minor UX.

### backend/services/opportunityInserter.js

- **[important]** `backend/services/opportunityInserter.js:502-506, 723-732` — The existing-record lookup (`WHERE source = ? AND source_id = ?`) and cross-source URL-dedup (`WHERE source_url = ? OR application_url = ?`) are global, not `profile_id`-scoped, yet the row carries `profile_id` (line 569/803). A profile-scoped opportunity from one tenant can match/update or be deduped against another profile's row sharing the same source_id/URL — tenant-scoping gap on the write path if isolation is intended.
- **[important]** `backend/services/opportunityInserter.js:829-951` — The INSERT uses `@named` params and a Postgres-specific `ON CONFLICT (source, source_id) WHERE source IS NOT NULL ... DO UPDATE` partial-index conflict target, while the UPDATE path (lines 579-673) uses positional `?` params against the same `db.prepare` abstraction. The partial-index conflict clause is a SQLite-dialect risk; confirm the SQLite adapter rewrites it.
- **[nit]** `backend/services/opportunityInserter.js:444-458` — verification-event audit write wrapped in `try {} catch {}` with an empty body; any failure other than missing-table is silently swallowed.
- **[nit]** `backend/services/opportunityInserter.js:413-415, 566` — `reality_reasons` is JSON-stringified at line 413 then re-passed through `serializeRealityReasons()` at line 566; harmless redundant double-encoding guard.

### backend/services/opportunityMatcher.js

- **[important]** `backend/services/opportunityMatcher.js:192` — `SELECT * FROM exclusion_rules WHERE action IS NOT NULL` is not profile/tenant-scoped; exclusion rules apply globally to every profile's matching. If rules are meant per-profile/org, suppression leaks across tenants (could be intentionally global — confirm).
- **[nit]** `backend/services/opportunityMatcher.js:191-194` — `catch { /* table may not exist yet */ }` swallows all errors from the exclusion-rules query, not just missing-table; a malformed row or DB error silently disables exclusion suppression with no log.
- **[nit]** `backend/services/opportunityMatcher.js:288-298` — pipeline idempotency matches on `(funding_opportunity_id = ? OR title = ?)`; title-only matching can falsely treat two distinct opportunities sharing a title as duplicates and skip the save.
- **[nit]** `backend/services/opportunityMatcher.js:217` — `exclusion?.decision === 'WATCH'` -15 penalty is silently skipped whenever the rules query failed (default `{decision:'ALLOW'}` from the catch path).

### backend/services/opportunityNormalizer.js

- **[nit]** `backend/services/opportunityNormalizer.js:482-492` — `requiresWomen` passes an array of `RegExp` objects to `matchesAnyPattern`, which calls `containsSearchPhrase` doing `String(phrase).toLowerCase()` + `.includes()`. A RegExp stringifies to e.g. `/\bfemale\s+students?\b/i`, so `.includes()` looks for that literal slash-delimited string and never matches — the regex women-detection patterns are effectively dead (only the explicit flag and needs-based fallback work).
- **[nit]** `backend/services/opportunityNormalizer.js:369-370` — `NEED_ALIAS_MAP[cat?.toLowerCase()]` silently drops non-string category entries (filtered out by `.filter(Boolean)`); safe but lossy on malformed JSON.

### backend/services/opportunityRealityGate.js

- **[nit]** `backend/services/opportunityRealityGate.js:121-128` — `isOfficialHost` treats any `*.gov`/`*.mil` host as official (intended-but-broad trust assumption); logic is otherwise sound (`grants.gov.evil.com` correctly excluded).
- **[nit]** `backend/services/opportunityRealityGate.js:341,347` — `'link_marked_broken'` can be pushed twice for directory rows, duplicating the reason in `reasons[]`. Cosmetic.

### backend/services/opportunityScope.js

- **[important]** `backend/services/opportunityScope.js:98-113` — `appendWhere` decides WHERE-vs-AND with `/\bWHERE\b/i.test(sql)` against the *entire* SQL string, and `tailRx` matches the first `ORDER BY/GROUP BY/LIMIT` anywhere. For composed SQL with a subquery/CTE WHERE (but no outer WHERE), it appends ` AND ...` to a query with no outer WHERE (syntax error), or splices the scope clause into the middle of a subquery. Safe only for flat SELECTs.
- **[nit]** `backend/services/opportunityScope.js:70-75` — when no `profileId` is given, forces `profile_id IS NULL` (safe public-only default), but any caller that forgets to pass `profileId` silently hides all profile-owned rows with no signal — a foot-gun.

### backend/services/opportunityTrust.js

- **[nit]** `backend/services/opportunityTrust.js:219-223` — `JSON.parse(opp.reality_reasons)` falls back silently on malformed JSON (acknowledged in comment); the malformed-data case is invisible (no warn/metric).
- **[nit]** `backend/services/opportunityTrust.js:385-393` — when `persistedRealityStatus === 'allowed'|'downgraded'`, the code resurrects `display = true` based on the insert-time verdict, which can override a *fresh* time-dependent `expired` hide — an opportunity that has since expired could be force-displayed because the stored verdict predates the deadline passing.

### backend/services/opportunityValidationLayer.js

- **[important]** `backend/services/opportunityValidationLayer.js:219` — `WHERE is_active = ${activeVal}` interpolates `activeVal` (`'TRUE'`/`'1'`) directly into SQL. Value is derived from `db.dialect` (not user input) so not injectable, but it is string-interpolated SQL that violates the parameterized/`toDbBoolean` house style (and is exactly what the mission audit flags).
- **[nit]** `backend/services/opportunityValidationLayer.js:300` — comment says "passes the REVIEW threshold (score >= 25)" but the filter is `s.score >= 5`; stale comment, effective floor is far more permissive.
- **[nit]** `backend/services/opportunityValidationLayer.js:391` — `const result = assertMatchingReturnsResults(...)` assigned but never used (function throws on failure). Dead assignment.
- **[nit]** `backend/services/opportunityValidationLayer.js:19-38` — `isValidRealUrl`, `isLoanLike`, `isMatchingFunds`, `_isPlaceholderUrl`, `extractHostname` imported but never referenced. Dead imports.

### backend/services/opportunityValidator.js

- **[important]** `backend/services/opportunityValidator.js:264-269` — `checkUrlDuplicate` hardcodes `WHERE is_active = 1`. On Postgres `is_active` is boolean, so `= 1` raises `operator does not exist: boolean = integer`, caught at line 280 and logged — URL dedup is silently disabled on every Postgres call (Railway production). Dialect bug.
- **[nit]** `backend/services/opportunityValidator.js:264-279` — even when working, dedup only scans `LIMIT 500` active rows and compares in JS; duplicates beyond the first 500 rows are missed.
- **[nit]** `backend/services/opportunityValidator.js:236-247` — `hasActionableDirectoryLink` returns `true` as its final fallback (line 247), so the earlier `.gov/.edu/.org`/known-directory checks are redundant dead branches — every non-search-engine URL is "actionable."

---

## Summary

Files reviewed: 31 loose service files (g–o). Severity counts: **3 critical**, **23 important**, **~40 nit**.

**Critical:**
1. `linkVerificationService.js:101-119` — SSRF: `fetch(url, { redirect: 'follow' })` on untrusted ingested URLs with no internal-host block (169.254.169.254 / localhost / RFC1918 reachable).
2. `medicalNecessity.js:40-46, 282-309` — IDOR on PHI: profile/grant/opportunity loaded by raw ID with no owner/tenant predicate; another user's full medical profile can be extracted and turned into a physician-signable letter.
3. (PHI/PII exposure also flagged in `medicalNecessity.js` prompt construction and logging, lines 340-343 / 48-59.)

**Top recurring important themes:**
- Dialect bugs that silently no-op in production Postgres: `opportunityValidator.js:264` (URL dedup disabled), `missionHealthService.js:232` (24h metric always null), `jobBackpressure.js:205` (SQLite retry query no-op).
- Missing profile/tenant scoping on write/dedup/exclusion paths: `opportunityInserter.js:502/723`, `opportunityMatcher.js:192`, `knowledgeBaseProcessor.js:165-219`, `hamiltonApplicationAgent.js:122`.
- Prompt-injection of untrusted crawled/uploaded text into LLM calls, some persisted: `grantApplicationApproachAdvisor.js:206` (persists unvalidated contact_*), `knowledgeBaseProcessor.js:84`, `medicalNecessity.js:340`, `itemCatalogService.js:324`.

Also notable: `hamiltonApplicationAgent.js:380/402/426` calls adapter methods without `await` (correctness landmine if any adapter is async), `needsBasedQueryExpander.js:526` has a dead applicant-type condition (`applicantTypes` plural + `Set === 'student'`) causing missed matches, and `opportunityScope.js:98` `appendWhere` is unsafe for subquery/CTE SQL. No SQL injection via user input was found — all genuinely dynamic SQL values are parameterized; the only string-interpolated SQL is dialect-derived boolean literals.
