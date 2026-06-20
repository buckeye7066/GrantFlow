# backend/utils audit

### backend/utils/safeTokenEqual.js
- **[nit]** `backend/utils/safeTokenEqual.js:22` — Empty-string inputs return `false` even when both are empty (`a === b === ''`). Documented as intentional ("returns false for empty input"), so this is by-design, but callers must never treat an empty configured secret as comparable. The core timing-safe logic is correct: type check → empty check → length check (`bufA.length !== bufB.length`) before `crypto.timingSafeEqual`, so no length-mismatch throw and no timing leak on the compare itself. No bug.
- **[nit]** `backend/utils/safeTokenEqual.js:23` — `Buffer.from(a)` uses default utf8 encoding; multibyte secrets compare by byte length, which is fine and consistent for both args. No issue.

### backend/utils/accessControl.js
- **[important]** `backend/utils/accessControl.js:74-97` — The email fallback builds the IN-clause query with `try { broader query } catch { narrower query }`. The broader query references `lower(email)`; on Postgres a missing `email` column raises an error that aborts the surrounding transaction (Postgres marks the tx as failed), so the `catch` fallback query will itself fail with `current transaction is aborted`. On SQLite this is fine. If `isAdminUserWithDb` is ever called inside a caller-managed transaction on PG, the fallback silently fails and admin is denied. Fail-closed, but can cause admins to "lose" admin when scoped by email only — the exact scenario the comment at :48-54 says it is trying to prevent.
- **[nit]** `backend/utils/accessControl.js:256-281` — The non-json1 SQLite `LIKE` fallback builds `%"email"%${escapedEmail}%`. The escaping only handles `\` and `"`, not the LIKE wildcards `%`/`_` in the email local-part (legal per RFC). A crafted email containing `%` could broaden the match and grant access to additional profiles whose JSON happens to match. Low severity (requires the json1-disabled fallback path AND an attacker controlling their own profile email), but it is a profile-scoping correctness gap. Use an ESCAPE clause or escape `%`/`_`.
- **[nit]** `backend/utils/accessControl.js:464-472` — In `ensureGrantAccess`, the legacy fallback branch (no `req.ctx`) only checks `organization_id` accessibility, never `profile_id`. A grant linked solely by `profile_id` (no org) would be denied for a legitimate non-admin owner when `req.ctx` is absent. The `req.ctx` branch (:457) handles profile_id correctly, so this only bites pre-context callers.
- **[nit]** `backend/utils/accessControl.js:36-44` — `isAdminUser` is documented DEPRECATED but still used as the fallback authorization path in `ensureGrantAccess` (:466). Token-claim admin is exactly the email/claim-based path the file header warns against; acceptable only because it is a fallback, but worth flagging.

### backend/utils/runtimeSecrets.js
- **[important]** `backend/utils/runtimeSecrets.js:9-19` — Indentation is broken (lines 10-16 are flush-left inside the `try`), but functionally fine. The real issue: a base64 key that decodes to `< 32` bytes is sha256-stretched (:19) to 32 bytes, while a key `>= 32` bytes is truncated (:17). A short hex/base64 key therefore produces a *different* key than the same bytes provided directly, and the stretch path means two distinct env values can be silently accepted. Not a vuln, but the "fail loudly rather than downgrade" intent (:21-25) is undercut: short-but-valid encodings are quietly accepted via hashing rather than rejected.
- **[important]** `backend/utils/runtimeSecrets.js:55` — The fallback path hashes `AUTH_JWT_SECRET`/`JWT_SECRET`/`SESSION_SECRET` with sha256 to derive the AES key. If any of these secrets is rotated, every previously-stored runtime secret becomes undecryptable (GCM auth-tag failure throws in `decryptRuntimeSecret`). The `console.warn` at :38 notes this, but `decryptRuntimeSecret` (:72-82) has no try/catch, so a single rotation turns every secret read into an unhandled throw at the call site. Recommend wrapping decrypt in a guarded path or strongly requiring `RUNTIME_SECRETS_KEY`.
- **[nit]** `backend/utils/runtimeSecrets.js:74-76` — `decryptRuntimeSecret` does no validation that `iv`/`tag`/`value_ciphertext` are present/non-empty; `Buffer.from(String(undefined),'base64')` yields a 0-length IV and `createDecipheriv` will throw an opaque error. Guard inputs and throw a typed error for observability.

### backend/utils/uploadsDir.js
- **[nit]** `backend/utils/uploadsDir.js:1-5` — Pure re-export of `uploadsPath.js`; no logic. No issues.

### backend/utils/uploadsPath.js
- **[nit]** `backend/utils/uploadsPath.js:6-13` — `normalizeFsPath` swallows `path.resolve` errors and returns the raw string, so a bad input can produce an unresolved path that later writes go to. In practice `path.resolve` virtually never throws; low risk.
- **[nit]** `backend/utils/uploadsPath.js:55-59` — On Windows, any absolute path not under `/temp` or `/tmp` is "likely persistent". A path like `C:\Temp2\uploads` normalizes to `c:/temp2/...` and `lower.includes('/temp')` is false (no leading slash match) — actually `/temp` substring would match `c:/temp2`. Conversely `C:\contemplate\` contains `templat` not `/temp`, fine. The substring test `includes('/temp')` is a heuristic and can misclassify directories like `.../tempo/...` (contains `/temp`) as non-persistent. Heuristic only, not security-relevant.
- No path-traversal vector here: this module resolves base/env-configured directories, it does not join user-supplied filenames. Callers that join user filenames to `uploadsDir` must sanitize separately.

### backend/utils/recordOrigins.js
- **[nit]** `backend/utils/recordOrigins.js:53-60` — `trustedOriginClause` validates the optional `alias` against `/^[A-Za-z_][A-Za-z0-9_]*$/` and throws on bad input — good. The values list is built via `escapeSqlStringLiteral` (doubles single quotes), and all values come from the hardcoded `UNTRUSTED_ORIGINS`/`ALLOWED_RECORD_ORIGINS` constants, so `allowedOriginCheckSQL` (:94-99) is injection-safe. Note the inconsistent indentation (:54-56, :58) but no bug.
- **[nit]** `backend/utils/recordOrigins.js:79-83` — `trustedSourceClause` does NOT validate its `alias` argument, unlike `trustedOriginClause` at :54. All current callers pass static aliases ('fo' etc.), but this is an inconsistency: if a future caller passes a user-influenced alias, `trustedSourceClause` would interpolate it unchecked. Add the same alias regex guard.

### backend/utils/logger.js
- **[important]** `backend/utils/logger.js:101-116` — The logger does NOT redact secrets/PII. `formatContext` JSON-stringifies arbitrary context objects verbatim; nothing routes through `piiScrubber.scrubPII`. Any caller that passes a token, API key, email, or raw error containing secrets will emit it to console and into the in-memory ring buffer (:138-144) that `getRecentLogs` exposes to the admin/Anya tool. The file's own purpose docs claim structured logging but make no redaction guarantee. Given `piiScrubber.js` exists, consider scrubbing context here, at least for the audit-sink fan-out (:67).
- **[nit]** `backend/utils/logger.js:108-112` — The `JSON.stringify` replacer handles `Error` and `bigint` but circular references fall to the `catch` → `String(ctx)` which yields `[object Object]`, losing all context. Minor observability loss.

### backend/utils/safeSql.js
- **[nit]** `backend/utils/safeSql.js:357-366` — `normalizeOperator` allows `!==` as a sentinel but emits it only via the IS NULL / NOT IN / NOT LIKE branches; for a scalar non-null value with `op: '!=='` it would emit `col !== ?` (line 346), which is invalid SQL in both SQLite and Postgres (they use `!=`/`<>`). The `!==` value is only special-cased for null/array, not scalar. A caller passing `{op:'!=='}` with a scalar produces broken SQL. Map `!==` → `!=` for the scalar branch.
- **[nit]** `backend/utils/safeSql.js:331` — `value === null` with default op produces `col IS NULL`; with `op:'!=='` produces `col IS NOT NULL`. Correct.

### backend/utils/safeJson.js
- **[nit]** `backend/utils/safeJson.js:33` — Double-encoded detection only re-parses when the inner string `startsWith('{')` or `('[')`. A double-encoded JSON *scalar* (e.g. `"\"hello\""` → first parse yields `"hello"`) is correctly left as `hello`. But a double-encoded value whose inner JSON is whitespace-prefixed (`' {...}'`) won't match `startsWith('{')` and is returned as the raw string. Edge case only.
- **[nit]** `backend/utils/safeJson.js:51` — `safeStringifyJSON` logs via `console.warn` on failure (e.g. circular ref → throw) and returns fallback. Acceptable; no redaction concern since only the error message is logged.

### backend/utils/validation.js
- **[nit]** `backend/utils/validation.js:9-12` — `parseInt(query.limit,10) || DEFAULT_PAGE_LIMIT`: a legitimate `limit=0` is falsy and silently becomes the default. Same pattern for offset (:14) where `0 || DEFAULT_OFFSET` resolves to default — harmless only if `DEFAULT_OFFSET===0`. Minor.
- **[nit]** `backend/utils/validation.js:46-56` — `sanitizeColumns` whitelists keys but the resulting object's keys are still later interpolated by some callers; this helper does not itself validate identifier shape (relies on the `allowedColumns` Set being trustworthy). Documented as whitelist-based; fine.

### backend/utils/dbValidation.js
- **[nit]** `backend/utils/dbValidation.js:81-99` — `validateDate` returns `dateObj.toISOString().split('T')[0]`, i.e. the UTC date. A local-timezone date near midnight can shift by a day (e.g. `new Date('2026-06-19 23:00 EST')` → `2026-06-20`). For deadline storage this off-by-one-day is a real correctness risk.
- **[nit]** `backend/utils/dbValidation.js:254-296` — `validateForeignKey` interpolates `safeTable`/`safeColumn` into the SQL, but both are re-resolved from the hardcoded `ALLOWED_FK_TARGETS` map (:277-278) before use, so injection is not possible. The double-resolution (:268 check then :280 check) is redundant but harmless defense-in-depth.

### backend/utils/circuitBreaker.js
- **[nit]** `backend/utils/circuitBreaker.js:43-72` — `exec` reads `snapshot()` once, then on `state==='open' && canAttempt` flips to `half_open` (:54). The success path calls `close()`; the failure path increments `failures` and re-opens if `failures>=threshold || state==='half_open'`. Correct. Minor: `snapshot.canAttempt` is computed from `nowMs()-openedAt`, but there's no max-half-open concurrency guard — two concurrent calls while open+cooled both proceed as half-open trials. Acceptable for an in-process best-effort breaker.

### backend/utils/piiScrubber.js
- **[nit]** `backend/utils/piiScrubber.js:23-32` — `scrubPII` applies SSN regex before LONG_DIGITS, good ordering. But phone is replaced AFTER SSN and email; a 9+ digit run that is actually a phone without separators could be caught by `LONG_DIGITS_RE` first (it runs last, so phone wins) — ordering is fine. `safeLogObject` (:34-40) round-trips through `JSON.parse(scrubPII(obj))`; if scrubbing inserts `[REDACTED_*]` into a JSON string value it stays valid, but if the original object stringifies with redaction breaking a number field into a string, `JSON.parse` still succeeds. Low risk.
- **[important]** `backend/utils/piiScrubber.js` — This module exists but `logger.js` does not use it (see logger finding). The scrubber is only as good as its call sites; grep shows it is not wired into the central logger, so most log output is unscrubbed.

### backend/utils/scopedOpportunity.js
- **[nit]** `backend/utils/scopedOpportunity.js:61-94` — Solid parameterized joins; opportunity is resolved *through* the application row, preventing caller-supplied-id bleed. The `LOOKUP_FAILED` path returns `application:null` even when the app row was found before the join threw, slightly lossy but acceptable. No security issue.

### backend/utils/environment.js
- **[nit]** `backend/utils/environment.js:10-16` — Fine. Note `VERCEL_ENV==='production'` would be true on the frontend host, but this is backend-only code; harmless.

### backend/utils/grantFingerprint.js
- **[nit]** `backend/utils/grantFingerprint.js:50-53` — Deterministic sha256 over normalized tuple; correct and stable. `chooseGrantUrl` only accepts http/https — good. No issues.

### backend/utils/inferLocationFromAddress.js
- **[nit]** `backend/utils/inferLocationFromAddress.js:14` — The state regex `([A-Za-z]{2})\s+(\d{5})` will happily extract a non-state two-letter token (e.g. "...drive XY 12345") as a state code without validating against `stateNormalization`. Callers should pass results through `normalizeState`. Heuristic by design.

### backend/utils/stateNormalization.js
- **[nit]** `backend/utils/stateNormalization.js:138-141` — `normalizeStateFromText` iterates `ABBR_TO_NAME` and returns the FIRST full-name match by object insertion order. Because both US and Canadian entries share the map, a text mentioning two regions returns whichever appears first in the map, not in the text. Minor ambiguity.
- **[nit]** `backend/utils/stateNormalization.js:143-144` — After name matching fails, `\b([A-Z]{2})\b` with `/i` flag matches any two letters, then `normalizeState` filters — fine, returns null for non-states.

### backend/utils/tierGating.js
- **[nit]** `backend/utils/tierGating.js:15-19` — `hasTierCapability` and `requireTierCapability` both short-circuit `true` for `req.ctx?.isAdmin`. Correct, but `hasTierCapability` takes `(db, req, ...)` while `requireTierCapability` takes `(req, res, ...)` and reads `req.db` — inconsistent signatures invite call-site mistakes. No bug.

### backend/utils/openai.js
- **[nit]** `backend/utils/openai.js:31-42` — `messageContentToString` recurses on `content.content`/`content.data` with no depth/cycle guard; a self-referential object would infinite-loop. Provider payloads are not cyclic in practice. Low risk.

### backend/utils/openaiClient.js
- **[nit]** `backend/utils/openaiClient.js:20-25` — `normalizeOpenAIKey` splits on `=` and takes everything after the first `=`, then regex-extracts `sk-[A-Za-z0-9_-]+`. If the raw value legitimately has no `sk-` token it falls back to `afterEquals`, which could be garbage — but `createOpenAIClient` (:59) rejects keys lacking `sk-`/containing `*`. Good. Key never logged in full; diagnostics expose only a 7-char prefix (:39). Sound.

### backend/utils/aiProviders.js
- **[nit]** `backend/utils/aiProviders.js:11,18-19` — Mojibake in `console.warn` strings (`â` from a corrupted em-dash). Cosmetic.
- **[nit]** `backend/utils/aiProviders.js:120` — On the Anthropic success path it returns `openaiError` in the payload but hardcodes `anthropicError:null`, while the OpenAI path returns both as null. Minor inconsistency in surfaced diagnostics, not a bug.
- **[nit]** `backend/utils/aiProviders.js:166,195` — JSON parse path: `isLikelyJson ? safeParseJSON : tryParseJsonLoose` then `typeof parsed !== 'object'` throws. A JSON array passes (`typeof [] === 'object'`), accepted as valid JSON — intended.

### backend/utils/ensureUserPreferencesTable.js
- **[important]** `backend/utils/ensureUserPreferencesTable.js:164` — The legacy-row migration insert binds `@preferences_json` (`COALESCE(@preferences_json,'{}')`) but the `legacyRows` come from `SELECT *` of the OLD table, which has no `preferences_json` column. better-sqlite3 throws "Missing named parameter" when a bound `@name` is absent from the supplied object — so the rebuild path will throw for any DB that actually has legacy rows to migrate, defeating the self-heal. Verify the old schema actually has a `preferences_json` column or pass it explicitly.
- **[nit]** `backend/utils/ensureUserPreferencesTable.js:168-170` — `rows.forEach((row) => insert.run(row))` passes the entire legacy row object as named params; extra/missing columns vs. the `@id/@created_at/@updated_at/@user_id/@preferences_json` placeholders will cause better-sqlite3 to error on unexpected keys too. Fragile.

### backend/utils/ensureOutreachLogsTable.js
- **[nit]** `backend/utils/ensureOutreachLogsTable.js:33-45` — The PG `DO $$ ... IF NOT EXISTS (... proname='set_updated_at') ... CREATE OR REPLACE` block is internally contradictory (it only creates when missing, but uses CREATE OR REPLACE). Harmless. No injection (static DDL).

### backend/utils/ensurePortalCheckResultsTable.js
- **[nit]** `backend/utils/ensurePortalCheckResultsTable.js:1-41` — Static DDL, idempotent, no FK on `profile_id` (TEXT NOT NULL with no REFERENCES) unlike sibling tables — orphan profile_ids possible, but intentional given self-heal context. No issue.

### backend/utils/ensureDesignatedProfiles.js
- **[nit]** `backend/utils/ensureDesignatedProfiles.js:18-33` — `loadSectionsFromDataFile` resolves `dataFile` relative to `process.cwd()` and reads it. `dataFile` comes from the hardcoded `DESIGNATED_PROFILES` config, not user input, so no traversal risk. JSON parse guarded.
- **[nit]** `backend/utils/ensureDesignatedProfiles.js:163-166` — The SQLite branch calls `db.withTransaction((tx)=>{ _seedProfilesSync(tx) })` synchronously but `ensureDesignatedProfiles` is `async`; the sync transaction is not awaited (it's synchronous so fine), but the asymmetry with the awaited PG branch (:159) is easy to misread. All prepared statements are parameterized.

### backend/utils/ensureProfileOrgLinks.js
- **[nit]** `backend/utils/ensureProfileOrgLinks.js:58,121-124` — `nowSql` is `'now()'` or `'CURRENT_TIMESTAMP'` interpolated into INSERT/UPDATE templates. It is a dialect-controlled literal (never user input), annotated with `audit:allow dynamic-sql`. Safe.
- **[nit]** `backend/utils/ensureProfileOrgLinks.js:117-118` — `stmtEmailMatch`/`stmtNameMatch`/`stmtInsertOrg`/`stmtUpdateProfile` are prepared on the top-level `db` but then used inside `_linkProfilesSync(tx)` (SQLite branch, :126-174). For better-sqlite3 statements prepared on the base connection still execute within the active transaction, so this works; but it is inconsistent with the async branch (:188-189) which correctly re-prepares on `tx`. Works for SQLite only by virtue of the single-connection model.
- **[nit]** `backend/utils/ensureProfileOrgLinks.js:230-234` — Wraps `_linkProfilesSync` in `await db.withTransaction(...)` even though it is synchronous; fine.

### backend/utils/ensureFundingOpportunitySchema.js
- **[nit]** `backend/utils/ensureFundingOpportunitySchema.js:92-109` — Column names are hardcoded in `REQUIRED_COLUMNS` and re-validated against `IDENT_RE` (:93) before interpolation into `ALTER TABLE ... ADD COLUMN ${col.name} ${type}${defClause}`. `type`/`defClause` are also static. Injection-safe, idempotent, well-guarded. Good.

### backend/utils/ensureAgentSubsystemTables.js
- **[nit]** `backend/utils/ensureAgentSubsystemTables.js:251-259` — Reads each migration `.sql` file from disk and `db.exec(sql)` wholesale. Files are repo-controlled (not user input), so no injection; `tableExists` validates witness names via `TABLE_NAME_RE` (:120). The `out.repaired` field is lazily created (:242) but not initialized in the returned shape's docs — minor.
- **[nit]** `backend/utils/ensureAgentSubsystemTables.js:177-185` — `recordMigrationApplied` swallows unique/duplicate errors but rethrows others; if a non-unique error occurs it propagates out of the loop iteration's `try` (:258-262) and is caught by the outer catch as a failed apply. Acceptable.

### backend/utils/seedRealOpportunities.js
- **[nit]** `backend/utils/seedRealOpportunities.js:74` — `loadJSON(resolvedRealOppsPath,{required:true})` is called, but `loadJSON` only changes a log message for `required`; it still returns `null` on parse failure and the code falls back to `|| {}`. A corrupted required seed file is silently treated as empty. Acceptable for a seeder.
- **[nit]** `backend/utils/seedRealOpportunities.js:38` — `JSON.parse(readFileSync(...))` is not wrapped per-call in the try at :37-46 — it is. Fine. Errors logged for non-ENOENT only.

### backend/utils/seedAssistanceDirectories.js
- **[nit]** `backend/utils/seedAssistanceDirectories.js:60-112` — Inconsistent indentation (the `upsertOne` body is partly flush-left) but logic is sound: URL is validated `^https?://` at :102 before insert. The early `skipped++` at :63 happens before the regex check, and a non-http URL passes the first guard (truthy) then is dropped silently at :102 *without* incrementing `skipped` — so the returned `skipped` count undercounts URL-rejected records. Minor metric bug.

### backend/utils/seedFaithBasedHousing.js
- **[nit]** `backend/utils/seedFaithBasedHousing.js:151-182` — `registerGeoIndexEntries` re-imports crypto inside the loop (`const crypto = await import('crypto')` at :169) on every iteration — wasteful but cached by the loader. Parameterized inserts; guarded try/catch. Fine.

### backend/utils/seedHousingFunding.js
- **[nit]** `backend/utils/seedHousingFunding.js:69-71` — `eligibility_signals` is conditionally `JSON.stringify`'d only when `typeof === 'object'`; a value that is already a JSON string passes through, but `null` is typeof 'object' and would stringify to `"null"`. `null` → `JSON.stringify(null)` = `'null'` string stored instead of SQL NULL. Minor data-quality issue.

### backend/utils/seedOnStartup.js
- **[important]** `backend/utils/seedOnStartup.js:81-89` — `seedFundingOpportunities` uses a raw `INSERT OR REPLACE` (SQLite-only syntax). This entire module assumes a synchronous better-sqlite3 handle (`db.prepare(...).run(...)` with no await, `INSERT OR REPLACE`, `PRAGMA`). On a Postgres dialect handle these calls would break. It is gated by `isSeedingBlocked()` (production-blocked) so it only runs in dev/test where SQLite is used — acceptable, but the module is silently dialect-specific.
- **[nit]** `backend/utils/seedOnStartup.js:118-120, 313-315, 484-487** — Multiple bare `catch { /* Ignore errors */ }` and `catch { /* Ignore duplicates */ }` swallow ALL insert errors, not just duplicate-key. A schema/constraint regression would be invisible during seeding. Dev-only, low impact.
- **[nit]** `backend/utils/seedOnStartup.js:151-155` — Hardcoded skip of profiles named "rachel"/"joshua"/"josh" via substring match on display_name. Fragile business logic embedded in a util; a legitimate profile named "Joshua Smith" is excluded from seeding. Flagging as a surprising side effect.

### backend/utils/seedBaselineFromRepo.js
- **[nit]** `backend/utils/seedBaselineFromRepo.js:93` — `JSON.parse(fs.readFileSync(seedPath,'utf8'))` in `loadBaselineSeedFromRepo` is NOT wrapped in try/catch; a malformed seed file throws an unguarded SyntaxError up through `seedBaselineFromRepo`. The `existsSync` check (:88) only guards missing-file, not parse failure.
- **[nit]** `backend/utils/seedBaselineFromRepo.js:505-519` — `selectExistingIds` validates `table` against a hardcoded allow-set (:508-515) before interpolating into `SELECT id FROM ${table} WHERE id IN (...)`. Injection-safe. IDs are parameterized. Good.
- **[nit]** `backend/utils/seedBaselineFromRepo.js:757-766` — The retry-on-`documents_status_check` simply re-runs the identical `upsertDoc.run(payload)` with no change to `processing_status`, so it will fail the same check again and rethrow on the second attempt. The retry is a no-op; if the intent was to coerce the status, that coercion is missing.

### backend/utils/ensureMinimumNationalOpportunities.js
- **[important]** `backend/utils/ensureMinimumNationalOpportunities.js:24-39, 76` — Like seedOnStartup, this module calls `db.prepare(...).get()`/`.run()` synchronously (no await) and uses `PRAGMA table_info` and SQLite `ALTER TABLE ... ADD COLUMN`. But `countRealNational` (:53-77) and the schema/backfill run UNCONDITIONALLY at the top of the exported async fn, and it is NOT gated by `isSeedingBlocked()`. On a Postgres deployment, `db.prepare(sql).get()` without await may return a Promise (truthy) → `Number(row?.count)` = `NaN` → comparisons misbehave; and `PRAGMA table_info` is invalid on PG (caught, returns false → may issue an unnecessary `ALTER TABLE ... ADD COLUMN` that on PG lacks `IF NOT EXISTS` and could throw). If this runs against PG it is unsound. Confirm call sites only invoke it for SQLite.
- **[nit]** `backend/utils/ensureMinimumNationalOpportunities.js:61-66` — Country/origin clauses interpolate `trustedOriginClause()`/`trustedSourceClause()` (static, safe) and `activeVal` (dialect literal `'TRUE'`/`'1'`, safe). No injection.

### backend/utils/adminProfileLinks.js
- **[nit]** `backend/utils/adminProfileLinks.js:9-53` — `ensureAdminUser` INSERTs with `is_admin TRUE` and binds ISO-string timestamps; on SQLite `is_admin` boolean TRUE may store oddly but `Boolean(is_admin===true||===1)` reads handle it. Parameterized. `ADMIN_EMAIL` from config, not user input. Fine.
- **[nit]** `backend/utils/adminProfileLinks.js:101` — Copy-paste log label: `linkAllProfilesToAdmin`'s catch logs "in linkProfileToAdmin". Cosmetic.

### backend/utils/profileOwnershipRepair.js
- **[nit]** `backend/utils/profileOwnershipRepair.js:114-124` — `maybeAssignOwner` enforces one-profile-per-user, but the check (`SELECT id FROM profiles WHERE user_id=? LIMIT 1`) then `UPDATE` (:135-137) is not atomic; two concurrent repair runs could both pass the check and assign the same user to two profiles, violating the intended uniqueness. Startup-only/admin-only, low concurrency, but TOCTOU exists.
- **[nit]** `backend/utils/profileOwnershipRepair.js:16-22` — `parseJson` swallows parse errors to a fallback — fine. Email validation regex is permissive but adequate.

### backend/utils/profileResolver.js
- **[nit]** `backend/utils/profileResolver.js:38-69` — All lookups parameterized and case-insensitive; errors swallowed to `null` (resolution is best-effort by design). The reseed path (:121-151) can mutate the DB; callers opt out via `allowReseed:false`. Sound.

### backend/utils/repairOrphanedJobProfiles.js
- **[nit]** `backend/utils/repairOrphanedJobProfiles.js:148-149` — `newIdempotencyKey` uses `row.id.replace(/-/g,'').slice(0,16)` + `Date.now()` base36. Two rows repaired in the same millisecond with id prefixes colliding in the first 16 hex chars could theoretically collide, but UUID prefixes make this effectively impossible. Fine.
- **[nit]** `backend/utils/repairOrphanedJobProfiles.js:38` — `PROFILE_NOT_FOUND_PATTERN = /profile\s.+?\snot found/i` with `.+?` could match unrelated errors like "profile data integrity check not found in cache". Narrow but acceptable given it's paired with `status='failed'`.

### backend/utils/schoolBridgeErrors.js
- **[nit]** `backend/utils/schoolBridgeErrors.js:22-33` — Correct, narrowly-scoped table-missing matcher. The "fallback" comment (:29-32) describes a behavior that the code does NOT implement (it just `return false`), so the comment is misleading dead documentation.

### backend/utils/guardedProfileSectionWrite.js
- **[nit]** `backend/utils/guardedProfileSectionWrite.js:46-47` — `const loaded = context.profile && context.sections ? context : await loadProfileSectionGuardContext(...)`. If a caller passes a context with `profile` but no `sections` (or vice versa), it silently reloads from DB, discarding the partial context. Minor.
- **[nit]** `backend/utils/guardedProfileSectionWrite.js:8-12` — `evidenceHash` truncates sha256 to 16 hex chars (64 bits) for log correlation — fine for non-security correlation use.

### backend/utils/profileSuggestionGuards.js
- **[nit]** `backend/utils/profileSuggestionGuards.js:1` — Pure re-export of `../../shared/profileSuggestionGuards.js`. The actual guard logic lives outside `backend/utils` and is out of audit scope; flag that the security-relevant field-acceptance logic should be audited there.

### backend/utils/profileSectionSync.js
- **[nit]** `backend/utils/profileSectionSync.js:96` — `UPDATE profiles SET ${rule.profileColumn} = ?` interpolates `rule.profileColumn`, but every value comes from the hardcoded `SYNC_RULES` array (:18-70), never user input — injection-safe.
- **[important]** `backend/utils/profileSectionSync.js:97-102` — The catch only stays silent for "no such column"/"does not exist"; any OTHER error is logged but still swallowed (no rethrow), so a failed sync (e.g. constraint violation, locked DB) is non-fatal and invisible to the caller. Given this drives matching/listing correctness (state, serves_veterans, etc.), a silent sync failure means stale denormalized columns and wrong match results with no signal. Consider surfacing non-column errors.
- **[nit]** `backend/utils/profileSectionSync.js:54-69` — Two rules both target `serves_veterans` (demographics.is_veteran and military_service.veteran_status). Depending on call order, one section's update can overwrite the other (e.g. military "none" → 0 clobbers demographics is_veteran → 1). Last-writer-wins across sections may produce incorrect veteran flags.
