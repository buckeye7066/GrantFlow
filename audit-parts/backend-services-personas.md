# Backend Services Personas — Read-Only Code Audit

Scope: all `.js`/`.mjs` files under `backend/services/` in the subdirectories
`college/`, `hamilton/`, `john/`, `larry/`, `robert/`, `sam/`, `yana/`,
`studentBridgeFunding/`. Findings are tagged `[critical|important|nit]` with a
real `file:line`. Conventions checked: parameterized `?` SQL, profile/tenant
scoping (`WHERE profile_id = ?`), dual Postgres/SQLite dialect handling.

---

## college/

### backend/services/college/collegeFundingMerge.js
- No issues found. (Pure module; FAFSA/federal compliance gate forcing `USER_CONFIRM` is sound.)

### backend/services/college/committedCollege.js
- **[nit]** `backend/services/college/committedCollege.js:107` — `uncommitArchived` restores status with `const restored = a.previous_status || 'planning'`; could resurrect a terminal/declined state to `planning`. Low impact since `commitToCollege` only archives non-terminal apps.
- **[nit]** `backend/services/college/committedCollege.js:169` — `aidReceived` sums `numOrNull(a?.amount)` with no guard against negative amounts; a malformed negative `amount` would distort `unmet_need`.

### backend/services/college/fafsaStatus.js
- No issues found.

---

## studentBridgeFunding/

### backend/services/studentBridgeFunding/calendar.js
- **[nit]** `backend/services/studentBridgeFunding/calendar.js:230` — `bridgeGapDays` measured to `refundEnd` (Sep 15) overstates the documented move-in→refund gap; internally consistent but diverges from stated intent.
- **[nit]** `backend/services/studentBridgeFunding/calendar.js:243` — `academicCycle` uses `(enrollmentYear + 1) % 100`; year 2099→2100 produces a misleading `2099-00`. Far-future cosmetic.

### backend/services/studentBridgeFunding/expander.js
- No issues found.

### backend/services/studentBridgeFunding/pipelineWriter.js
- **[important]** `backend/services/studentBridgeFunding/pipelineWriter.js:105-112` / `:196-227` — Dedup `SELECT id, status FROM grants WHERE profile_id = ? AND application_url = ? LIMIT 1` and the later `INSERT INTO grants` are non-atomic and not in a transaction. Concurrent crawler runs both pass the dedup and both INSERT, defeating the stated `(profile_id, application_url)` idempotency. Relies on a DB unique index this module does not establish.
- **[important]** `backend/services/studentBridgeFunding/pipelineWriter.js:36-77` — `ensureOrganizationForProfile` is racy and swallows the self-heal insert error (`} catch (err) { log.warn('Self-heal org insert failed (continuing with new org)', ...) }`), then creates a brand-new org and reassigns `UPDATE profiles SET organization_id`, orphaning the correct org under concurrent inserts.
- **[nit]** `backend/services/studentBridgeFunding/pipelineWriter.js:51-56` / `:68` — Self-heal `INSERT INTO organizations` uses `CURRENT_TIMESTAMP` literal instead of the `db?.dialect === 'postgres'` `now()` branching convention. Works in both dialects but diverges.
- **[nit]** `backend/services/studentBridgeFunding/pipelineWriter.js:193` — `ensureOrganizationForProfile` issues an `UPDATE profiles` side effect during what reads like a read path; callers may not expect a profile mutation.

### backend/services/studentBridgeFunding/schoolResolver.js
- **[nit]** `backend/services/studentBridgeFunding/schoolResolver.js:107` — `buildApplicationsList` drops apps with no `name` (`if (!name) continue`); a committed school stored with an id/status but blank name is excluded from resolution.
- **[nit]** `backend/services/studentBridgeFunding/schoolResolver.js:146` — `scored.sort((a, b) => b.score - a.score)` relies on V8 stable sort for the documented "first known school wins" tie-break; no explicit tie-break comment.

### backend/services/studentBridgeFunding/templates.js
- **[nit]** `backend/services/studentBridgeFunding/templates.js:401-403` / `:426-428` — A partial `school.portals` object (truthy but missing the specific key) bypasses `SCHOOL_FALLBACK_PORTALS` and falls through to the `school.website` branch; minor URL-derivation gap.

---

## john/
Note: John tables are intentionally **not** profile-scoped (single global outreach agent with a global suppression list; confirmed no `profile_id` column in `083_john_tables.sql`). All SQL is parameterized; `updateDraft` builds columns from a fixed allowlist.

### backend/services/john/johnAgent.js
- **[important]** `backend/services/john/johnAgent.js:219-223` — In `dryRun` mode, no-op leads are pushed into `summary.errors` (`{ lead_id, dry_run: true }`) while the run returns `ok: true`, conflating dry-run skips with real failures. `summary.drafts_created += 0` is dead arithmetic.
- **[nit]** `backend/services/john/johnAgent.js:107-110` — Run row is created (`startRun`) before `draftOnly` validation, so a validation throw leaves an orphaned RUNNING row until the catch finalizes it.
- **[nit]** `backend/services/john/johnAgent.js:178` — `getLatestAliasCheck(db).catch(() => null)` swallows read errors; a failed alias check is indistinguishable from "never ran."

### backend/services/john/johnAliasVerifier.js
- **[nit]** `backend/services/john/johnAliasVerifier.js:97-106` — A test draft is created in the live primary mailbox on every `verify-alias` run with no dedup; repeated admin clicks accumulate test drafts. (Secrets are masked via `maskSecrets` before persistence.)

### backend/services/john/johnDraftService.js
- **[important]** `backend/services/john/johnDraftService.js:106-112` — When `forcePolicyOverride=true`, rate-limit reasons (`DAILY_LIMIT_REACHED`/`HOURLY_LIMIT_REACHED`) are bypassed along with safety reasons; an override intended for content/policy can push past hard rate caps.
- **[important]** `backend/services/john/johnDraftService.js:76-80` / `:176` — Double-draft guard (`hasDraftForLead`) is read-time only with no DB uniqueness on `yana_lead_id`; concurrent manual + scheduled (or two manual) runs can both pass and create duplicate drafts. Header claims "never silently overwrites" but the guarantee is not transactional.
- **[nit]** `backend/services/john/johnDraftService.js:347-358` — `reviseDraftBody` re-runs safety with a hardcoded `recipient_email: 'placeholder@example.org'`, so suppression/recipient checks are not re-validated on revision.

### backend/services/john/johnEmailComposerAI.js
- **[important]** `backend/services/john/johnEmailComposerAI.js:109-150` / `:174` — Untrusted lead content (`facts.mission`, `facts.website_excerpt`, `focus_areas`, org name) is interpolated into the LLM prompt via `JSON.stringify(ctx)` with no sanitization — prompt-injection vector. Downstream `classifySubject`/`classifyBody` mitigate but won't catch all misleading injected copy; `website_excerpt` is length-capped (1500), not content-filtered.
- **[nit]** `backend/services/john/johnEmailComposerAI.js:39-45` — `aiModel(config)` ignores its `config` param and defaults to `'claude-sonnet-4-6'`, not a valid Anthropic model id; if env is unset the API call fails and silently falls back to template, masking a misconfiguration.
- **[nit]** `backend/services/john/johnEmailComposerAI.js:52-64` — `cachedClient` is module-level keyed on the first non-empty `ANTHROPIC_API_KEY`; a runtime key change leaves a stale client.

### backend/services/john/johnEmailTemplates.js
- No issues found.

### backend/services/john/johnEmailWriter.js
- **[nit]** `backend/services/john/johnEmailWriter.js:66-73` — On AI composer `{ ok: false }`, the writer silently falls back to template with no signal on the draft about which path produced it beyond `personalization.template`.

### backend/services/john/johnLeadInterpreter.js
- No issues found. (`selectContactPoint` validates email type before `.trim()`.)

### backend/services/john/johnOutlookProvider.js
- **[nit]** `backend/services/john/johnOutlookProvider.js:74-77` — Token response `await res.json()` is unguarded and `cachedToken` is set from `json.access_token` without verifying it exists; a malformed 200 caches `undefined` and may be served while `Date.now() < expiresAt`.
- **[nit]** `backend/services/john/johnOutlookProvider.js:179-202` — A non-alias draft that gets a transient 5xx is thrown immediately with no retry (the alias-rejected fallback only triggers when `requestedFromAlias`). Resilience gap.

### backend/services/john/johnOutreachSafety.js
- **[important]** `backend/services/john/johnOutreachSafety.js:229-241` / `:264` — `bodyHasOptOut` treats the bare word `'reply'` as satisfying the CAN-SPAM opt-out requirement; any body containing "reply" passes `MISSING_OPT_OUT`, so a non-compliant body can ship.
- **[nit]** `backend/services/john/johnOutreachSafety.js:140-161` — `maskSecrets` masks by key-pattern and JWT-like (`eyJ...`) strings; an opaque (non-JWT) token in a free-text Graph error body would not be masked.
- **[nit]** `backend/services/john/johnOutreachSafety.js:267-272` — Physical-address compliance is a substring `text.includes(addr)` check; whitespace/format normalization differences can spuriously block legitimate drafts (fails safe).

### backend/services/john/johnRateLimiter.js
- **[important]** `backend/services/john/johnRateLimiter.js:23-27` / `:75` — Rate counts (`countDraftsCreatedSince`) and the per-attempt re-check are non-transactional; concurrent manual + scheduled runs each read counts independently before inserting and can collectively exceed `maxDraftsPer24h`. `archived` drafts still consume daily quota.

### backend/services/john/johnRunStore.js
- **[important]** `backend/services/john/johnRunStore.js:251-260` — `countDraftsCreatedSince` compares an ISO-8601 string (`...T...Z`) against `created_at` whose SQLite column DEFAULT is `CURRENT_TIMESTAMP` (`YYYY-MM-DD HH:MM:SS`, space-separated). App inserts pass `nowIso()` so current rows compare correctly, but the format mismatch between schema default and app writes is fragile and would break `>=` string comparison for any default-valued row.
- **[nit]** `backend/services/john/johnRunStore.js:27-35` — `jsonIn` swallows `JSON.parse` errors and returns the raw string; corrupted columns yield a string where callers expect an object.
- **[nit]** `backend/services/john/johnRunStore.js:69-95` — `finishRun` `status = COALESCE(?, status)` with `patch.status || null`: an empty-string status silently keeps the old status. No live bug (callers pass real statuses).

### backend/services/john/johnScheduler.js
- **[important]** `backend/services/john/johnScheduler.js:80-91` / `:23` — The `running` overlap guard is a module-level boolean that protects scheduler-vs-scheduler only; manual `runJohn` API calls don't touch it, so manual + scheduled can run concurrently — the concrete path to the duplicate-draft / cap-overrun races above.
- **[important]** `backend/services/john/johnScheduler.js:130-134` — `tick(...).catch(() => {})` silently swallows all tick errors (including throws before `runJohn`'s try, e.g. `getJohnConfig`/`parseCron`), making scheduler malfunctions invisible.
- **[nit]** `backend/services/john/johnScheduler.js:88-91` — `minuteKey`/`cronMatches` use local server time with no TZ documentation; a server TZ change shifts the send window silently.

### backend/services/john/johnSuppressionService.js
- **[important]** `backend/services/john/johnSuppressionService.js:83-96` — `makeSuppressionChecker` pre-loads at most 1000 rows (`listSuppression({ limit: 1000 })`, ordered `created_at DESC`); suppressed recipients beyond the newest 1000 are silently not loaded into the `Set`, so `isSuppressed` returns false and John can draft to a suppressed address. This in-memory checker is the one used by the draft pipeline. Compliance gap.
- **[nit]** `backend/services/john/johnSuppressionService.js:45-55` — Duplicate detection matches `/UNIQUE|duplicate/i` against driver error text rather than the Postgres `code === '23505'`; brittle across driver versions.

### backend/services/john/johnTypes.js
- **[nit]** `backend/services/john/johnTypes.js:176` — `makeSafetyReport` sets `checked_at: new Date().toISOString()`, making this "no I/O" factory non-deterministic. Cosmetic.

### backend/services/john/johnYanaBridge.js
- **[important]** `backend/services/john/johnYanaBridge.js:139-143` — The candidate-stage suppression filter only checks `type: 'organization'`; a suppressed *email/domain* lead passes the filter, consumes a draft slot, and is only blocked later at the safety gate (producing a blocked draft row). Inconsistent with the header's "lead is not in the suppression list."
- **[nit]** `backend/services/john/johnYanaBridge.js:115-119` — The bridge trusts the source for the 24h daily-cap (documented) and does not re-enforce it; a non-Yana registered source could ignore the contract.
- **[nit]** `backend/services/john/johnYanaBridge.js:141` — `await hasDraftForLead(...)` inside the filter loop is an N+1 (up to ~200 serial queries per run).

---

## larry/
Note: `larry_*` tables have **no `profile_id`/org scoping anywhere** — verify whether this pipeline is intentionally single-tenant (see critical below).

### backend/services/larry/larryAgent.js
- **[critical]** `backend/services/larry/larryAgent.js:178` / `:194` — `phaseSend` approval relies on `attempts.find((a) => a.send_status === 'approved' || a.approved_at)`; when `cfg.requireApprovalToSend` is false, `evaluateSendGates` does not require `attempt.approved_by_user_id`. The send gate holds only because nothing currently sets `send_status='approved'` except the admin route — fragile for a safety-critical send path. Should explicitly require `attempt.approved_by_user_id` here.
- **[important]** `backend/services/larry/larryAgent.js:187-190` — `phaseSend` finds attempts only via `options?.attemptLookup`; the scheduler omits it (`deps.scheduledOptions || {}`), so every lead is blocked `no_drafts` — the FULL_CYCLE send phase is silently inert in the scheduled path.
- **[nit]** `backend/services/larry/larryAgent.js:127` — `phaseScoreAndPacket` calls `upsertLead` per prospect with no per-iteration try/catch; one DB error aborts the whole phase (discovery wraps persistence, scoring doesn't).
- **[nit]** `backend/services/larry/larryAgent.js:241` — `createdBy` falls back to `req?.ctx?.email`, persisting an email into a `created_by_user_id` column (PII/schema smell).
- **[nit]** `backend/services/larry/larryAgent.js:321-322` — `collectCountersForRun` reads `summary.phases.discover.candidates` which is absent on the skip path (`{ skipped: true }`); guarded by `?.` so `prospects_considered` is silently never set.

### backend/services/larry/larryContactVerifier.js
- **[important]** `backend/services/larry/larryContactVerifier.js:48-51` / `:100-103` — `webChecker`/`mxChecker` race against a `timeout()` that rejects but does not abort the underlying fetch (no `AbortController`). Combined with `prospect.website_url` being attacker-influenced and the only guard being `isPlaceholderUrl` (blocks `example.com`/`localhost`/`127.0.0.1`/`0.0.0.0` only), a prospect URL to `http://169.254.169.254/` or an internal RFC1918 host is fetched. SSRF defense is delegated to the adapter; this file does not validate the host.
- **[nit]** `backend/services/larry/larryContactVerifier.js:106` — `satisfiedSignals` is clamped here (`Math.min(... , scoreableSignals)`) but other branches add freely so `ratio > 1` elsewhere; inconsistent.

### backend/services/larry/larryFitScorer.js
- No issues found.

### backend/services/larry/larryLeadPacketBuilder.js
- **[important]** `backend/services/larry/larryLeadPacketBuilder.js:181` — `isPacketQualified` reads `packet?.packet_json?.contact_verification?.status`; the function is fed both in-memory packets (which carry `packet_json` only if round-tripped) and DB lead rows, and a missing `packet_json` is silently treated as unverified → disqualified. Dual-shape fragility.
- **[nit]** `backend/services/larry/larryLeadPacketBuilder.js:37-46` — `pickPitch` interpolates untrusted scraped `organization_name`/orgType/cityState into `recommended_pitch`, which flows into the email subject/plain-text body unescaped (see drafter).

### backend/services/larry/larryOutreachDrafter.js
- **[important]** `backend/services/larry/larryOutreachDrafter.js:101` / `:114-115` — The email `draft_subject` (`` `GrantFlow may help ${orgName} ...` ``) and plain-text `draft_text` embed untrusted scraped `orgName`/contact/pitch **without escaping** (HTML body is escaped via `escapeHtml`, subject/text are not). A malicious org name could inject header-breaking or misleading subject content; passed raw to the sender.
- **[nit]** `backend/services/larry/larryOutreachDrafter.js:97-99` — The body is sliced to `MAX_BODY_CHARS` before `inspectDraftQuality` re-checks `> MAX_BODY_CHARS`, making that branch unreachable for drafter output.

### backend/services/larry/larryOutreachSender.js
- **[important]** `backend/services/larry/larryOutreachSender.js:43` — `if (cfg.requireApprovalToSend && !attempt.approved_by_user_id)`: when `requireApprovalToSend=false` the env flag fully disables human approval for real outbound email, leaving only suppression/DNC/cap gates. Large blast-radius switch.
- **[nit]** `backend/services/larry/larryOutreachSender.js:156` — `success = providerResult?.ok !== false && !providerResult?.error` treats `undefined`/`{}` as success; an empty provider result is recorded as SENT with a null message id.
- **[nit]** `backend/services/larry/larryOutreachSender.js:28` / `:215` — `upsertRelationship` is imported but only `void`-referenced; dead import.

### backend/services/larry/larryProspectDiscovery.js
- **[important]** `backend/services/larry/larryProspectDiscovery.js:121` — `raw_payload: raw` stores the entire untrusted, unbounded raw record into `raw_payload_json`; any future LLM summarization of `raw_payload` inherits prompt-injection / stored-content-into-admin-console risk.
- **[nit]** `backend/services/larry/larryProspectDiscovery.js:53-56` — `planProspectFetches` dead branch: `if (!includeNational) return plan` returns the same `plan` as the fallthrough; `includeNational` does nothing.
- **[nit]** `backend/services/larry/larryProspectDiscovery.js:201-203` — `trustOrdered` recomputes `computeProspectTrustScore` twice per comparison inside the sort comparator.

### backend/services/larry/larryProspectSources.js
- **[nit]** `backend/services/larry/larryProspectSources.js:101-111` / `:124-135` — Two sources have `url: null`, so `safeDomain(null)` returns null and the domain rate-limit block (larryProspectDiscovery.js:158) is bypassed entirely for them.

### backend/services/larry/larryRelationshipTracker.js
- **[important]** `backend/services/larry/larryRelationshipTracker.js:42-47` — `recordOpenedRelationship` unconditionally sets `relationship_state: OPENED`, regressing a `replied`/`declined`/`do_not_contact` label back to `opened` if an open-tracking pixel fires late (the `do_not_contact` boolean is preserved, but `relationship_state` becomes inconsistent).
- **[nit]** `backend/services/larry/larryRelationshipTracker.js:98` — `String(prospect.primary_contact_email).split('@')[1]` is added to suppression without lowercasing here; relies on `addSuppressionEntry` lowercasing downstream.

### backend/services/larry/larryRunStore.js
- **[critical]** `backend/services/larry/larryRunStore.js` (entire file) — **No tenant/profile scoping on any query** (`listProspects`, `listLeads`, `getProspect`, `findProspectByIdentifiers`, `findSuppressionsForProspect`, `countSendsInWindow`, etc.). All `larry_*` data (prospects, leads, suppression list, shared daily send cap) is global. `grep profile_id` over the directory returns nothing. Flagging critical for verification of intended tenancy.
- **[important]** `backend/services/larry/larryRunStore.js:863` / `:877` — `recordDomainRequest` (SQLite branch) compares `window_start` (JS ISO string `...T...Z`) against `datetime('now','-1 hour')` (`... ...`, space, no `T`/`Z`). Lexical string comparison between the two formats is incorrect (`T` > space), so the hourly per-domain rate-limit window can fail to reset. Real dual-dialect correctness bug.
- **[important]** `backend/services/larry/larryRunStore.js:194-275` — `upsertProspectCandidate` reads via `findProspectByIdentifiers` then conditionally INSERTs (read-then-write); concurrent discovery runs can both miss and both insert duplicate prospects (no enforced unique constraint in code).
- **[important]** `backend/services/larry/larryRunStore.js:846-849` — `checkDomainRateLimit` mixes Node clock (`Date.now()-3600000`) with SQLite server time (`datetime('now',...)`) governing the same window; drift/TZ mismatch mis-counts the limit.
- **[nit]** `backend/services/larry/larryRunStore.js:42` — `genId` falls back to `Math.random()` IDs when `crypto.randomUUID` is absent (non-cryptographic, collision-prone).
- **[nit]** `backend/services/larry/larryRunStore.js:60-79` — `parseJsonColumns` swallows `JSON.parse` errors silently, returning a raw string where callers expect objects.

### backend/services/larry/larrySafety.js
- **[important]** `backend/services/larry/larrySafety.js:153-164` — `isPlaceholderUrl` (the only URL guard before web verification) blocks only `example.*`, `localhost`, and `127.0.0.1|0.0.0.0`; it misses `10.x`, `172.16-31.x`, `192.168.x`, `169.254.169.254` (cloud metadata), IPv6 `[::1]`/ULA, and hostnames resolving to internal IPs. SSRF gap on untrusted prospect URLs. The regex is also unanchored (substring match anywhere in hostname).
- **[important]** `backend/services/larry/larrySafety.js:131-137` — `maskSecretString` regex `(sk|pk|rk|api)[_-]?[A-Za-z0-9]{16,}` misses JWTs (`eyJ...`), AWS `AKIA...`, and Resend `re_...` keys; provider keys with other prefixes can leak through `maskSecrets`.
- **[nit]** `backend/services/larry/larrySafety.js:96` — `failOpen` (`YANA_LEADS_FAIL_OPEN`) is read but has no consumer in the larry directory (likely dead config).
- **[nit]** `backend/services/larry/larrySafety.js:259-262` — `classifyPhone` marks any 11–15 digit string `valid` (e.g. `99999999999999`).

### backend/services/larry/larryScheduler.js
- **[important]** `backend/services/larry/larryScheduler.js:91-100` — `isCronMinuteMatch` uses local server time (`getMinutes/getHours/getDate/getDay`), so cron semantics differ by deployment TZ with no documentation.
- **[nit]** `backend/services/larry/larryScheduler.js:163-185` — `runOnce` is guarded by a module-global `STATE.running` lock only; multiple instances/dynos each have their own lock and run discovery concurrently (no distributed lock), compounding the upsert race.
- **[nit]** `backend/services/larry/larryScheduler.js:189` — `runOnce(...).catch(() => {})` swallows startup-run errors with no log.
- **[nit]** `backend/services/larry/larryScheduler.js:194-205` — `setTimeout(tick, 60_000)` re-arming can drift / miss an exact-minute window on clock jumps with no catch-up.

### backend/services/larry/larryTypes.js
- **[nit]** `backend/services/larry/larryTypes.js:243` / `:261-262` — `makeLeadPacket`/`makeOutreachAttempt` coerce missing ids to empty string (`String(... ?? '').trim()`) rather than null; an empty-string id could pass a truthiness check a null wouldn't.

### backend/services/larry/larryUrgencyScorer.js
- **[nit]** `backend/services/larry/larryUrgencyScorer.js:64-70` — `detail` can be a boolean `true` (when the signal is boolean) and is rendered to humans/emails downstream.

---

## robert/
Note: all SQL is parameterized; dynamic `IN (...)` clauses build `?` placeholders (not values). Profile scoping is correct where data is returned; the one scoping concern is a misnamed *count*.

### backend/services/robert/robertAgent.js
- **[nit]** `backend/services/robert/robertAgent.js:111-113` — Dead branch: `if (dryRun && [INGEST, FULL_CYCLE].includes(chosenMode))` has an empty body (comment only).
- **[nit]** `backend/services/robert/robertAgent.js:138-141` — `recommendations_delivered/accepted/declined` counters are declared and persisted but never incremented in this path; always report 0.
- **[nit]** `backend/services/robert/robertAgent.js:466` — `fetchOpportunitiesByIds` builds an `IN (...)` of parameterized `?` from trusted ingest ids but never dedupes/caps the list (unbounded `IN`).

### backend/services/robert/robertCoverageAnalyzer.js
- **[important]** `backend/services/robert/robertCoverageAnalyzer.js:161-173` — `defaultQueryProfileMatchableCount` ignores `profileId` (`_profileId`) and counts ALL active non-hidden `funding_opportunities` globally (`WHERE COALESCE(is_active,1)=1 AND COALESCE(is_hidden,0)=0`), so `zero_result_risk` is driven by the global catalog, not anything profile-specific. Misleading metric (count only, no data leak).
- **[nit]** `backend/services/robert/robertCoverageAnalyzer.js:124-126` — `safeCall` swallows every error (`catch { return undefined }`) with no logging; a broken counts query silently reports zero matches forever.
- **[nit]** `backend/services/robert/robertCoverageAnalyzer.js:53` — `reviewMatches`/`review_matches_count` is hardcoded to 0 and never populated; dead/always-zero.

### backend/services/robert/robertFundingTraceBridge.js
- **[important]** `backend/services/robert/robertFundingTraceBridge.js:58-65` — `traceFundingIntoCandidates` passes free-text `entity` straight to `traceFunding`/reverse-lookup (USASpending/ProPublica) and into log lines (`entity="${trace.entity}"`) — log injection if entity contains newlines; outbound-call safety depends on downstream services.
- **[nit]** `backend/services/robert/robertFundingTraceBridge.js:101` — Caught upsert error logs `source.name` only; per-source failures are not surfaced in the returned summary.
- **[nit]** `backend/services/robert/robertFundingTraceBridge.js:320-322` / `:341` — `upsert` dep may be silently forwarded as `undefined` to a custom `autoSeed`.

### backend/services/robert/robertIngestionBridge.js
- No issues found.

### backend/services/robert/robertMatchBridge.js
- **[nit]** `backend/services/robert/robertMatchBridge.js:53` — `const result = fn(...)` without `await`; correct only if `computeMatchDecision` is never async — an injected async impl would read `result?.score` off a Promise and yield defaults.

### backend/services/robert/robertOpportunityExtractor.js
- **[important]** `backend/services/robert/robertOpportunityExtractor.js:17` — `extractDomain` imported but never used (`import { extractDomain, makeOpportunityCandidate } from './robertTypes.js'`). Dead import.
- **[nit]** `backend/services/robert/robertOpportunityExtractor.js:30-83` — Candidate URLs are validated against placeholder/search-engine filters but NOT against non-`http(s)` or private/loopback hosts; raw IP literals (`http://169.254.169.254/`, `http://10.0.0.5/`) pass extraction and propagate to the downstream injected `checkUrl` fetch.
- **[nit]** `backend/services/robert/robertOpportunityExtractor.js:66-70` — `raw_payload: raw` persists the entire untrusted source record (into `raw_payload_json` / `normalized.raw_source_payload`); prompt-injection vector if any downstream LLM consumes it.

### backend/services/robert/robertOpportunityNormalizer.js
- **[nit]** `backend/services/robert/robertOpportunityNormalizer.js:20` — `isNational` defaults to `true` when there's no state and `applicant_types` is empty/non-array; a county-only candidate is mislabeled national.

### backend/services/robert/robertProfileDemandPlanner.js
- No issues found. (Null handling on `applicantType` is correct via `?.` and `Array.includes(null)`.)

### backend/services/robert/robertRecommendationDelivery.js
- **[important]** `backend/services/robert/robertRecommendationDelivery.js:103-114` — `listRecommendationsSince` runs `db.prepare(...).all(...)` with no try/catch and no `withRobertSchema` self-heal; on a cold deploy where `robert_profile_recommendations` is missing, this throws an unhandled rejection up to the polling/SSE route.
- **[nit]** `backend/services/robert/robertRecommendationDelivery.js:64` — `immediate.slice(0, Math.max(1, remaining))` always returns ≥1 HIGH toast even when `remaining===0` / `daily_cap_reached: true`; contract inconsistency.

### backend/services/robert/robertRecommendationService.js
- **[important]** `backend/services/robert/robertRecommendationService.js:72-78` — The decision-gating chain proceeds to create a recommendation for `NEEDS_PROFILE_DATA` (no branch matches), and although priority resolves to LOW, the user-facing `toast_title`/`toast_body` are still populated — contradicting the comment's "no delivery toast" intent.
- **[nit]** `backend/services/robert/robertRecommendationService.js:102-104` / `:119` — The "daily cap" is enforced loosely in two places with different semantics (creation downgrades priority to LOW; delivery trims), softer than the name implies.

### backend/services/robert/robertRunStore.js
- **[important]** `backend/services/robert/robertRunStore.js:81-124` — `completeRun` is NOT wrapped in `withRobertSchema` (unlike `startRun`); in a missing-relation scenario it throws and (since the agent calls it via `safe()`) the run can finish work but never persist its final status, silently staying `running`.
- **[nit]** `backend/services/robert/robertRunStore.js:488-498` — `listRecommendationsForProfile` builds `IN (${placeholders})` from `statuses`; an empty `statuses: []` yields `IN ()`, a syntax error in both dialects. Callers pass non-empty defaults today.
- **[nit]** `backend/services/robert/robertRunStore.js:298-322` — `updateOpportunityCandidate` silently drops patch keys not in its fixed allowlist (no injection; just silent drop).

### backend/services/robert/robertSafety.js
- **[important]** `backend/services/robert/robertSafety.js:158-164` — `isPlaceholderUrl` (the primary URL gate before the injected fetch) blocks only `localhost`/`.local`/`example.*`/`test.*` by string; it does NOT block `169.254.169.254`, `127.0.0.1`, RFC1918, IPv6 `[::1]`, or raw-IP hosts. Core SSRF gap — defense fully delegated to the injected `checkUrl`.
- **[important]** `backend/services/robert/robertSafety.js:211-228` — `checkRateLimit` treats a rolled (>1h) window as unlimited but does NOT reset `request_count` (only `recordDomainHit` resets). A caller that reads but never records can bypass the per-domain hourly cap for the whole next hour (read/record TOCTOU).
- **[nit]** `backend/services/robert/robertSafety.js:166-176` — `isSearchEngineUrl` allowlist is incomplete (`google.co`/`yahoo.com` only; misses `google.de`, `.co.uk`, `ecosia`, `startpage`, `yandex`); bypassable.
- **[nit]** `backend/services/robert/robertSafety.js:188` — Loan/matching-funds scan reads `opp.eligibility`, but `verifyOpportunity` normalizes to `eligibility_bullets`, so eligibility text is not actually scanned in the verification path.

### backend/services/robert/robertScheduler.js
- **[important]** `backend/services/robert/robertScheduler.js:41-51` — The auto-seed sweep self-starts independent of `ROBERT_ENABLED` (default `ROBERT_AUTOSEED_ON_SCHEDULE=true`); 5 min after boot it calls `autoSeedWeakestProfiles` → `findSimilarOrgsFunders`/`traceFunding` (outbound USASpending/ProPublica) against all active profiles. Enabled-by-default network egress + reads of all profiles even when `ROBERT_ENABLED=false`.
- **[nit]** `backend/services/robert/robertScheduler.js:126-141` — `parseSchedule` collapses every cron to a flat 24h interval anchored to boot time; `0 3 * * *` runs every 24h from process start, not at 3am.
- **[nit]** `backend/services/robert/robertScheduler.js:84-119` — Interval ticks self-guard with `_running`/`_autoSeedRunning` and try/catch (no unhandled rejection), but a tick firing during an in-flight run is silently dropped with no log.

### backend/services/robert/robertSearchPlanner.js
- No issues found.

### backend/services/robert/robertSourceDiscovery.js
- **[important]** `backend/services/robert/robertSourceDiscovery.js:84-86` — The per-plan `searchProvider` call is wrapped in `try/catch` that swallows ALL errors (`results = []`, `err` unused, no log); a persistently failing/rate-limited provider yields zero candidates indefinitely with no diagnostics.
- **[nit]** `backend/services/robert/robertSourceDiscovery.js:87-95` — External provider results are filtered by `isPlaceholderUrl`/`isSearchEngineUrl`/trust but NOT by private-IP/scheme before becoming persisted source candidates (inherits the `isPlaceholderUrl` SSRF gap).

### backend/services/robert/robertSourceRegistry.js
- **[nit]** `backend/services/robert/robertSourceRegistry.js:31` — `computeSourceTrustScore` matches keywords via `domain.includes('grants.'|'opportunities.')`, granting trust 75 to any hostname containing the substring (e.g. `grants.evil.com`, `fakegrants.io`), above `minSourceTrust` (60). Trust-score gaming vector.
- **[nit]** `backend/services/robert/robertSourceRegistry.js:29` — `KNOWN_FOUNDATION.domains` lists `'kresge.org'` twice (duplicate).

### backend/services/robert/robertTypes.js
- **[nit]** `backend/services/robert/robertTypes.js:341` — `makeRecommendation` falls back unknown `toast_priority` strings to `NORMAL` silently; the factory also appears unused by the live path (recommendations built inline elsewhere) — likely dead code.

### backend/services/robert/robertVerification.js
- **[important]** `backend/services/robert/robertVerification.js:144-153` — Live link verification fetches an attacker-influenced (scraped) `opportunity.application_url || apply_url || source_url` via the injected `checkUrl` with no re-validation against private-IP/internal hosts beyond the upstream `isPlaceholderUrl` preflight (which misses IP literals/metadata). This is the actual outbound-fetch site; SSRF protection is entirely delegated to `checkUrl`.
- **[nit]** `backend/services/robert/robertVerification.js:128` — `reviewOpportunity`/`assessReality`/`validateOpportunity`/`enforceOpportunityPolicy` are called without `await`; if any became async, the security gates (`!policy.ok`, `validation.valid`) would read off a (truthy) Promise and always pass. Fragile assumption.

---

## sam/
Note: no SQL injection — dynamic SQL uses parameterized `?`/`$n`; interpolated identifiers are module-level constants. `samGit.js`/`samSafeFixes.js` correctly use `spawn(..., shell:false)` with whitelist exact-match and `--` separators (git); path traversal is blocked by `path.resolve` + `startsWith(REPO_ROOT)`.

### backend/services/sam/samAgent.js
- **[important]** `backend/services/sam/samAgent.js:108-118` — Repair-safe downgrades to advise via `runSam({ ...args, mode: ADVISE })` whenever `dryRun` is true (the default) — `if (mode === SAM_MODES.REPAIR_SAFE && (!authorisedByAdmin || dryRun))`. An authorised admin calling repair-safe with default `dryRun` silently never applies fixes, signalled only by `_downgradedFromRepair` buried in the summary (no top-level error).
- **[nit]** `backend/services/sam/samAgent.js:194-195` — `computeHealthScore(findings)` and `determineProductionReady(...)` each re-walk findings (the latter recomputes the score internally). Redundant.
- **[nit]** `backend/services/sam/samAgent.js:483-491` — `rollupChecks` never sets a 'pass' state for `readyz`/HTTP-derived fields, so a passing run still shows `readyz: 'unknown'`.

### backend/services/sam/samAuditStore.js
- **[important]** `backend/services/sam/samAuditStore.js:45-47` — The 4th secret pattern `/(["'])([A-Za-z0-9+/=]{40,})\1/g` over-masks any quoted 40+ char base64-ish string (hashes, fixtures, long paths) in persisted findings/stdout, corrupting audit evidence (safety-leaning false positive).
- **[nit]** `backend/services/sam/samAuditStore.js:50-57` — `maskSecrets` on objects does `JSON.parse(maskSecrets(JSON.stringify(input)))`; on a parse failure the `catch` returns the *unmasked* original (fails open rather than closed).
- **[nit]** `backend/services/sam/samAuditStore.js:149-168` — The `sam_findings` insert loop is wrapped in one try/catch swallowing ALL errors as "table missing on older DBs"; a constraint violation on row 3 silently aborts remaining inserts with no log.

### backend/services/sam/samDiagnostics.js
- **[important]** `backend/services/sam/samDiagnostics.js:137-146` — `samToolActor` forges `isAdmin: true, role: 'admin'` with `userId: 'system_admin_token'` when `ctx` is null. Safe only because `runSam` gates it; but `runDiagnostics`/`runToolCheck` are exported and, if invoked directly with an injected `invokeTool`, run every admin tool as a forged admin, bypassing the gate.
- **[important]** `backend/services/sam/samDiagnostics.js:167-178` — `isRuntimeUnavailableError` treats HTTP 401/403/404 and "not authori[sz]ed"/"forbidden"/"admin privileges" as benign environment limitations and downgrades them to INFO, so a genuine auth-guard regression — exactly what Sam exists to catch — is silently reclassified as a skip and excluded from severity counts.
- **[nit]** `backend/services/sam/samDiagnostics.js:204-206` — `dispatcher(...)` is called with a 5-arg signature; an arity mismatch in `anyaOrchestrator.invokeTool` silently drops the extra arg.

### backend/services/sam/samEscalation.js
- No issues found.

### backend/services/sam/samGit.js
- **[important]** `backend/services/sam/samGit.js:139` — `git checkout -b <branch>` runs with no prior verification that HEAD is the expected base (no `git fetch`/clean-tree/branch-exists check). If Sam runs while the repo is on an arbitrary branch, the fix branch is cut from there; a re-run with the same deterministic `runId` fails ("branch already exists").
- **[nit]** `backend/services/sam/samGit.js:92` — `defaultOpenPr` passes `title`/`body` to `gh pr create` via `spawn(..., shell:false)` as explicit `--title`/`--body` values; no shell/argument-injection risk. Noted for completeness.

### backend/services/sam/samSafeFixes.js
- **[important]** `backend/services/sam/samSafeFixes.js:294-309` — `runEslintCli` spawns `npx eslint --fix <file>` with `file` as a positional arg and no `--` terminator (`['eslint', '--fix', file]`); a leading-`-` path could be parsed as a flag (argument injection). Mitigated in practice by `isPathSafeForFix`'s allowed-root prefix check. Recommend `['eslint','--fix','--', file]`.
- **[important]** `backend/services/sam/samSafeFixes.js:166-185` — The npm-script-exists pre-check parsing (`args[args.indexOf('run')+1]?.replace(/^-s$/,'')` then `|| args[2]`) works only by luck for `npm run -s scan:secrets`; convoluted and brittle if a future whitelisted script omits `-s`. Not currently exploitable (command is whitelist-matched first).
- **[nit]** `backend/services/sam/samSafeFixes.js:248-263` — `isPathSafeForFix` correctly blocks absolute paths and `../` traversal via `path.resolve` + `startsWith(REPO_ROOT + path.sep)`. Solid (noting the guard is load-bearing).
- **[nit]** `backend/services/sam/samSafeFixes.js:271-272` — `regenerateReadinessLog`'s idempotency claim is stronger than the code: a ms-precision timestamp filename would overwrite if two calls land in the same ms with the same `check_id`.

### backend/services/sam/samPolicy.js
- **[nit]** `backend/services/sam/samPolicy.js:24-28` — The exported `readEnvBool` reads `process.env` directly and ignores any injected `env`, unlike `getSamPolicy`'s inner `read`; tests/callers can't override env via it.

### backend/services/sam/samRegistry.js
- **[nit]** `backend/services/sam/samRegistry.js:270-304` — The `agent.controlCenter.lockHygiene` INTERNAL check defines `async run({ db })`, but `samDiagnostics.runOneCheck` returns `{ ok:true, skipped:true }` for `CHECK_KIND.INTERNAL` and never invokes `check.run` — the lock-hygiene logic (including its `sweepExpiredLocks` self-heal) is dead code through Sam's path.
- **[nit]** `backend/services/sam/samRegistry.js:345-348` — `buildCommandWhitelist` produces `npm run -s <script>` which must stay byte-identical to the strings built in samAgent and exact-matched in `runWhitelistedCommand`, or all gates silently `skipped`. Fragile three-file coupling.

### backend/services/sam/samRepairPlanner.js
- No issues found.

### backend/services/sam/samScheduler.js
- **[important]** `backend/services/sam/samScheduler.js:82-110` — The `starting` guard is reset in `finally` before the fire-and-forget async run completes, so it only blocks synchronous re-entry; calling `startSamScheduler` twice overwrites `activeTimer` without clearing the first timer (`scheduleNext` leaks the prior `setTimeout`), double-arming the daily run.
- **[nit]** `backend/services/sam/samScheduler.js:75-80` — `msUntilNextDaily` uses `next.setHours(...)` (local time) while the env doc says "04:00 UTC"; fires at server local time, contradicting the contract.

### backend/services/sam/samTypes.js
- **[nit]** `backend/services/sam/samTypes.js:218-225` — `info` weight is 0, so unlimited INFO findings never lower the health score; combined with samDiagnostics downgrading real auth failures to INFO, a run with many INFO "skips" still reports `production_ready: true`, score 100. Internally consistent but compounds the masking concern.

### backend/services/sam/samOnboardingBranchTests.js
- No issues found.

### backend/services/sam/samOnboardingConversationAuditor.js
- **[important]** `backend/services/sam/samOnboardingConversationAuditor.js:188-241` — `persistRun` inserts the run row + N finding rows with no transaction; a finding-insert throw mid-loop leaves the run row committed/orphaned while `persisted=false`, an inconsistent partial state.
- **[nit]** `backend/services/sam/samOnboardingConversationAuditor.js:259` / `:275-278` — `ORDER BY severity` sorts the text column alphabetically, not by severity rank (info/low/medium interleave wrong).
- **[nit]** `backend/services/sam/samOnboardingConversationAuditor.js:48-64` — Postgres `tableExists` query omits a `table_schema` filter, so a same-named table in another schema is a false positive.
- **[nit]** `backend/services/sam/samOnboardingConversationAuditor.js:268-281` — `listFindings` binds `limit` as `?` (good) but never clamps it (unlike samAuditStore's `Math.min(100, ...)`).

### backend/services/sam/samOnboardingQuestionContract.js
- No issues found.

### backend/services/sam/samOnboardingReadinessAudit.js
- **[nit]** `backend/services/sam/samOnboardingReadinessAudit.js:82` — `compute(db, profileId)` runs under `withProfileScope({ bypass: true })` (cross-tenant by design for the admin auditor); ensure the route layer admin-gates `recentProfileIds` so non-admins can't enumerate other tenants' readiness.
- **[nit]** `backend/services/sam/samOnboardingReadinessAudit.js:151-157` — `auditRecentCompletions` awaits sequentially in a `for` loop over `profileIds` (slow but correct).

### backend/services/sam/samOnboardingTranscriptAuditor.js
- **[nit]** `backend/services/sam/samOnboardingTranscriptAuditor.js:73-81` — The events query has no SQL-level `LIMIT`; it pulls all events since the window and applies `limit` only in-memory, loading a large table slice on a high-traffic window. (Privacy redaction correctly excludes `details_json`.)
- **[nit]** `backend/services/sam/samOnboardingTranscriptAuditor.js:51` — Same missing `table_schema` filter in Postgres `tableExists`.

---

## yana/

### backend/services/yana/prospectExclusions.js
- No issues found.

### backend/services/yana/webSearchProvider.js
- **[important]** `backend/services/yana/webSearchProvider.js:107-120` — SSRF: `makeHtmlFetcher` fetches arbitrary (AI/search-influenced) URLs with `redirect: 'follow'` and only a scheme check (`if (!/^https?:\/\//i.test(url)) return ''`) — no host allowlist or private-IP/loopback/metadata block, and redirects are auto-followed past the initial check. The caller's `isExcludedUrl` is a domain denylist, not an SSRF guard (won't catch raw IPs/metadata).
- **[nit]** `backend/services/yana/webSearchProvider.js:38-47` — Throttle stamps `last` at dispatch, not completion, so a slow `fn()` doesn't extend spacing for the next call; the comment overstates the "runs after the previous settles" guarantee.
- **[nit]** `backend/services/yana/webSearchProvider.js:64` — `&count=${count}` interpolated unescaped into the URL (internal default 5; prefer `encodeURIComponent` if ever caller-supplied).

### backend/services/yana/yanaContactEnrichment.js
- **[important]** `backend/services/yana/yanaContactEnrichment.js:129-137` — Scraped homepage text (`htmlToText(html)`) becomes `excerpt` → `website_excerpt` → `public_evidence` and flows into John's AI outreach prompt with no sanitization/delimiting (length-capped 1200, not neutralized). Prompt-injection surface.
- **[nit]** `backend/services/yana/yanaContactEnrichment.js:30` — `JUNK_EMAIL_RE` matches `domain` and `godaddy` as bare substrings, wrongly discarding e.g. `team@mydomain.org` or `info@godaddyfoundation.org` (no word boundaries).
- **[nit]** `backend/services/yana/yanaContactEnrichment.js:31` — `EMAIL_RE` global regex reused across `matchAll` calls; combined with the substring junk filter, confirm intended behavior.

### backend/services/yana/yanaLeadDiscovery.js
- **[important]** `backend/services/yana/yanaLeadDiscovery.js:592-622` — `pushQualifiedToJohn` selects/updates with NO profile scoping (`WHERE qualification_status='qualified' AND COALESCE(pushed_to_john,0)=0`); in a multi-tenant DB this pushes every tenant's leads and enforces the rolling cap globally. Same global scope in `countLeadsPushedWithinWindow` (:554), `getYanaStatus` (:744), `listQualifiedLeadPackets` (:793-799). `profile_id` is stored but never filtered — potential cross-tenant leak.
- **[important]** `backend/services/yana/yanaLeadDiscovery.js:439` — `loadOwnOrgKeys` does `SELECT name, ein FROM organizations` across the whole table with no `profile_id`/`deleted_at` filter; the "don't prospect yourself" guard operates globally.
- **[nit]** `backend/services/yana/yanaLeadDiscovery.js:818` — `markQueuedForReview` returns `{ ok: true }` when `!leadId` (line 815) — a missing leadId silently reports success.
- **[nit]** `backend/services/yana/yanaLeadDiscovery.js:514` — `x.scored.source_urls.includes(...)` assumes `source_urls` is always an array (true today, but unguarded).

### backend/services/yana/yanaProspectSources.js
- No issues found.

### backend/services/yana/yanaScheduler.js
- **[important]** `backend/services/yana/yanaScheduler.js:43` / `:86-102` — Scheduler lock `_running`/`_stopped`/`_interval` are module-global singletons; `runYanaScheduledCycle` takes `db` per call but the lock is process-wide, and a second `startYanaScheduler` for another db `clearInterval`s the first's interval (line 97), silently killing the earlier schedule. Breaks under multi-db/multi-tenant.
- **[nit]** `backend/services/yana/yanaScheduler.js:98` — `setInterval` callback returns an un-awaited promise; safe today via internal try/catch but a synchronous throw before the try would be an unhandled rejection.

### backend/services/yana/yanaWebCrawler.js
- **[critical]** `backend/services/yana/yanaWebCrawler.js:297-319` / `:398-422` / `:431-439` — SSRF: `makeJsonFeedSource`/`makeCsvFeedSource` fetch `YANA_WEB_*_FEED_URL` directly, and crawled candidate websites are HEAD/GET-verified (`headCheck(site)`, `enrichOrgContact`) with no host validation against private/loopback/metadata ranges. Candidate `website` values come from fetched feed content (`org.website`, line 249), so a malicious/compromised feed can point Yana at `http://169.254.169.254/` or internal hosts. `normalizeWebsite` validates syntax only. Highest-risk SSRF path.
- **[important]** `backend/services/yana/yanaWebCrawler.js:148-177` — `insertOrganization` inserts crawled orgs with NO `profile_id`/tenant column; `organizationExists` (:140) dedupes across the whole `organizations` table ignoring `profile_id`. Crawled rows are tenant-less/global and then scored for every tenant.
- **[important]** `backend/services/yana/yanaWebCrawler.js:259-274` — `enrichOrgContact` persists scraped personal contact data (`contact_name`, `contact_title`, `email`, `phone`) into `organizations` from uncontrolled pages, despite the module's stated "ORGANIZATIONS ONLY / never harvest personal contact data" posture.
- **[nit]** `backend/services/yana/yanaWebCrawler.js:386` — `parseCsv` splits on `/\r?\n/` and the per-line quote-state machine won't handle embedded newlines inside quoted CSV fields; malformed multi-line rows.
- **[nit]** `backend/services/yana/yanaWebCrawler.js:305` — Candidate liveness HEADs (`headCheck(site)`) skip robots entirely (only `adapter.baseUrl` is robots-checked). Politeness gap.

---

## hamilton/
Note: Hamilton handles student funding portals, credentials, and payments — tenant isolation is critical. The dominant theme is **profile scoping enforced by convention (`WHERE id = ?` + a "callers must verify ownership" comment) rather than in-function guards**. Live TOTP/MFA automation is disabled by policy; saved post-2FA browser sessions are the supported path. E-signature and resolved-field stores are clean.

### backend/services/hamilton/applicationTaskStore.js
- **[important]** `backend/services/hamilton/applicationTaskStore.js:789-808` — `cancelApplicationTask` takes no `profileId`; UPDATE is `WHERE id = ?` only, so a forwarded attacker-controlled `taskId` can cancel another tenant's task.
- **[important]** `backend/services/hamilton/applicationTaskStore.js:502-575` — `updateApplicationTask` is keyed solely on `WHERE id = ?` with no profile scoping while writing whitelisted columns (`status`, `applicationId`, `portalUrl`, ...); cross-tenant writes possible if `taskId` isn't pre-verified.
- **[nit]** `backend/services/hamilton/applicationTaskStore.js:548-549` — Booleans written as `1`/`0` literals into Postgres `BOOLEAN` columns (`auto_submit_enabled`/`allow_auto_submit`); relies on the adapter coercing `1`/`0` for a BOOLEAN bind.
- **[nit]** `backend/services/hamilton/applicationTaskStore.js:226-229` — Postgres status CHECK constraint rebuilt via string interpolation of `TASK_STATUSES`; escaped and from a frozen constant (not exploitable), but the one place diverging from parameterized SQL.

### backend/services/hamilton/hamiltonAdminAccount.js
- **[nit]** `backend/services/hamilton/hamiltonAdminAccount.js:55-99` — `resolveAdminUserId` caches the first resolved id in a process-global `cachedAdminUserId` not keyed by `db`; in a multi-db process the first db's admin id is returned for others (sibling stores use a per-db WeakMap).
- **[nit]** `backend/services/hamilton/hamiltonAdminAccount.js:77-80` — `SELECT id FROM users WHERE role='admin' LIMIT 1` with no ordering; non-deterministic admin id under multiple admins.

### backend/services/hamilton/hamiltonApplicationPacketGenerator.js
- **[important]** `backend/services/hamilton/hamiltonApplicationPacketGenerator.js:476-535` — `insertDocumentRecord`/`generateAndSavePacket` write PII-laden `documents`/`profile_documents` scoped only by the passed `profileId` with no verification the caller owns it; an unverified profile persists a document under the wrong tenant.
- **[nit]** `backend/services/hamilton/hamiltonApplicationPacketGenerator.js:550-552` — Packets (DOCX/HTML/PDF with applicant PII) are written to a shared OS temp dir (`getPacketStorageDir()`) and never cleaned up; PII-at-rest concern.
- **[nit]** `backend/services/hamilton/hamiltonApplicationPacketGenerator.js:441-465` — `tryBuildPdfFromHtml` uses Playwright `setContent` on escaped profile HTML; `setContent` doesn't disable remote resource loading, but no `<img>/<link>` is emitted so not exploitable as written.

### backend/services/hamilton/hamiltonAttestationStore.js
- **[important]** `backend/services/hamilton/hamiltonAttestationStore.js:124-143` — `revokeAttestation` operates on `WHERE id = ?` with no ownership check, despite `getAttestationById`'s comment implying one happens before revoke. A route forwarding a user-supplied id can revoke any tenant's auto-tick authorization.

### backend/services/hamilton/hamiltonAuthBackupPlan.js
- No issues found.

### backend/services/hamilton/hamiltonAuthWatchService.js
- No issues found.

### backend/services/hamilton/hamiltonAuthorizationStore.js
- **[important]** `backend/services/hamilton/hamiltonAuthorizationStore.js:304-322` — `revokeAuthorization` is keyed on `WHERE id = ?` with no in-function ownership check; a forwarded user-supplied id can revoke any tenant's standing authorization.
- **[nit]** `backend/services/hamilton/hamiltonAuthorizationStore.js:200-208` — `ensuredAuthSchema` is a process-global boolean (line 32); concurrent test DBs can race (the sibling stores' WeakMap pattern would help).
- **[nit]** `backend/services/hamilton/hamiltonAuthorizationStore.js:366-369` — `getAutopilotRun`/`updateAutopilotRun` read/patch runs by id with no profile scoping (internal-only today, but the run ledger holds `confirmation_reference`/result data).

### backend/services/hamilton/hamiltonAutomationClassifier.js
- No issues found.

### backend/services/hamilton/hamiltonAutomationOrchestrator.js
- **[important]** `backend/services/hamilton/hamiltonAutomationOrchestrator.js:209-259` — `automateSingleSource` (top-level "Automate with Hamilton" entry) never verifies `userId` owns `resolvedProfileId`; `loadProfileBundle` (:100) is `WHERE id = ?` only, then it creates tasks, generates PII packets, and runs autopilot. The header's "rejects if the caller does not own it" guarantee is not enforced here — trusts the route.
- **[nit]** `backend/services/hamilton/hamiltonAutomationOrchestrator.js:692-700` — An unexpected throw from `runAutopilot`/`resolveBlocker` in the resolver loop isn't caught, leaving the autopilot_run row stuck at `running` and the task at `filling_portal` (no failed-state finalization).
- **[nit]** `backend/services/hamilton/hamiltonAutomationOrchestrator.js:266` — `classification.confidence.toFixed(2)` assumes a number (safe today; no guard if shape changes).

### backend/services/hamilton/hamiltonAutopilotEngine.js
- **[important]** `backend/services/hamilton/hamiltonAutopilotEngine.js:684-692` — Document-upload matching falls back to `documents[0]` (`}) || documents[0]`) when no input matches the document kind, so an unmatched file input is filled with an arbitrary authorized document — a transcript could be uploaded into a "tax return"/"recommendation letter" field. Wrong-document-submission risk on student funding portals.
- **[nit]** `backend/services/hamilton/hamiltonAutopilotEngine.js:564-568` — `browser = await chromium.launch(...)`/`newContext` are outside the `try/finally`; if `newContext`/`newPage` throws, `browser.close()` (in the later try's finally) never runs — leaked chromium process.
- **[nit]** `backend/services/hamilton/hamiltonAutopilotEngine.js:498` — Confirmation-reference regex `([A-Z0-9-]{6,})` matched against full page HTML; the first hit can capture an unrelated token (CSS class/asset hash).

### backend/services/hamilton/hamiltonBlockerClassifier.js
- No issues found.

### backend/services/hamilton/hamiltonBlockerStore.js
- **[important]** `backend/services/hamilton/hamiltonBlockerStore.js:284-304` — `getBlocker(db, id)` returns any blocker by id with no tenant check (and doesn't call `ensureSchema`); `recordResolution`/`resolveOpenBlockersForTask` key only on `blockerId`/`taskId`. Cross-tenant blocker resolution if ids aren't pre-verified.
- **[nit]** `backend/services/hamilton/hamiltonBlockerStore.js:188-189` — Booleans bound as integer `1`/`0` into Postgres `BOOLEAN` columns — the exact mismatch this same file fixes at lines 262-269 by binding a real boolean. Inconsistent within the file.

### backend/services/hamilton/hamiltonCredentialCsvImport.js
- **[important]** `backend/services/hamilton/hamiltonCredentialCsvImport.js:278-280` — On a `saveCredential` failure, the raw downstream error message is pushed verbatim into `result.errors` (`message: err?.message || String(err)`) and returned to the caller; if the error ever echoes the username/password/row content (DB constraint, encryption error), it leaks into the API response — undermining the header's "NEVER returns plaintext passwords."
- **[nit]** `backend/services/hamilton/hamiltonCredentialCsvImport.js:34` / `:58` — `MAX_CSV_BYTES` is enforced against `text.length` (UTF-16 code units), not bytes; multi-byte content can exceed the intended cap.
- **[nit]** `backend/services/hamilton/hamiltonCredentialCsvImport.js:255-260` — In-import dedupe key is `host::username` but `saveCredential` is idempotent on `(profile, host)` only; two rows with the same host/different usernames both call `saveCredential` and the second silently overwrites — possible silent credential loss for multi-account hosts, with no `skipped`/`error` recorded.

### backend/services/hamilton/hamiltonCredentialOwnerRouter.js
- **[nit]** `backend/services/hamilton/hamiltonCredentialOwnerRouter.js:92` — Host matching includes `h.includes(x)` (broader than the comment's "equals/subdomain"); rule host `"mit.edu"` would match `"summit.edu.evil.com"`/`"notmit.edu"`. Loosest possible host check in a module whose stated philosophy is conservative routing — can route a credential into the wrong vault.

### backend/services/hamilton/hamiltonCredentialSessionService.js
- **[important]** `backend/services/hamilton/hamiltonCredentialSessionService.js:210-218` — `markSessionUsed`/`markSessionExpired`/`revokeSession`/`getSessionById` operate on `WHERE id = ?` with no `profile_id`/`user_id` scoping despite the comment claiming callers enforce ownership; a forwarded id lets one tenant revoke/expire/read another's saved session.
- **[nit]** `backend/services/hamilton/hamiltonCredentialSessionService.js:120-122` — `safeStoragePath` disables path-traversal protection when `HAMILTON_BROWSER_STORAGE_DIR` is unset ("No restriction in test envs"); a misconfigured prod (missing env) stores an attacker-controlled `storageStatePath` verbatim and hands it to Playwright.
- **[nit]** `backend/services/hamilton/hamiltonCredentialSessionService.js:198` — `new Date(row.expires_at).getTime()` on a SQLite `DATETIME` like `2026-01-01 12:00:00` (space, no TZ) can yield `NaN`; the `Number.isFinite` guard then skips expiry, treating a stored session as non-expired.

### backend/services/hamilton/hamiltonESignatureService.js
- No issues found.

### backend/services/hamilton/hamiltonHardStopResolver.js
- **[important]** `backend/services/hamilton/hamiltonHardStopResolver.js:475-503` — `resolvePayment` calls `recordCharge` (increments `spent_cents`) with no transaction/lock around `canPayFor`→`recordCharge`; two concurrent blockers for the same authorization both pass `canPayFor` (stale `spent_cents`) and both record, overspending the authorization envelope. Reaches the same race as the payment service below.
- **[nit]** `backend/services/hamilton/hamiltonHardStopResolver.js:255` — `loadProfileMeta` failure returns `{ user_id: null }`, so `recordBlocker` writes `userId: null` (weakened tenant attribution).
- **[nit]** `backend/services/hamilton/hamiltonHardStopResolver.js:482` — `category` from untrusted `input.context.category` is unvalidated against `PAYMENT_CATEGORIES` and echoed into the escalation detail string (cosmetic; unknown category yields a safe `no_authorization` result).

### backend/services/hamilton/hamiltonNotifications.js
- **[important]** `backend/services/hamilton/hamiltonNotifications.js:133-159` — `ensuredNotifications` is a process-global boolean (not the per-db WeakMap the rest of the directory adopted with an explicit "concurrent in-memory DBs race" comment). In multi-DB/test contexts one DB marks the schema ready and a sibling fresh DB skips `CREATE TABLE`, causing "no such table: notifications."
- **[nit]** `backend/services/hamilton/hamiltonNotifications.js:331-336` — `whoMustAct` falls through to "Either the user or an admin can resolve this" when neither is required (misleading copy for a "nobody required" case).

### backend/services/hamilton/hamiltonPaymentAuthorizationService.js
- **[critical]** `backend/services/hamilton/hamiltonPaymentAuthorizationService.js:159-215` — Spend-cap enforcement is not atomic: `canPayFor` reads `spent_cents` and approves at line 174 (`if (auth.spent_cents + cents > auth.max_amount_cents) continue`); `recordCharge` later does `SET spent_cents = spent_cents + ?` (line 200) as a separate, unlocked statement. Two concurrent charges both read the stale `spent_cents`, both pass the cap, and both increment — overspending the pre-authorized envelope (the authorization bypass this service exists to prevent). Fix: a guarded `UPDATE ... WHERE id = ? AND spent_cents + ? <= max_amount_cents` checking `changes`.
- **[important]** `backend/services/hamilton/hamiltonPaymentAuthorizationService.js:187-215` — `recordCharge` takes only `authorizationId` and does NOT verify the authorization belongs to the caller's profile, nor re-check revoked/expired at charge time (`canPayFor` checks them, but `recordCharge` is independently exported and blindly increments any id).
- **[nit]** `backend/services/hamilton/hamiltonPaymentAuthorizationService.js:126-128` — The raw-card `/\d{13,19}/` guard only inspects `paymentMethodLabel`/`paymentMethodReference`; a raw PAN in `authorizationText`/`metadata` is stored unchecked.

### backend/services/hamilton/hamiltonPortalCredentialService.js
- **[important]** `backend/services/hamilton/hamiltonPortalCredentialService.js:442-460` — `getDecryptedCredential` selects all active creds for the profile and picks the first whose registrable domain matches, ordered only by `length(portal_host) DESC`; with multiple logins on one registrable domain it returns an arbitrary account (no exact `portal_host === host` preference), so Hamilton can type the wrong credentials.
- **[important]** `backend/services/hamilton/hamiltonPortalCredentialService.js:514-538` — `saveGeneratedCredential` checks existence with `WHERE profile_id = ? AND portal_host = ? AND status='active'`, but the UNIQUE index is on `(profile_id, portal_host, username)`. An active cred for the host under a different username is missed, so the INSERT proceeds and succeeds — creating a duplicate generated login for the host, contradicting the documented no-overwrite guarantee.
- **[nit]** `backend/services/hamilton/hamiltonPortalCredentialService.js:294-306` / `:494-501` — `getCredentialById`/`deleteCredential`/`markCredentialUsed` are `WHERE id = ?` only (ownership delegated to routes); a missed check is a cross-tenant credential read/delete.
- **[nit]** `backend/services/hamilton/hamiltonPortalCredentialService.js:596-612` — `revealPasswordOnceById` has a check-then-act gap: it reads `password_revealed_once_at` (null), decrypts, then marks; two concurrent reveals both pass the read and both return plaintext before either marks, defeating the at-most-once guarantee (the atomic marker's result isn't used to gate the return).

### backend/services/hamilton/hamiltonPortalPolicyRegistry.js
- **[important]** `backend/services/hamilton/hamiltonPortalPolicyRegistry.js:195-212` — `upsertPolicy` binds boolean columns with integer literals `1`/`0` (`automationAllowed ? 1 : 0`), but the Postgres columns are `BOOLEAN` (line 88). Postgres does not implicitly cast integer `1`/`0` to boolean in a parameterized bind, so policy writes throw on Postgres while passing on SQLite. Dual-dialect break.
- **[nit]** `backend/services/hamilton/hamiltonPortalPolicyRegistry.js:136-141` — Suffix-walk `for (let i = 1; i < parts.length - 1; ...)` never matches a bare 2-label `mtsu.edu` row (covered by the earlier exact-match query, so benign off-by-one).

### backend/services/hamilton/hamiltonPortalProviders.js
- **[nit]** `backend/services/hamilton/hamiltonPortalProviders.js:107-113` — Postgres `CREATE TABLE` emits `live_supported ${boolType} NOT NULL DEFAULT 0` with hardcoded `0`/`1` literals (not `defFalse`/`defTrue`); Postgres rejects `DEFAULT 0` on a BOOLEAN column, so schema creation would fail on Postgres.

### backend/services/hamilton/hamiltonPreflight.js
- **[nit]** `backend/services/hamilton/hamiltonPreflight.js:284-288` — `readAuthorizations` keeps a trailing `void isAuthorizationActive` purely to retain the import (acknowledged in comment); dead code.
- **[nit]** `backend/services/hamilton/hamiltonPreflight.js:75-92` — `listProfileDocuments` falls back from a `profile_documents` join to `SELECT * FROM documents WHERE profile_id = ?` inside a bare `catch`; a transient (non-missing-table) join failure returns a looser document set (both profile-scoped).

### backend/services/hamilton/hamiltonPreflightResolver.js
- **[important]** `backend/services/hamilton/hamiltonPreflightResolver.js:145-168` — `preflightAndResolveSource` calls `resolveBlocker` for every predicted blocker during preflight, and the payment path (`resolvePayment`) will actually `recordCharge` if `canPayFor` allows. So a *preflight* (conceptually a dry-run) can book real spend against a payment authorization before the user launches the run, under a synthesized `preflight_...` task id.
- **[nit]** `backend/services/hamilton/hamiltonPreflightResolver.js:247-253` — `financialReadiness(profile, classification)` ignores its second parameter (dead arg / signature mismatch).

### backend/services/hamilton/hamiltonResolvedFieldStore.js
- No issues found.

### Hamilton live TOTP/MFA automation
- Removed. Hamilton no longer stores or derives live TOTP/MFA codes; users clear 2FA themselves and save a trusted browser session when a portal supports it.

### backend/services/hamilton/studentFundingPortalLinker.js
- **[important]** `backend/services/hamilton/studentFundingPortalLinker.js:527` / `:648-670` — `linkOpportunityToPortal` wraps its writes in `withProfileScope({ bypass: true })`, disabling the DB-layer tenant guard, while read helpers query with a bare `WHERE profile_id = ?` and no `withProfileScope`. Correctness depends entirely on `effectiveProfileId` being trustworthy; an unvalidated `profileId` from a route can write a link into any profile.
- **[nit]** `backend/services/hamilton/studentFundingPortalLinker.js:312` — `safeProg.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')` has a malformed regex-escape character class; some metacharacters in a program/major name may not be escaped before `new RegExp(...)`, risking a throw or unintended match on crafted profile data (compare canonical `[.*+?^${}()|[\]\\]`).
- **[nit]** `backend/services/hamilton/studentFundingPortalLinker.js:40-85` — `ensuredLinkSchema` is a process-global boolean (same anti-pattern as hamiltonNotifications); multi-DB/test usage can skip `CREATE TABLE application_portal_links` on a sibling DB.

### backend/services/hamilton/studentPortalStore.js
- **[important]** `backend/services/hamilton/studentPortalStore.js:50-119` — `ensuredSchema`/`ensureSchemaPromise` are process-global, captured against the FIRST `db` (`if (ensuredSchema) return` before any per-db check). In multi-DB usage (concurrent in-memory test DBs, or DB-per-tenant) a second DB never gets `student_portals` created → "no such table." This is the exact race the other Hamilton stores fixed with a per-db WeakMap; this file (and `studentFundingPortalLinker`) was not migrated.
- **[nit]** `backend/services/hamilton/studentPortalStore.js:336-360` — `setStudentPortalActive`/`recordPortalCheck` don't validate `profileId`/`portalId` are non-null before the UPDATE (unlike `getStudentPortal`); both are profile-scoped so a null id matches nothing, but it diverges from the file's own convention.
