# Backend Services Audit — Loose service files p–z (`backend/services/*.js`, maxdepth 1)

Scope: top-level `.js` files in `backend/services/` whose filename starts with letters p–z (case-insensitive). Subdirectories excluded. 46 files reviewed function-by-function.

Severity legend: **critical** (data loss / security / correctness that breaks core behavior) · **important** (real bug or risk, narrower blast radius) · **nit** (style, dead code, minor robustness).

---

### backend/services/pipelineAutomation.js
- **[important]** `backend/services/pipelineAutomation.js:539-548` — The status `UPDATE` and the audit-event write are not transactional. The grant status is updated, then `recordAutomationEvent` runs separately; if the event insert throws a non-FK error it propagates and aborts the loop after the status was already committed, leaving an advanced grant with no audit trail.
- **[nit]** `backend/services/pipelineAutomation.js:476,494,515` — Several `handoffReason`/`aiSummary` strings contain mojibake (`â`) where an em-dash was intended, e.g. `'Both OpenAI and Anthropic failed â manual review required.'`. Cosmetic, but these strings are persisted to `grant_pipeline_events`.
- **[nit]** `backend/services/pipelineAutomation.js:301,328` — `PROCESSABLE_STATUSES` is expanded into the `IN (...)` list via `statusPlaceholders` (parameterized — safe), but the same list is also spread into `.all(...)` 3+ times; fine, just verbose and easy to desync if the array changes.

### backend/services/pipelineDismissals.js
- **[nit]** `backend/services/pipelineDismissals.js:305-308` — `clearDismissal` builds the DELETE with `OR`-joined identity conditions (`fingerprint`, `opportunity_id`, `lower(title)`). A title-only match can clear tombstones for a *different* opportunity that happens to share a title for the same profile, re-surfacing a deliberately-dismissed source. Documented trade-off (recall over suppression) but worth flagging.
- **[nit]** `backend/services/pipelineDismissals.js:84-92` — Partial unique index creation is wrapped in try/catch and only `log.warn`-ed on failure; the dedup then silently relies on the runtime pre-check, which has a TOCTOU window between `findDismissal` and `INSERT` (the catch at 204-212 handles it, so net-safe).

### backend/services/pipelineGoalCleanupService.js
- **[important]** `backend/services/pipelineGoalCleanupService.js:434` — `buildSelectSql` scopes by `WHERE g.profile_id = ? OR (g.organization_id IS NOT NULL AND g.organization_id = ?)`. The org branch is keyed on `profile.organization_id`, so a profile with an org id will pull in *every* grant sharing that org id — including grants belonging to other profiles in the same org — and may then DELETE them (when `dryRun=false`) attributed to this profile's audit. Cross-profile deletion within an org.
- **[important]** `backend/services/pipelineGoalCleanupService.js:558-566` — In non-dry-run mode, each removed item is deleted in its own statement with a per-row try/catch; there is no transaction wrapping the per-profile removal set, so a mid-loop failure leaves a partially-purged pipeline.
- **[nit]** `backend/services/pipelineGoalCleanupService.js:507` — `selectStmt.all(profile.id, profile.organization_id || '__none__')` passes the literal sentinel `'__none__'`; harmless but relies on no real org id ever equaling that string.

### backend/services/pipelineLifecycleService.js
- **[nit]** `backend/services/pipelineLifecycleService.js:314-315` — Dead code: `const { createRequire } = await import('module')` then `const require = createRequire(import.meta.url)` — `require` is never used below (the inline comment itself says "delete this line entirely"). The comment also contains mojibake.
- **[nit]** `backend/services/pipelineLifecycleService.js:93,145,199` — Status/notes updates build the note via SQL string concatenation of the `deadline` column (`... || deadline || ...`). These are column references (not user input) so no injection, but appending an unbounded `notes || ' | ' || ...` on every run can grow `notes` without limit across repeated passes.
- **[nit]** `backend/services/pipelineLifecycleService.js:41` — `isExpired` compares `deadlineStr.slice(0,10) < today()` as strings; correct only when deadline is ISO `YYYY-MM-DD`. A `MM/DD/YYYY` deadline would mis-sort. (Archive query at line 75 uses the same string `<` comparison.)

### backend/services/portalCheckService.js
- **[critical]** `backend/services/portalCheckService.js:117-125,151-162,198-204,248-255` — SSRF. `fetchUrlOnce` issues server-side GETs to URLs pulled directly from the `university_applications` profile section (`app.portals.*_url`). `isValidUrl` only checks the protocol is http/https — no block on `localhost`, `127.0.0.1`, `169.254.169.254` (cloud metadata), private/link-local ranges, or non-standard ports. Redirects (`res.headers.location`) are followed with the same lack of validation. Response bodies are captured/stored, making this a blind-SSRF + metadata-exfiltration vector.
- **[important]** `backend/services/portalCheckService.js:432-466,693-719` — No authorization check that the caller owns `profileId` before fetching every portal URL attached to that profile. Auth must be enforced upstream; nothing here guards it.
- **[important]** `backend/services/portalCheckService.js:502-509` — `syncAwardToProfile` runs the insert only inside `guardProfileSectionForWrite(...).then(...)`; if the guard rejects, the award write is silently skipped (surfaced only as a caught warning at the caller), so award sync can fail without signal.
- **[nit]** `backend/services/portalCheckService.js:122-124` — Redirect handling recurses (`resolve(fetchUrlOnce(res.headers.location, ...))`) with no depth/loop cap and re-applies the full timeout per hop → unbounded total time on a redirect loop.
- **[nit]** `backend/services/portalCheckService.js:130-132` — On exceeding the 512KB cap, `req.destroy()` is called but the `'end'` handler never fires; the promise settles only via the `error`/timeout path.
- **[nit]** `backend/services/portalCheckService.js:70` — `detectScholarshipAmount` falls back to the largest dollar figure on the page when no award keyword is near an amount, mis-detecting tuition/fees as scholarship awards.

### backend/services/privateFoundationCrawler.js
- **[nit]** `backend/services/privateFoundationCrawler.js:631` — Geographic match uses `geographicScope.toLowerCase().includes(profileState)` (substring); a 2-letter state code can substring-match unrelated scope strings. Latent because registry scopes are single-state or `'national'`.
- **[nit]** `backend/services/privateFoundationCrawler.js:653-658` — `areaLower.split('_')[0]` is dead: line 648 already replaced `_` with spaces, so `split('_')` never splits. Intended first-token extraction never happens.
- **[nit]** `backend/services/privateFoundationCrawler.js:713-715` — DB dedup failure swallowed by a bare `catch {}` with no log, diverging from the structured-logging used elsewhere.
- **[nit]** `backend/services/privateFoundationCrawler.js:629-635,685-693` — Geographic check duplicated between `scoreFoundation` and the main loop (redundant double-filtering).

### backend/services/productionReadinessChecks.js
- No issues found. Pure, env-only checks with explicit level semantics; no DB/SQL/IO.

### backend/services/profileCoverage.js
- No issues found. Pure coverage computation; `coverage = weighted > 0 ? weightedPresent/weighted : 0` guards divide-by-zero; missing fields reduce score without disqualifying (matches mission rule).

### backend/services/profileDedupeService.js
- **[important]** `backend/services/profileDedupeService.js:494-496` — `columnExists` SQLite branch validates `table` against an `ALLOWED_TABLES` allowlist before interpolating into `PRAGMA table_info(${table})` — good — but note `tableName` flows from caller-supplied `repoints`/merge config, so the allowlist is load-bearing; any new repoint target must be added to the list or the column check silently returns false and the repoint is skipped (data left on the loser).
- **[important]** `backend/services/profileDedupeService.js:846,899-917` — `audit_logs` update and insert are wrapped in `try {} catch {}` that swallows all errors silently; a failed audit write during a real (non-dry-run) merge leaves no trace of a destructive profile merge.
- **[nit]** `backend/services/profileDedupeService.js:795` — Active-application guard `status IN (?, ?, ?)` checks only `'submitted','under_review','approved'`; other in-flight statuses (e.g. `pending`) would not block a merge that deletes the loser profile.
- **[nit]** `backend/services/profileDedupeService.js:391-401` — Winner-scoring weights are magic numbers (`sectionCount*50`, `billingCount*40`, etc.) with no named constants; correct but brittle and untestable in isolation.

### backend/services/profileEnrichment.js
- **[important]** `backend/services/profileEnrichment.js:144-152` — `invokeJsonWithFallback` is handed the entire profile payload (display name, signals, existing section data — potential PII) as the prompt with no scrubbing; relies solely on the system-prompt instruction "Never fabricate … sensitive personal identifiers." PII still leaves the system to the LLM provider.
- **[nit]** `backend/services/profileEnrichment.js:187` — Stray comment `// Remove this entire forEach block as it's redundant with the for loop below` references a block that no longer exists — leftover TODO noise.
- **[nit]** `backend/services/profileEnrichment.js:222` — Persisted log note contains mojibake (`â`) where an em-dash was intended.

### backend/services/profileFieldUsageRegistry.js
- No issues found. Pure data registry; correctly enforces `must_not` / `raw_external_use_allowed:false` invariants.

### backend/services/profileGapAnalyzer.js
- **[important]** `backend/services/profileGapAnalyzer.js:275` — `potentialProgramsUnlocked` math is a confused no-op: `totalRequired = g.missingFields.length + (spec.requiredFields.length - g.missingFields.length)` algebraically equals `spec.requiredFields.length`, so the verbose expression reduces to `missingFields/requiredFields` and the comment's "weight by proportion of missing fields" intent is not what the code does (a fully-empty section yields ratio 1.0, not a partial weight).
- **[nit]** `backend/services/profileGapAnalyzer.js:275` — If `SECTION_SPECS.find(...)` ever returned undefined, `undefined - missingFields.length` yields `NaN` silently rather than throwing.
- **[nit]** `backend/services/profileGapAnalyzer.js:179-187` — `countFilledFields` and `totalFieldCount` are dead code (never called).

### backend/services/profileHelpers.js
- **[important]** `backend/services/profileHelpers.js:1224` — `if (financialSection.annual_income && !financial.householdIncome)` couples two distinct fields, so annual-income poverty inference is skipped whenever a household income is already present, even when annual income is the more accurate per-applicant figure.
- **[nit]** `backend/services/profileHelpers.js:1764` — `nowYear - parseNumber(founding_year)`: when `founding_year` is non-numeric, `parseNumber` returns `null`, so `age = nowYear - null = nowYear`; the later `if (age !== null …)` guard is dead because `age` can never be null here.
- **[nit]** `backend/services/profileHelpers.js:169,321-326,502,539,1081` — `console.warn` used for diagnostics instead of the module `log` (createLogger) used elsewhere in the same file; inconsistent (no PII leaked — ids/messages only).
- **[nit]** `backend/services/profileHelpers.js:1846-1851,1930-1938` — Semicolon-prefixed ASI guards with skewed indentation; functionally correct but confusing.

### backend/services/profileNeedsInterpreter.js
- **[important]** `backend/services/profileNeedsInterpreter.js:576-590` — `interpretProfileNeedsFromDb` runs `SELECT * FROM profiles WHERE id = ?` and `SELECT … FROM profile_sections WHERE profile_id = ?` with no tenant/owner scoping. Parameterized (no injection) but allows cross-tenant profile reads if callers don't pre-authorize `profileId`.
- **[nit]** `backend/services/profileNeedsInterpreter.js:514` — Missing-ZIP detection checks only `zip` keys (`p?.zip`, `basic_information.zip`, `location_focus.zip`); profiles that store `postal_code`/`zip_code` instead will false-positive as "ZIP missing", producing a spurious next-step prompt.

### backend/services/profileNormalizer.js
- **[important]** `backend/services/profileNormalizer.js:847-851,1189-1192` — Income parsing uses `Number(fa.annual_income ?? fa.household_income ?? 0)`; a formatted value like `"$24,000"` becomes `NaN`, so low-income/below-poverty checks silently fail. `profileHelpers.parseNumber` strips formatting — divergent parsing of the same field between the two normalizers.
- **[nit]** `backend/services/profileNormalizer.js:382,88` — Document need-signal scan matches the 2-letter token `'ce'` (→ `professional_development`) as a discrete token; OCR noise / stray "CE" headers will add a false `professional_development` need despite the discrete-token guard.
- **[nit]** `backend/services/profileNormalizer.js:297,545` — `normalizeNeedCategory` returns the raw key (`?? key`) when not in the alias map, so arbitrary tag strings become "canonical" need categories — unbounded vocabulary pollution of `needCategories`.

### backend/services/profileOrganizationSync.js
- **[nit]** `backend/services/profileOrganizationSync.js:204` — `organization_type: p.applicant_type === 'organization' ? 'organization' : p.applicant_type ?? ''` — the ternary precedence is fine, but a falsy-but-defined `applicant_type` (e.g. `''`) falls through to `''`; minor.
- **[nit]** `backend/services/profileOrganizationSync.js:301-305,420-425` — `syncOrganizationToProfileSections` rethrows on the timestamp-update failure (425) while `fillMissingProfileSectionsForProfile` swallows the same failure (303-305); inconsistent error posture for the identical write.

### backend/services/profileReadinessService.js
- **[nit]** `backend/services/profileReadinessService.js:579` — `const earned = present + (phone ? 1 : 0) + (website ? 1 : 0)` where `present` is a boolean — relies on `true → 1` coercion; fragile/confusing (should be `(present ? 1 : 0)`).
- **[nit]** `backend/services/profileReadinessService.js:51` — `const stmt = await db.prepare(...); profile = await stmt.get(...)` two statements on one line; awaits `db.prepare` (sync in better-sqlite3) — harmless but inconsistent with the rest of the file.
- **[nit]** `backend/services/profileReadinessService.js:85,316` — `row.data ? JSON.parse(row.data) : {}` is wrapped in try/catch (safe), but the first function uses raw `JSON.parse` while other services in this package use `safeParseJSON`; convention divergence.

### backend/services/profileRevalEngine.js
- **[nit]** `backend/services/profileRevalEngine.js:25` — `Math.abs(Number(f.new)) > 10 || Math.abs(Number(f.old) - Number(f.new)) > 5`: when `f.new`/`f.old` are non-numeric, `Number(...)` is `NaN` and both comparisons are false, so a geo change with non-numeric values is silently classified as no-geo-shift.
- **[nit]** `backend/services/profileRevalEngine.js:66` — Persisted/inline comment contains mojibake (`â`).

### backend/services/profileSectionsManager.js
- No issues found. Correct dialect-aware placeholders (`$n` for Postgres, `?` for SQLite), guarded JSON parsing, divide-by-zero guard at line 155 (`totalKeys === 0 ? 0 : …`).

### backend/services/profileTypeRegistry.js
- No issues found. Pure, frozen data registry; alias index built lazily; `resolveProfileType` returns null (not throw) for unknown types per the documented contract.

### backend/services/purgeDiffUtils.js
- **[nit]** `backend/services/purgeDiffUtils.js:141,154,164` — `tokenDiffRatio` / `jaccardSimilarity` / `jaroWinkler` appear unused by the in-package consumers; likely dead exports.
- **[nit]** `backend/services/purgeDiffUtils.js:49,70` — Doc says `max(totalA, totalB, 1)` but code uses `Math.max(tokensA.length, tokensB.length)` without the `,1` floor; safe only because both-empty / one-empty are guarded earlier — diverges from its own contract.

### backend/services/purgeMaterialChange.js
- **[important]** `backend/services/purgeMaterialChange.js:54,68` — Status/deadline change detection requires both old and new to be truthy (`if (prevStatus && currStatus && prevStatus !== currStatus)`); a real transition to/from empty/null (e.g. `"open"` → `""`, status cleared) is silently treated as no material change.

### backend/services/purgeVerification.js
- **[important]** `backend/services/purgeVerification.js:62-70` — Duplicated/dead fetch-availability guard: two consecutive `if (!fetch_)` blocks; the second (67-70) is unreachable. The first block's string literal contains mojibake (`â`) and is mis-indented.
- **[nit]** `backend/services/purgeVerification.js:198` — `extractTextSignals` strips tags but does not bound body size or decode entities; runs the full phrase scan over arbitrarily large `responseText`.
- **[nit]** `backend/services/purgeVerification.js:179-181` — `schema_date_modified` signal is recorded but never influences `statusHint`, contradicting its "weak positive signal" comment.

### backend/services/regionalPurgeService.js
- **[critical]** `backend/services/regionalPurgeService.js:339-347,368-369` — When `sourceUrl` is missing, the opportunity is unconditionally forced to `verified:true / statusHint:'closed' / verificationLevel:'primary'`, which transitions it straight to `SUPPRESSED` (`reason: no_source_url`). A simple data-completeness gap (no `source_url`) thus permanently suppresses a legitimate, possibly-active opportunity.
- **[important]** `backend/services/regionalPurgeService.js:249-270,287-307` — Queries use `?` placeholders while branching on `db.dialect === 'postgres'` only for the `is_active` *value*. Postgres `pg` requires `$1,$2,…` placeholders, so every prepared query here would fail against a real Postgres adapter — the service is effectively SQLite-only despite the dialect-aware code.
- **[important]** `backend/services/regionalPurgeService.js:287-307` — No profile/tenant scoping: `funding_opportunities` are selected and mutated by `state` + `suppression_state` only. Suppression is global and flips visibility for every profile/tenant referencing that opportunity (verify whether the table is intended to be global).
- **[important]** `backend/services/regionalPurgeService.js:350-355,383` — On the no-material-change path an HTTP probe is still performed with errors swallowed (`catch { /* non-fatal */ }`); a transient 404 from a non-authoritative mirror can flip suppression state, and probe failures never reach the audit trail.
- **[nit]** `backend/services/regionalPurgeService.js:472,526` — `persistSuppressionTransition` recomputes tier via `inferSourceTier(opportunity.source_url)` ignoring `opp.source_tier`, while `updateLastChecked` prefers the existing tier — inconsistent tier handling between write paths.

### backend/services/relevanceFilterRules.js
- **[important]** `backend/services/relevanceFilterRules.js:485-486,53` — `geographic_title_state_mismatch` compares `_normalizeState(profileState.toLowerCase())` to a title abbr; a profile state stored as a full name not present in `_STATE_ABBREVIATIONS` passes through unmapped and can false-positive a mismatch (hard-reject path).
- **[nit]** `backend/services/relevanceFilterRules.js:686,785-788,247` — Comment numbering inconsistency ("Rule 19 REMOVED" vs another rule labeled "19"), and `_hasConcreteDeadline` (line 247) is dead code with no rule referencing it.
- **[nit]** `backend/services/relevanceFilterRules.js:733,270` — `SSI`/`SSDI` tokens appear in multiple rules that could each reject the same opportunity with different reasons; rule precedence is undefined within this file.

### backend/services/requestIdErrorStore.js
- **[important]** `backend/services/requestIdErrorStore.js:40-48` — Stores full error `stack` (up to 8000 chars) + `message` in an in-process Map retrievable via `getRequestError`. Stack traces contain internal paths and can carry PII/secrets from error context; confirm the consumer endpoint scopes access (potential info leak if exposed to clients).
- **[nit]** `backend/services/requestIdErrorStore.js:34-38` — Each `recordRequestError` does an O(n) scan to evict expired entries and re-parses `Date` per entry; under error storms this is wasteful. Store numeric `occurred_at` ms once.

### backend/services/reverseLookupService.js
- **[important]** `backend/services/reverseLookupService.js:164-184,292-296` — Hardcoded `is_active = 1` / `is_national = 1` integer literals. SQLite-specific; on Postgres (production per CLAUDE.md) where these columns are boolean, `is_active = 1` will error or misbehave. Unlike sibling services, this one does not branch on `db.dialect`.
- **[nit]** `backend/services/reverseLookupService.js:259-261,128` — `findSimilarOrgsFunders` issues up to ~10 sequential ProPublica round-trips (each preceded by a 250ms sleep) with no overall timeout/cap → unbounded latency per profile.
- **[nit]** `backend/services/reverseLookupService.js:289-296` — `catalogEins` includes local-catalog eins that can never match the `source = 'propublica.990'` existence query, needlessly bloating the `IN (...)` parameter list.

### backend/services/reviewerAgent.js
- **[nit]** `backend/services/reviewerAgent.js:168-188` — Redundant `!== undefined` checks after values were already narrowed to `number | null` at 166; dead conditions.
- **[nit]** `backend/services/reviewerAgent.js:160` — `/^(.)\1{10,}$/` only flags whole-string single-char repeats; `"aaaaaaaaaaa more text"` passes the "empty-looking content" guard.
- **[nit]** `backend/services/reviewerAgent.js:195` — `100 * 365 * 24 * 60 * 60 * 1000` ignores leap years for the far-future sanity check (~25 days off over a century; immaterial).

### backend/services/savedGrantsSchema.js
- **[nit]** `backend/services/savedGrantsSchema.js:9,26` — `ensureSavedGrantsProfileColumn` takes `isPostgres` as a param while `ensureFundingOpportunityLinkStatus` re-derives `db?.dialect === 'postgres'`; minor inconsistency in dialect threading. All DDL is parameter-free constant SQL — no injection.

### backend/services/scheduledAutoDiscovery.js
- **[important]** `backend/services/scheduledAutoDiscovery.js:159,75,161` — Daily run guard mixes timezones: `now.getHours() !== CONFIG.hour` uses **local** server time, but `already_ran_today` (`utcDayStart()`) and `_lastBatchRunDate` (`now.toISOString().slice(0,10)`) use **UTC**. On servers offset from UTC, the dedupe key can be set on the wrong calendar day, skipping or double-firing a daily run.
- **[nit]** `backend/services/scheduledAutoDiscovery.js:70` — If `computeProfileDigest` returns null/empty (e.g. on error), profile-change detection is silently skipped without log.
- **[nit]** `backend/services/scheduledAutoDiscovery.js:144,173` — Raw `console.warn`/`console.error` instead of the module `log` logger.

### backend/services/schoolLookupFallback.js
- No issues found.

### backend/services/schoolPortalImportService.js
- **[important]** `backend/services/schoolPortalImportService.js:341-349` — `findImportedAwardIndex` falls back to `Number(entry.amount) === Number(award.amount)`; when both amounts are `null`, `Number(null) === Number(null)` is `0 === 0 → true`, so two distinct awards with no amount but equal titles collide/dedupe incorrectly.
- **[nit]** `backend/services/schoolPortalImportService.js:321,295` — Double JSON parse: `safeParseJSON(row.data, {})` then the already-parsed object is passed to `normalizeSectionData`, which re-checks for a string; the inner parse is redundant.
- **[nit]** `backend/services/schoolPortalImportService.js:469-502` — `upsertSchoolPortalAwardAsOpportunity` swallows all non-unique errors and returns `false` with no log, despite the doc comment claiming an operator-visible warning is emitted.
- **[nit]** `backend/services/schoolPortalImportService.js:407-427` — Writes scholarship metadata to the global `funding_opportunities` table with no tenant/profile scoping (intentional per comment — flag as a design decision, not a bug).

### backend/services/schoolPortalMerger.js
- **[critical]** `backend/services/schoolPortalMerger.js:326-338` — Email-match path returns the first profile for a matched user (`ORDER BY created_at ASC LIMIT 1`) and merges school-supplied education/demographic PII into it with no student/external-ID ownership or consent verification. If emails are reused or spoofed by a partner feed, this is cross-tenant data injection/leakage.
- **[important]** `backend/services/schoolPortalMerger.js:404-413` — Newly created profile is inserted with `user_id` NULL (owned by no user) but populated with PII (name/email/DOB via `basic_information`); orphan profiles may be mishandled by owner-scoped queries elsewhere.
- **[nit]** `backend/services/schoolPortalMerger.js:344-353` — The `json_extract` / `IFNULL` email lookup is SQLite-specific; on Postgres `json_extract` does not exist, so (wrapped in try/catch) it silently never matches, defeating the intended dedupe in a Postgres production deploy.

### backend/services/seasonalCrawlCalendar.js
- **[nit]** `backend/services/seasonalCrawlCalendar.js:375-383` — `isOpeningSoon` JSDoc says "within the next `withinDays` days" but the parameter and logic are month-based; stale doc.
- **[nit]** `backend/services/seasonalCrawlCalendar.js:388-395` — `isRecentlyClosed` checks `prevMonth === program.closeMonth`, but `isProgramOpenInMonth` treats `closeMonth` as inclusive (still open); off-by-one — it reports "recently closed" one month too early relative to the inclusive-close semantics.

### backend/services/serviceCatalogExtractParser.js
- **[nit]** `backend/services/serviceCatalogExtractParser.js:42-58` — `parseMoneyToCents` strips `/hr` and `$` then `Number()`s the remainder; a malformed `$85/mo` parses to a one-time `85`. Low risk given controlled input.
- **[nit]** `backend/services/serviceCatalogExtractParser.js:138` — Log line contains a mojibake (`â`) where an em-dash was intended.

### backend/services/serviceCatalogStore.js
- **[important]** `backend/services/serviceCatalogStore.js:409` — `if (ids.length > 1000) throw new Error('Too many IDs for query')` runs *after* `placeholders` is built and hard-throws inside `listServiceCatalog` rather than paginating/degrading; latent crash if the catalog ever exceeds 1000 active items.
- **[nit]** `backend/services/serviceCatalogStore.js:273,28` — Dynamic SQL fragments (`nowSqlLiteral`, `trueLit`, `placeholders`) are derived from dialect/array-length only, never user input — no injection. `SEED_TTL_MS` from env has no upper bound (a huge value disables re-seeding).

### backend/services/sharedGeo.js
- No issues found. Coordinate validation guards NaN/non-number; haversine math correct.

### backend/services/smartMatcherIntent.js
- **[important]** `backend/services/smartMatcherIntent.js:805-824` — `interpretWithOpenAI` sends the user's raw free-text funding request (possible PII) to OpenAI with no scrubbing, unlike the crawler path that uses `looksLikePiiTerm`. The system prompt instructs the model "No PII" but the *input* is unfiltered.
- **[nit]** `backend/services/smartMatcherIntent.js:373,27` — Comment says `MAX_TERMS=18` but the constant is `24`; stale comment.
- **[nit]** `backend/services/smartMatcherIntent.js:734,268` — `haystack` recomputed, duplicating the `detectPrimaryCategory` logic.

### backend/services/snapshotSerialization.js
- **[nit]** `backend/services/snapshotSerialization.js:49` — Legacy `{}`-serialized Sets are restored as empty Sets, discarding data if an old snapshot stored a populated plain object under a set key (documented as intentional for pre-fix snapshots).

### backend/services/sourceRegistry.js
- **[nit]** `backend/services/sourceRegistry.js:1298,1308` — Correlated subqueries reference the outer table by name (`crawler_source_runs.source_id`) rather than an alias; works in both dialects but fragile (wrapped in try/catch → degrades to empty map).
- **[nit]** `backend/services/sourceRegistry.js:1564-1572` — `looksLikePiiTerm` rejects `\d{6,}` runs, which also drops legitimate 6-digit CFDA/program numbers (recall-vs-PII trade-off).

### backend/services/stripeService.js
- **[important]** `backend/services/stripeService.js:155-169` — `recordStripeEventIfNew` provides idempotency only by inserting the event id; it does not wrap event *processing* in the same transaction, so a crash around the insert can cause double-processing or lost processing. Exactly-once depends on the webhook route doing insert+process atomically — verify upstream.
- **[important]** `backend/services/stripeService.js:88-135` — `createCheckoutSessionForPrice` accepts `customerId`/`metadata`/`priceId` from the caller with no in-service assertion that `customerId` belongs to the authenticated user; a route passing an attacker-influenced `customerId` could target another tenant's customer. Tenant scoping must be enforced by callers.
- **[nit]** `backend/services/stripeService.js:152` — `verifyAndConstructStripeEvent` correctly uses `stripe.webhooks.constructEvent(rawBody, sig, secret)` (signature verification present) — but it requires the **raw** body; verify the webhook route mounts a raw-body parser, or verification silently fails. No secret keys are logged (good).
- **[nit]** `backend/services/stripeService.js:72,131` — Logs Stripe `error.message`, which can occasionally echo request parameters (email/id fragments); low risk.

### backend/services/universityDocumentClassifier.js
- **[critical]** `backend/services/universityDocumentClassifier.js:71` — `.get(String(profileId).replace(/[^0-9]/g, ''))` strips all non-digit characters from the profile id before querying. Profile ids are hex strings (`lower(hex(randomblob(16)))`) containing a–f, so the lookup is mangled and almost always fails to match (or matches the wrong profile after digit-stripping), silently returning `[]` and breaking document→university classification for essentially all profiles.
- **[nit]** `backend/services/universityDocumentClassifier.js:83,87` — Parse/load failures logged via `console.error` and swallowed to `[]`, masking the line-71 bug.

### backend/services/zeroResultLadder.js
- **[nit]** `backend/services/zeroResultLadder.js:145-156` — When `minScore` is already 0, the relaxation loop's `if (t >= minScore) continue` skips every tier, so `relaxed` stays empty and falls through to DIRECTORY even though tier-1 already used `>= 0` (intended, but a `minScore:0` strong-direct miss never yields relaxed results).

---

## Summary

Across 46 p–z service files: **6 critical**, **~24 important**, and a long tail of nits.

The single highest-severity issue is the **SSRF in `portalCheckService.js`** (server-side fetch of DB/user-controlled portal URLs with only a protocol check, plus unvalidated redirect-following — exposes cloud metadata / internal services). Close behind: **`regionalPurgeService.js:339-347`** permanently suppresses any opportunity that merely lacks a `source_url` (treats a data gap as confirmed-closed), and **`universityDocumentClassifier.js:71`** digit-strips hex profile ids so the classification lookup is broken for virtually every profile. Other notable themes are **cross-profile/cross-tenant scope gaps** (`pipelineGoalCleanupService.js:434` org-keyed deletes, `schoolPortalMerger.js:326-338` email-collision PII merge, missing tenant scoping in `profileNeedsInterpreter`/`portalCheckService`/`regionalPurgeService`), **Postgres-vs-SQLite dialect breakage** (`regionalPurgeService` and `reverseLookupService` use `?` placeholders / `is_active = 1` integer literals that fail on the production Postgres adapter), **Stripe correctness preconditions** the service can't self-enforce (raw-body webhook verification, idempotency-around-processing, checkout customer scoping), and **unscrubbed PII sent to LLMs** (`profileEnrichment`, `smartMatcherIntent`).
