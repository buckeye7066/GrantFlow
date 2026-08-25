# PLAN — Bug A PROGRAM: de-contaminate the web lane (multi-session)

Status: PROGRAM plan (owner chose full build). Resolves Sol's 7 blockers, phased
so each phase is independently safe. Sequencing per Sol: profile-blind extractor
is safe default-off; catalog writes are gated; the migration is a SEPARATE,
manually-applied, separately-reviewed final step after a canary. Flag:
`WEB_LANE_PROFILE_BLIND` (default OFF; flag-off = exact legacy path).

## The bug (confirmed live, post-#964)
- `webGrantExtractor.js:127` filters to opportunities "this applicant could apply
  for" (hard pre-filter before matchEngine).
- `webLane.js` mapper: geography fallback ~77–82, `summary||eligibility` drops
  eligibility ~92, applicant-type stamping ~97–100, need-derivation from the
  profile-conditioned `relevance_reason` ~101.
- `crawlerOsPersistence.js:506` deletes prior primary-profile matches before
  re-insert (why a changed identity/field can drop a real match).

## PHASE 0 — Foundations (no behavior change; default-off code only)
0.1 **Durable page-fact provenance.** OS `storage.upsertOpportunity` discards
`raw` today. Add first-class `eligibility_text`, `eligibility_bullets`,
`page_fact_schema_version`, and per-field provenance/evidence (JSON) through: OS
contract, memory storage, `osOppToLiveRow`, SQLite + PG migrations,
`ensureOsTables`, canonical-matcher facade. Tri-state `is_loan`/
`requires_cost_share`/`national` (false ≠ "not mentioned"). [Sol #2]
0.2 **Content-addressed fact cache** keyed by `(normalized final URL, content_hash,
extractor_version, prompt_version, model)` → deterministic "same page ⇒ same
facts", reused across profiles. [Sol #1]
    Build spec: new `page_fact_cache` table (guarded migration, NOT ensureOsTables
    hot path) with the composite key + the extracted page-fact JSON + created_at;
    a `getCachedPageFacts(key)` / `putCachedPageFacts(key, facts)` accessor module
    (pure, injectable DB) that is UNUSED by the live path in this PR (wired only by
    Phase 1's blind extractor). Additive, default-off, zero behavior change. Tests:
    round-trip, key-collision determinism, miss→null, idempotent migration.
0.3 **Split the reality gate** into global reality checks vs profile policy; move
loan/cost-share rejection (`realityGate.js:88–94`) OUT of the gate into the
matcher (or document as a global product exclusion) so catalog presence stops
depending on which profile crawled first. [Sol #1]

## PHASE 1 — Profile-blind extractor + honest facts (flag ON = SHADOW/dry-run, NO live writes)
1.1 `extractPageFactsBlind({pageUrl, html, linkInventory})` — inputs EXCLUDE
thesis/query/seed/profile; model returns only an enumerated link ID; code builds
the URL and REJECTS any non-inventory URL. Keep `page_url`/`info_url`/`apply_url`
distinct; fallback → `info_url`, never `apply_url`. [Sol #1]
1.2 **Bounded link inventory** from anchors + form actions/labels + application-mode
evidence; strip tracking params, PRESERVE identity-bearing params; deterministic
ordering by evidence/document order, NEVER profile fit. Handle inline-form direct
opps (htmlToText strips `<form>`). [Sol #1/#3]
1.3 **Independent target verification** — probe the selected target separately via
`makeProductionFetcher`; store source-evidence vs target-verification as DIFFERENT
facts; `VERIFIED` only on target proof (extends #964's honesty). [Sol #1/#7]
1.4 **Profile-blind mapper** — neutral values, never fall back to profile; summary
and eligibility kept SEPARATE (fixes `summary||eligibility`); controlled vocab for
applicant types/states (no arbitrary LLM label → restrictive entity). [Sol #2]
1.5 **Code-validated evidence spans** — every snippet must be a normalized
substring/offset of stored source text; LLM assertion alone never counts. [Sol #7]
1.6 **Numeric caps (enforced predicates, not prompt text):** ≤8 parsed facts/page,
≤5 quality rows/page, ≤30 new rows/run, ≤5/domain/run, ≤250/day global w/
backpressure; seed pages count against caps; ≤1 wrapper/index page; telemetry for
raw facts, each rejection reason, dupes, per-domain, truncations, global-cap
deferrals. (Numbers tunable post-canary; enforcement mandatory.) [Sol #3]
1.7 **Trust-aware DIRECTORY (NOT a new kind).** Protected only with named operator
+ page-supported evidence + verified live info target + trusted provenance; else
unprotected (broken link hides it; source-hash doesn't verify). Avoids the ~15-
consumer `AGGREGATOR_INDEX` semantic migration. [Sol #4]
1.8 **Shadow/dry-run harness** — run blind extractor + canonical matcher in dry-run
on real profiles; compare against recorded legacy JSON/write-traces + synthetic
fixtures. NEVER re-invoke the old profile-bearing prompt for comparison. [Sol #6]

## PHASE 2 — Identity aliasing + non-overwriting persistence (still no legacy migration)
REVISED 2026-07-21 after Sol's freshness review against post-#994 code (verdict:
REVISE ×4). Key as-built facts the original spec mispredicted: Phase 1 kept blind
candidates in an internal accumulator reduced to COUNTERS (`webLane.js` ~304-348,
`shadow.targets` ~553-560 → counters ~586-602) — no durable candidate set exists;
`WEB_LANE_PROFILE_BLIND_WRITES` exists only in a comment (flag read is
`crawlerOsService.js` ~212-221; only the shadow flag is in .env.example ~741);
the target verifier caches only a BOOLEAN and discards the redirect-final URL
(`webLane.js` ~159, ~208-225; run result = aggregate counters ~653-665); blind
candidates never pass `computeMatchDecision` (only legacy candidates do, ~482-488
— `real_and_matched` is "verified+evidenced", NOT a canonical match). Four
sub-PRs, each independently safe, flag-gated, additive:

2.1 **Schema + unused accessors.** `opportunity_identity_aliases(scheme,
identity_key, opportunity_id, first_seen_at, last_seen_at)` UNIQUE
`(scheme, identity_key)` + index on `opportunity_id`, PLUS a durable
`opportunity_identity_conflicts` quarantine table (candidate identity, both
opportunity ids, evidence, resolution state) — quarantine must be a durable sink
with resolution state, not a log line. Immutable/versioned scheme names
(`verified_target_v1`). SQLite + PG parity, fresh-schema coverage, DDL via
guarded migration NOT `ensureOsTables`. No backfill, no runtime use. RETAIN
`canonical_opportunity_key` untouched (title-first algo `contract.js` ~147-173;
memory store ~storage.js 62-88; live lookup `crawlerOsPersistence.js` ~523-547).

2.2 **Pure target-identity policy.** REUSE `urlCanonical.js` (~12-59) — it
already strips only a tracking-param allowlist; do NOT introduce a second
tracking list. Define `verified_target_v1` identity on top of it and PIN the
semantics in tests: redirect-FINAL URL (not requested), fragment dropped, query
order normalized, trailing-slash normalized, id-bearing params kept
(`?id=123` ≠ `?id=456`), generic/shared-portal detection → composite
(title+sponsor) fallback. `normalizeUrlForId()` (`contract.js` ~210-218, strips
ALL query) must NEVER be used for target aliases and must not be changed (would
silently rekey `canonical_opportunity_key`). Note `webLane.js` ~127-143 drops
fragments for fetch-dedup — fetch-dedup semantics stay separate from identity
semantics.

2.3 **Candidate-level promotion handoff (still ZERO live writes).** Make
`WEB_LANE_PROFILE_BLIND_WRITES` operational (read + documented in generated env
examples; requires shadow flag too; both default OFF). Retain per-candidate
data the counters currently discard, in a DEDICATED buffer/store returned from
the run (never the shared store): candidate-scoped extraction, source evidence,
target verdict, redirect-final URL, kind/trust classification, and a REAL
`computeMatchDecision` verdict for blind candidates (today's `real_and_matched`
counter is not a match decision). Shadow-only remains default and DB-free.

2.4 **Transactional dual-read/quarantine persister.** A blind-specific persister
(NOT the generic upsert): explicit field-authority matrix / strict blind-write
allowlist — the generic conflict handler special-cases only `field_provenance`
and every other column is incoming-wins (`crawlerOsPersistence.js` ~408-447),
and current mapping stamps `record_origin`/`is_active`/`is_hidden`/fresh
`discovered_at` (~338-379): none of that may cross onto a survivor row. Dual-
read legacy canonical key AND target alias; differing IDs → durable quarantine
row, NEVER auto-overwrite; survivor collisions update aliases/provenance only.
Alias lookup + legacy lookup + insert/update + conflict record + alias insert =
ONE transaction (concurrent discoveries must not both observe "no alias").
Do NOT invoke `persistRun()` a second time — its reconciliation delete
(~573-577) would erase the just-persisted legacy match set; blind writes are
additive or folded into one deliberately unified reconciliation.

Phase-3 amendment from the same review: the repoint inventory MUST also cover
`opportunity_identity_aliases` + `opportunity_identity_conflicts` themselves
(and `rekey-dedup-catalog.mjs` still only repoints matches/grants/sources —
~12-15, ~71-95). #991-#994 added NO opportunity-referencing tables (verified:
Anya/Hamilton surfaces only; `hamilton_saved_sessions` has no opportunity ref).

### Round-3 pins (Sol round-2 REVISE ×4, all resolved here)

**P1 — Promotion eligibility + flag→persister wiring.** The blind persister is
invoked from `crawlerOsService` AFTER target verification settles (today it
settles after `persistRun()` — the blind persister call goes after that point),
EXACTLY ONCE per run, gated `WEB_LANE_PROFILE_BLIND &&
WEB_LANE_PROFILE_BLIND_WRITES && !dryRun`, consuming the 2.3 candidate buffer.
Promotion eligibility (ALL required per candidate): code-validated evidence ≥1
fact; target verification VERIFIED (redirect-final URL captured); global
reality verdict pass; kind/trust eligibility (DIRECTORY only per
`isRecommendable`); and a canonical `computeMatchDecision` verdict computed at
persist time. Catalog row written on eligibility; a match row written ONLY on
ACCEPT (REVIEW-tier/locators surface as recommendations, never auto-add — the
locator rule). Every blind-written match row records `match_engine_version` +
`written_by: 'web_lane_blind'`.

**P2 — `verified_target_v1` grammar (immutable, disjoint prefixes).**
AMENDED at 2.2 review, REFINED at fix-cycle-2, then HARDENED at fix-cycle-3
(Sol round-3 FIX FIRST ×5): a durable identity_key must NEVER contain a secret,
and volatile UI state must NEVER create identity. The fragment classifier
(`classifyFragment`, FROZEN in v1) now runs this PRECEDENCE: percent-decode →
HARD-credential scan (hash AND query) strip+quarantine → OAuth-context
state/code strip → ROUTE (`^#!?/` only) preserve → VOLATILE strip.
  • CREDENTIAL scan runs FIRST and WINS over route shape, over BOTH the hash
    AND the query. Keys are PERCENT-DECODED (`%61ccess_token` caught) and the
    fragment is split on `?`/`&`/`;`/`/` so a pair embedded in a route is found.
    HARD keys (`HARD_CREDENTIAL_PARAM_NAMES`: access_token, id_token,
    refresh_token, token, token_type, bearer, session, sessionid, sid) are
    ALWAYS stripped and quarantined — never in identity_key, nor logs. The pair
    is stripped, then the REMAINDER is classified (`#/callback/access_token=S`
    keys as `#/callback`). `state=`/`code=` are AMBIGUOUS (legit UI params AND
    OAuth nonces): stripped ONLY in OAUTH-CALLBACK CONTEXT — an exact
    `callback`/`oauth`/`auth` path segment (segment-exact, so `/author` does
    NOT arm it) OR hard-key co-presence in the same hash/query; otherwise
    `state=open` / `code=PA-123` are ordinary, PRESERVED params. The SAME
    stripping applies to URL QUERY params (hard keys always; state/code under
    the OAuth gate) — `/oauth/callback?code=SECRET&state=NONCE` never persists
    verbatim; canonicalizeUrl's preserve-verbatim rule for other non-tracking
    params is untouched.
  • ROUTE — leading-slash SPA routes ONLY (`#/opportunity/123`,
    `#/grants/abc-def`, `#/fo/2025-xyz`, hashbang `#!/…`; `ROUTE_FRAGMENT_SHAPES
    = ['^!?/']`). PRESERVED verbatim — the legitimate SPA-portal case
    (`app#/grant-A` ≠ `app#/grant-B`). Route forks (`#/x` vs no fragment) are
    accepted: fork = recoverable, collapse = corruption.
  • VOLATILE — everything else: scroll/viewport/anchor state (`#scroll=417`,
    `#top`, `#section-2`) AND slash-anchors that are not leading-slash routes
    (`#section/2`, `#tab/details`, `#app/grants/x` — the fix-cycle-2
    bare-segment shape wrongly promoted these). STRIPPED, so scroll/tab
    variants collapse to ONE identity and a volatile anchor on a shared
    listing never rescues it out of the title_sponsor fallback (two grants on
    `…/grants#tab/details` fall to DISTINCT title_sponsor keys, never a
    collapsed url: key).
Id-bearing params = curated NAME grammar (exact names/prefixes:
id, oppid, opportunityid, grantid, fon, oppnum, cfda, key, appkey, code,
recordnum…) with NON-EMPTY values — never a bare `id`-suffix heuristic
(`?valid=1` matched). v1 freezes ALL dependencies: the tracking-param
allowlist is snapshot-pinned (hash tripwire — a list change fails the test and
forces an explicit decision), the frozen title normalizer is source-hash
pinned, and EVERY set that influences the url: vs title_sponsor: decision is
folded into ONE portal-identity snapshot hash — the curated generic-portal host
table, `GENERIC_LISTING_PATHS` (fix-cycle-2: it also decides keying, so adding
`/funding` must red the tripwire — it silently re-keyed before), the id-param
grammar, and the fragment-classifier constants (`ROUTE_FRAGMENT_SHAPES`,
`HARD_CREDENTIAL_PARAM_NAMES`, `OAUTH_STATE_PARAM_NAMES`,
`OAUTH_CONTEXT_PATH_SEGMENTS`). Fix-cycle-3 adds: `TRACKING_EXACT`/
`TRACKING_PREFIXES` are DEEP-frozen (Set mutators throw — `.add('id')` can
never silently re-key at runtime), and a GOLDEN-VECTOR tripwire hashes
representative classifier inputs→outputs so the LOGIC itself (delimiter set,
key normalization, precedence, OAuth-context rule) is pinned, not just its
tables. All FROZEN in v1 (additions =
verified_target_v2 or an explicit re-key migration; a missed portal page just
produces url:-key conflicts that 2.4's dual-read/quarantine surfaces).
Duplicate query keys: values sorted bytewise within each key.
`url:<key>` where `<key>` = redirect-FINAL URL → `urlCanonical.js`
allowlist-strip → lowercase scheme+host → strip credential params from the
QUERY (hard always; state/code under the OAuth gate) → sanitize fragment and
keep a ROUTE remainder ONLY (per `classifyFragment`) → sort query keys
bytewise (and duplicate values within a key) → strip trailing slash. Generic/shared-portal detection is a
DETERMINISTIC predicate: (a) curated host+path table (grants.gov search/portal
endpoints, google/bing hosts, generic apply-portal hosts) OR (b) canonicalized
URL has no path beyond `/` and no query, OR (c) path matches
search/listing endpoints (`/search`, `/opportunities`, `/grants` bare) with no
id-bearing param. Generic → fallback `title_sponsor:<key>` where `<key>` is a
FROZEN V1 COPY of today's token-sorted title+sponsor normalization (copied into
the v1 module, NOT a call into the shared helper — later helper changes cannot
silently rekey v1). Scheme names are append-only; changing grammar = new scheme
`verified_target_v2`.

**P3 — Persistence decision table + concurrency.** Additive-ONLY this phase:
the blind persister NEVER deletes and NEVER runs any reconciliation (unified
reconciliation is deferred to Phase 3 cutover — decision made, not left open).
Table, per candidate with legacy key L and alias key A:
| L row | A row | action |
| absent | absent | INSERT new row (allowlist below); insert alias A→new id |
| present | absent | insert alias A→L's id; survivor-update L (provenance/alias fields only) |
| absent | present | survivor-update A's row; NO new row |
| present | present, same id | survivor-update; refresh alias last_seen |
| present | present, different ids | durable conflict row (upsert semantics P4); NO catalog write; NO alias change |
New-row field allowlist (exact): title, sponsor, summary, eligibility_text,
eligibility_bullets, amounts (structured only), deadlines, urls
(page/info/apply), kind, trust fields, provenance/evidence JSON,
page_fact_schema_version, source ids, `record_origin='web_lane_blind'`.
Survivor-update allowlist (exact): `field_provenance` merge, alias table rows,
`last_seen_at` — NOTHING else (never `is_active`/`is_hidden`/`discovered_at`/
status/user fields; the generic upsert is NOT used). Concurrency: Postgres —
`pg_advisory_xact_lock(hashtext(scheme || ':' || identity_key))` taken before
the dual-read, so two transactions cannot both observe "no alias"; unique
violation → retry-once re-read. SQLite — single-writer serialized via
`BEGIN IMMEDIATE` transaction (per-identity lock unnecessary under a write
lock); same retry rule. Both wrapped in one helper `withIdentityTxn(scheme,
key, fn)` with dialect dispatch.

**P4 — Conflict idempotency + Phase 3 cleanup.** DDL:
`opportunity_identity_conflicts(id PK, scheme, identity_key, opportunity_id_a
FK, opportunity_id_b FK, evidence JSON, status
open|resolved_merged|resolved_distinct|dismissed, first_seen_at, last_seen_at)`
with partial-unique index on `(scheme, identity_key)` WHERE status='open'
(PG + SQLite both support partial indexes). Re-observing an open conflict =
UPDATE evidence + `last_seen_at`, never a second open row. Phase 3 duties (in
the migration script, extending the accepted amendment): repoint
`opportunity_id_a`/`opportunity_id_b` AND `opportunity_identity_aliases.
opportunity_id`; repoint alias ownership BEFORE loser deletion; post-repoint:
conflicts where a==b → `resolved_merged`; dedupe any resulting duplicate open
conflicts per (scheme, identity_key) keeping the earliest `first_seen_at`.

Repo hygiene (tracked, outside Phase 2 scope): 6 open Dependabot PRs
(#976-#980, #982) — disposition after the Phase 2 PRs land.

## PHASE 3 — The migration (SEPARATE script, manually applied, separately reviewed, AFTER canary)
3.1 **Transactional inventory ≥11 tables:** `profile_opportunity_matches`,
`opportunity_sources`, `grants.funding_opportunity_id`, verification events +
evidence, embeddings, geo indexes, vNext applications, saved/tailored grants,
Robert recommendations, exclusion audit + match feedback, portal links +
application tasks. (`rekey-dedup-catalog.mjs` covers only 3 — extend it.) [Sol #5]
3.2 **Collision policy:** define survivor, alias, repoint, rollback; INVALIDATE +
recompute affected matches (stale scores must not survive); preserve protected
user-progress separately. [Sol #5]
3.3 **Legacy rows without provenance:** re-fetch/re-extract blind to repopulate
supported fields, OR conservatively clear suspect fields — new provenance cannot
retroactively prove old fields. [Sol #2]
3.4 **Canary + negative controls:** profile-swap negative controls + manually-
reviewed catalog samples (golden checks alone confirm contaminated expectations).
[Sol #7]

## Cross-cutting
- **Flag-off equivalence:** flag branches BEFORE any new logic; legacy path
  untouched; new telemetry flag-conditioned. "Equivalent" = exact return shape +
  memory/SQL write-trace under fixed injected deps/seed/clock (not literal bytes —
  LLM/network/`Date.now()`/seed nondeterminism). Migration is EXCLUDED from the
  flag-off deploy (turning the flag off can't restore a migrated DB). [Sol #6]
- **Anti-self-confirmation:** no fact is trusted because the LLM asserted it —
  open/current/real, evidence spans, "application link", "named operator" each
  need a CODE predicate or independent probe. [Sol #7]
- **Do not touch** `matchingEngine.js`/`matchDecisionEngine.js`/`crawlers/matchEngine.js`.

## Sol build-order adjustments (round 2 — conditional GO)
- **Two flags, not one:** `WEB_LANE_PROFILE_BLIND` (shadow compute) AND a separate
  `WEB_LANE_PROFILE_BLIND_WRITES` (default OFF) — the shadow flag must never
  silently enable writes when Phase 2 deploys.
- **Phase 1 shadow store:** blind results/evidence/matches/rejections live in a
  DEDICATED shadow memory store; never the shared store persisted at
  `crawlerOsService.js:297`. dryRun already returns before persist (`:278`).
- **Phase 0.1 DDL off the hot path:** do NOT add blind-schema DDL to
  `ensureOsTables` (`crawlerOsPersistence.js:397`, runs on every persistence call)
  — that breaks flag-off SQL equivalence. Use an explicit guarded migration.
- **FIRST PR = 0.3 only**, as a pure mechanical refactor: split global reality
  checks from profile policy but keep `enforceReality()` composing both EXACTLY as
  today (`realityGate.js:88`), change no callers, no DB. Then 0.1/0.2 foundations.

## Execution order (multi-session)
Phase 0 → 1 → 2 land as separate flag-gated PRs (Sol builds, Fable reviews,
adversarial round each). Phase 3 (migration) is authored last, dry-run on a DB
copy, and applied from a controlled migration run after the canary report — never
auto-merged, never on the flag-off path.
