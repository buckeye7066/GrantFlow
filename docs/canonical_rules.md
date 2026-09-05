# GrantFlow Canonical Rules & Goals

_Last updated: 2026-07-07 (this file's own INVARIANTS table below has not been
kept current — see the note at the top of that section)._

This document is the **single source of truth** for GrantFlow's product rules
(the G0–G8 goals and the product thesis above). For the INVARIANTS table
specifically, `CLAUDE.md` at the repo root is now the more current and complete
copy — see the note there.

If a rule is uncertain, it is marked explicitly as an **Assumption**. **Do not change behavior** that depends on an assumption until the assumption is either confirmed or replaced with an explicit rule.

## Scope

Applies to:
- **Backend**: `backend/server.js`, `backend/routes/*`, `backend/services/*`, SQLite schema in `backend/db/schema.sql`
- **Frontend**: `src/pages/*`, `src/api/*`, `src/stores/*`
- **Automation**: crawler jobs (`crawler_jobs`), funding catalog (`funding_opportunities`), pipeline (`grants`)

## Definitions

- **Profile**: A record in `profiles` plus its structured `profile_sections`. Profiles may be linked to a user via `profiles.user_id`.
- **Opportunity / Funding Opportunity**: A row in `funding_opportunities` (the “Discover Grants / Funding Opportunities catalog”).
- **Grant**: A row in `grants` representing a pursued opportunity (pipeline status workflow).
- **Crawler Job**: A row in `crawler_jobs` representing an automation run (local, scholarship, comprehensive, item_search, document_ingest, profile_enrichment, pipeline_automation, avatar_lookup).
- **Match score (DATA-POINT SCALE, owner directive 2026-07-06 evening)**: the 0–100
  match score IS the share of the profile's ENTIRE data-point inventory the
  opportunity matches — `matched data points ÷ total data points × 100` — gated
  multiplicatively by eligibility (1.0 confirmed / 0.8 unknown / 0.15 explicit
  mismatch) and geography (1.0 in-area / 0.7 unknown / 0.3 out-of-area).
  **"88 data points in the profile, source matches 44 → 50."** The canonical
  inventory (needs, geography components, applicant type, demographic/eligibility
  traits, interests, academics, financials, document-derived keywords) is built by
  `backend/services/profileDataPoints.js` — the SAME list feeds the denominator,
  the stored per-match evidence (`match_explain_json.dataPointEvidence`), and the
  Coverage & Evidence Dashboard, so a score and its explanation can never drift.
  Real profiles carry 50–150 data points, so absolute scores run LOW by design;
  bands are EMPIRICALLY calibrated against the prod distribution (2026-07-06:
  p50=8 · p90=15 · max=47): **8 = pipeline bar** (`AUTO_ADD_SCORE`) · 11 good ·
  14 strong · 7 review-worthy · floor 2. Hard ineligibility (seniors-only vs a
  30-year-old, org × individual assistance) stays a REJECT gate/crush factor —
  never outrunnable by matching many data points. Profiles with NO usable data
  points cap at 13 (topical evidence only). Recalibrate by re-running
  `backend/scripts/score-distribution.mjs` and re-mapping — never hand-tune one
  bar. Single source of truth: `backend/config/matchThresholds.js`
  (+ `src/lib/matchDisplayThresholds.js` sync). The need-anchored scale (main
  needs capped at 4) is retired; `GRANTFLOW_SCORING_MODEL=need_anchored` is a
  temporary A/B escape hatch only.
- **Orphan profile**: A `profiles` record that is **not linked to any `users` row** (`profiles.user_id IS NULL`) but is otherwise active.

## Product goals (from repo docs + implementation)

Sources:
- `README.md`
- `docs/PROD_READINESS.md`
- `docs/AUTH_FLOW_BLUEPRINT.md`
- `docs/BASE44_GAP_ANALYSIS.md`
- `OPS_AUTOFIX.md`
- Current implementation in `backend/services/*.js` and `src/pages/*.jsx`

### The product thesis — GrantFlow's case over a Google search (owner-ratified, 2026-07-06)

GrantFlow's case over a competent web search rests on **four pillars**. Each
carries its current honest status; a pillar's status may only move forward with
evidence (a shipped lane, a passing benchmark), never by rewording:

1. **It knows the whole profile.** The match score IS
   `matched data points ÷ ALL profile data points × eligibility/geo gates`
   (the 2026-07-06 data-point scale, defined under *Definitions* above), with
   per-match evidence stored in `match_explain_json.dataPointEvidence`.
   *Honest status:* ranking is real and explainable; **RECALL (catalog
   breadth) is now the bottleneck**, not precision.
2. **It searches 80+ official lanes simultaneously, continuously.**
   Federal / state / benefits / 990-funder lanes with deadline awareness,
   running in the background whether or not anyone is logged in.
   *Honest status:* lanes must keep growing; **a lane the registry lacks is a
   structural gap** (an adapter-wishlist item on the coverage-gap scoreboard),
   never a silent miss.
3. **It acts.** Hamilton live applications, printable packets, portal
   sign-ins, John/Yana outreach. A Google search ends at links; GrantFlow ends
   at a submitted application.
4. **It explains itself.** The Coverage & Evidence dashboard shows what was
   searched, what was missed and why, why each surviving match survived, and
   which profile question to answer next.

**THE MEASURED BAR (the product bar):** *for each golden profile, GrantFlow's
results must beat a competent 30-minute web-search session.* This is
implemented as the **web-parity benchmark**: per-profile parity scores
persisted in `system_kv` `web_parity_benchmark`, asserted nightly by Sam's
`coverage.webParityBenchmark` check, with a **no-regression ratchet**. Every
benchmark failure feeds Amy's work queue (`system_kv` `web_parity_gap_queue`)
and the adapter wishlist — a failure is queued work, never a shrug.

#### A funding source found for a profile gets ADDED (owner rule, 2026-07-16)

> **If a funding source is found that meets a profile's needs, add that funding
> source.** Finding it and filing it is not finding it. A queue with no consumer
> is a record of the gap, not a fix for it.

This is the rule the gap queue existed to serve and did not. The benchmark found
real funding pages GrantFlow lacked, wrote them to `web_parity_gap_queue`, and
**nothing ever read that key** — so the same real sources were re-found and
re-filed every night while the owner's report asked him to adjudicate them by
hand ("candidate queue — nothing auto-added", 2026-07-15, fleet parity 41.2 and
falling). The finding was correct every night; only the loop was open.

How it is enforced, and why automating it lowers no bar:

- `loadGapSeedPagesForProfile()` (`services/webParityBenchmark.js`) hands a
  profile's pending candidates to its next discovery run as **seed pages**
  (`opts.seedPages`, `crawler-os/webLane.js`), bounded by
  `GAP_SEED_LIMIT_PER_RUN`.
- **A seed is a URL, not a verdict.** It enters the web lane at exactly the
  place a search hit does and is then fetched (SSRF-safe), LLM-extracted,
  reality-gated, deduped and scored by the canonical match engine like anything
  else. Being found by the benchmark buys a page a LOOK — never a catalog row,
  never a match, never a score. Seeding is therefore *strictly* the removal of a
  search's failure to find; every substantive gate still decides.
- **The gates' verdict is recorded, not the attempt.** The lane reports which
  seeds actually produced a catalog row (`seeded_adopted_urls`), and
  `markGapCandidateOutcomes()` marks each offered candidate `adopted` or
  `gated_out`. Both are terminal: a page the reality gate refused cannot answer
  differently next time, and leaving it `candidate` would rebuild the write-only
  queue. "We seeded 8 pages" must never be reported as "we added 8 sources" —
  that is the read-green-while-doing-nothing class this repo has now shipped
  three times (#941, #944, and this queue).

**Generalize:** any queue this system writes must name its consumer. A finding
that only accumulates is an unpaid debt that reads like diligence.

#### The adapter wishlist asks an answerable question, and something answers it

The same rule, applied to the second write-only queue (2026-07-16). The fleet
gap scoreboard's **adapter wishlist** is legitimate — "a lane the registry lacks
is a structural gap, never a silent miss" — but it was neither honest nor
actioned:

- **It asked unanswerable questions.** `signals.health` conflates diagnoses with
  support needs, disability descriptors and canonical flags, so the disease-lane
  loop demanded a *disease source lane* for `lodging`, `unsteady gait`,
  `clawing effect in hands` and `mobility_needs`. Provenance is now recorded at
  the write site (`health_conditions` vs `health_support`); only diagnoses reach
  that loop, and support needs become a NEED question whose fix is a one-line
  alias, not a new lane. **A denylist cannot fix a free-text field** — that is
  why `NON_DISEASE_HEALTH_SIGNALS` never converged.
- **It answered coverage on a coincidence.** A condition counted as covered when
  any ≥4-char word of it appeared in a haystack that included the source's free-text
  `source_id`/`name`. Coverage is now decided only by a source's CURATED
  vocabulary (`keywords[]` + `need_categories[]`), which every `disease_specific`
  source must therefore carry.
- **Nothing acted on it.** A `no_disease_source` gap is now a bounded search whose
  real hits are queued for GATED adoption via the same seeding lane; an adopted
  source **retires** the entry through the `condition_source_coverage` overlay
  (the scoreboard reads the static registry, so without that overlay a closed gap
  re-emits forever — convergence with a footnote is not convergence).
- **When nothing exists, say so.** After `MAX_ATTEMPTS` honest searches the entry
  is marked `exhausted` and **stays visible** carrying what was tried. "Nobody has
  looked" and "we looked and there is nothing" are different facts (G0); a wishlist
  that reads the same on night 1 and night 30 is wallpaper, not a finding.

### The self-improvement loop (first-class rule: the system may only get better)

> **Every owner-verified outcome becomes a golden expectation; every benchmark
> failure becomes queued work; no ratchet may regress without a red finding.**

The loop, concretely:

- **Golden-outcome sentinel** — when the owner verifies a result live ("this
  profile really should find X"), it is appended as a permanent nightly
  assertion (Sam check `coverage.goldenOutcomes`). Expectations are DATA, not
  code: they are appended after every live-verified fix and never silently
  removed.
- **Gap scoreboard drives Amy** — Amy's training/crawl tasks derive from the
  Coverage & Evidence gap scoreboard (`system_kv` `coverage_gap_scoreboard`),
  the structural matrix, and the web-parity gap queue — **never at random**.
  Structural gaps Amy cannot fix become adapter-wishlist items.
- **Benchmark ratchet** — the web-parity score must not regress; a regression
  is a red Sam finding, not a quiet trend line.
- **Empirical tuning only** — Amy's existing KEEP/REVERT discipline: a tuning
  change is applied only when proven on a big-enough cohort, is bounded,
  backed up, and auto-reverted on mismatch.
- **Migration parity** — the migration-parity rule in `CLAUDE.md` (SQLite +
  Postgres migrations move together) keeps the loop's stores portable.
- **Every profile field feeds the matcher or is drafting-only prose** (owner
  directive 2026-07-07 profile schema redesign). Every field in
  `backend/config/profileSchema.js` is EITHER a structured, matcher-consumed
  data point (`format:'enum'` + `options`, `format:'tags'` + `vocabulary`,
  boolean/number/date) OR explicitly `format:'prose', scored:false`
  drafting-only prose. No field collects free text that floods the scoring
  inventory: `scored:false` prose (mission, `narrative.*`, every `*.notes`, the
  `essays` section) is NEVER scored and NEVER mined into the keyword inventory
  (the miner `collectNarrativeKeywords` is gated on the schema's scored flag),
  yet stays fully readable for Hamilton/Anya drafting. Controlled vocabularies
  are SOURCED FROM THE MATCHER'S OWN VOCABULARY (`backend/config/profileVocabulary.js`,
  derived from `NEED_ALIAS_MAP` / `CANONICAL_NEED_CATEGORIES`) so every collected
  value is guaranteed to score. A field a source cannot match on shouldn't be
  collected. **New fields require a matcher use or a `scored:false` marker** —
  `backend/tests/profileSchemaContract.test.js` asserts every field has a
  resolvable format, enum fields carry non-empty options, tag fields point at a
  real vocabulary, and no field is both scored and `format:'prose'`. "Remove a
  field" means stop collecting/scoring/showing it (`deprecated:true`) — never
  drop the column or stored data.

### Evolved product goals (2026-07)

The G-rules below remain binding, but the product has evolved past
"discovery catalog + pipeline" — every new feature should also serve the four
pillars above and these evolved goals:

1. **End-to-end funding cycle, not just discovery.** Discover → match →
   pipeline → draft → apply (Hamilton live portal automation, packets,
   mail/fax) → track awards. Features that stop at "here's a list" are
   half-done; features that move a user one step closer to submitted are the
   priority.
2. **Grounded drafting quality.** Drafts must be competitive AND honest:
   grounded in the profile's real evidence, informed by REAL comparable funded
   awards (reference-only lane), and audited by critic passes (compliance
   responsiveness + evidence consistency, `PROPOSAL_CRITIC`) on top of the
   deterministic fabrication guard. Quality tooling is additive — it explains
   and flags; it never silently rewrites or invents.
3. **Recall without junk.** Keyword/rule matching is the deterministic
   authority; approved additive recall lanes (threshold relaxation, semantic
   recall) may only WIDEN the candidate set feeding it. Precision is enforced
   by the canonical gates, never by dropping recall.
4. **Agent ecosystem observability — with evolved roles.**
   Amy/Anya/Sam/Hamilton/Robert/Yana actions must be visible to Sam
   diagnostics and usable by Anya; new automation ships with structured logs
   and result_meta counters. The agents' roles in the self-improvement loop
   (full charters: `docs/AGENTS.md`):
   - **Amy** closes coverage gaps and wins the Google-bar: every training/crawl
     task derives from the gap scoreboard, structural matrix, and web-parity
     gap queue; structural gaps become adapter-wishlist proposals; tuning is
     empirical KEEP/REVERT only.
   - **Sam** asserts the ratchets nightly: golden outcomes, gap-scoreboard
     freshness, web-parity non-regression, invariant sweep outcomes — and
     every finding carries a `recommended_fix`.
   - **Anya** is the owner's morning brief: what changed autonomously, the
     benchmark trend, top gaps and web-only finds awaiting judgment, and
     wishlist items needing owner decisions.
   - **Robert** grows the official-lane surface: discovered sources feed the
     lane registry and retire adapter-wishlist items.
5. **Paying-customer readiness.** Stripe billing tiers are live; features are
   tier-gated server-side (G8), flag-gated when new (default OFF in prod until
   proven), and reversible.

### G0. Truthful data, truthful proof, no fake shortcuts

Hard rules:
- **Do not fake funding.** User-facing catalogs, profile pipelines, crawler results, award histories, foundation traces, and application packets must never contain fabricated, placeholder, lorem, demo, dummy, or AI-invented funding sources presented as real.
- **Do not fake production proof.** A deterministic test, fixture, or offline routing check may prove code behavior, but it must be labeled as such. It must not be described as a live crawl, live award lookup, deployed health check, or production data verification unless it actually used that live path.
- **Do not blur release states.** A clean local tree, a pushed branch, green CI, current production health, and proof that a specific commit is deployed are separate claims. GrantFlow must label each one separately and must not imply a branch commit is live unless the deployment system verifies that exact commit.
- **Do not bypass guardrails to make a result look green.** Auth, admin checks, tenant/profile scoping, the reality gate, the canonical matcher, source verification, Hamilton hard stops, and release gates must not be skipped, weakened, or hidden to pass a demo or deadline.
- **Missing evidence is a gap, not a license to invent.** If a source, foundation grant list, portal, award amount, document field, profile answer, or live endpoint cannot be verified, GrantFlow must say so and either ask Anya/Hamilton/the admin for the missing proof or mark the item as unverified.
- **Mocks, fakes, and fixtures are allowed only inside tests and clearly labeled tooling.** They must never seed production, masquerade as crawler output, or be used as the sole basis for declaring a live workflow production-ready.
- **AI may summarize, classify, and draft from supplied facts; it may not invent facts, relationships, amounts, eligibility, deadlines, portal access, funder history, or prior contact.**
- **Grounding references must be real and labeled.** Retrieved text used for drafting (KB documents, the profile's own prior content, or real RePORTER awards via the comparable-awards lane) must come from a live/verified source and be presented as *reference context*, never as applicant facts. Comparable awards are OTHER applicants' awards: the drafting prompt labels them "REFERENCE ONLY — NOT APPLICANT FACTS", they are excluded from the applicant evidence pack, and the deterministic fabrication guard (`proposalFabricationGuard.js`) continues to treat the profile as the only source of applicant truth. Zero comparable awards renders an honest empty state — never placeholder examples.

### G1. Non-fragile, observable, and testable

- **No silent failures**: exceptions must be surfaced to the caller (API response / job status) with context.
- **Every critical behavior has a test**: unit/integration/E2E coverage is required for core flows.
- **Deterministic automation**: given identical inputs, mocked externals, and the same DB seed, automation results must be stable in CI.
- **Errors funnel through ONE choke point.** Route handlers must surface failures
  via `next(error)`, not by calling `res.status(500).json(formatError(e))` inline.
  The global `errorHandler` middleware (`backend/middleware/errorHandler.js`,
  mounted last in `server.js`) is the single place that (a) records the error for
  diagnostics via `recordRequestError` (so Sam / Mission Control can see it) and
  (b) classifies it. Do NOT re-implement status mapping per route.
- **Transient DB contention is retryable (503), not a 500.** A Postgres
  `statement_timeout` (SQLSTATE 57014) or pool-acquire timeout — e.g. a heavy
  `funding_opportunities` catalog scan colliding with a live crawl — is a
  capacity condition, not a server fault. `isRetryableDbError()` detects this and
  the choke point returns `503 { error: 'catalog_busy', retryable: true }`; the
  Discover UI retries with backoff. The ~12 heavy read routes that still
  `catch → res.status(500)` inline (discovery, opportunities, grants, robert,
  fundingTrace, …) should converge on `next(error)` so they inherit this.

### G2. Funding discovery must be useful (zero-results is a failure state)

This repo’s UX and automation pages present crawlers as a system that should populate the opportunity catalog.

Hard rule:
- **Zero results is a failure state** for discovery operations. If an operation evaluates candidates but includes none, the system must **log why items were removed** and then **relax constraints and/or re-score** rather than returning a silent empty set.

Approved recall-relaxation mechanisms (both ADDITIVE-ONLY — they may widen a
result set, never narrow it):
- **Threshold relaxation** (`RELAX_THRESHOLDS` → `FALLBACK_TOP_N` in `config/matchThresholds.js`).
- **Semantic recall** (`SEMANTIC_RECALL=1`, default OFF): embeds the profile
  thesis and ADDS the top-K nearest embedded catalog rows into the match
  routes' candidate scan *before* canonical scoring
  (`backend/services/embeddings/embeddingService.js`). Contract:
  - Embeddings NEVER accept, reject, filter, or override a deterministic
    verdict — every added candidate goes through the same
    `scoreOpportunity`/`computeMatchDecision` gates as a keyword candidate
    ("rules over score" holds).
  - The semantic query reuses the calling route's EXACT WHERE fragment
    (is_active + trusted origin/source + `profile_id IS NULL OR profile_id = ?`
    isolation + any state/deadline filters), so it can never cross profile
    isolation or widen the trust surface.
  - Keyword rows are structurally a prefix of the augmented candidate list —
    semantic recall can never produce an empty set where keyword matching had
    results.
  - Degrades to a clean no-op without `OPENAI_API_KEY`, without the
    `opportunity_embeddings` table, or with the flag off; responses carry an
    additive `semantic_recall { keyword_candidates, semantic_added }` counter
    and routes log keyword vs semantic vs accepted counts.

### G3. Crawl results must appear in the “Discover Grants / Funding Opportunities” UI

Hard rule:
- If crawlers insert opportunities into `funding_opportunities`, those opportunities **must be retrievable** via `GET /api/opportunities` and **must be count-visible** in the UI.

Hard rule (counts mapping):
- The UI’s “Showing X opportunities” must map **1:1** to backend response fields:
  - `GET /api/opportunities` returns `{ data, total, limit, offset }`
  - UI displays `total` when provided, otherwise `data.length`

### G4. Profile-driven behavior (avoid brittle boolean filtering)

Hard rules:
- **Missing profile fields must not disqualify** a funding source by default. Missing fields are neutral.
- **Profile attributes increase score, not eliminate results** by default.
- **Exact-match requirements are forbidden** unless legally required.
- **Population/eligibility mismatches reduce score, not discard results** (unless the opportunity is explicitly exclusive).
- **Hard AND filters must be avoided** unless the funding source is explicitly exclusive.

Geographic matching rule:
- Matching expands outward: **city → county → state → national** (never only “exact ZIP” unless explicitly exclusive).

Directory-style resources rule:
- Directory-style or general funding resources (broad “where to find grants” sources) must survive filtering unless explicitly excluded.

### G5. Compliance (“grant funds only”) is a presentation/triage layer, not data loss

Current code supports a “Funding terms” filter in UI (`src/pages/FundingOpportunities.jsx`) backed by `GET /api/opportunities?compliance=...`.

Hard rules:
- Compliance classification must be **computed and explainable** (`compliance_status`, `compliance_reasons`), never silently applied.
- **Default behavior must not hide all opportunities**. If applying compliance filtering would produce zero results while opportunities exist, the response must include:
  - a reason summary explaining removals, and/or
  - a relaxed mode suggestion (or automatic fallback) that still returns some opportunities.

Assumption (pending confirmation):
- “Grant funds only” is the default view, but “review-required” opportunities should remain available via a filter toggle without being deleted/ignored in storage.

### G6. Automation job invariants

Hard rules:
- Every `crawler_jobs` run must end in one of: `completed`, `failed`, `cancelled`.
- A completed job must store:
  - `result_count` (inserted or processed count)
  - `result_meta` (JSON) with at least `duration_seconds` and relevant counters (e.g., `evaluated`, `inserted`)
- Failures must store a non-empty `error` and should store a structured `result_meta.error`.

### G7. Geo crawler (nationwide ZIP coverage) must persist REAL sources (≥ 3 per ZIP)

The UI and docs claim “Nationwide crawl… at least three grants per ZIP” (see `src/pages/Automation.jsx` and `src/pages/FundingOpportunities.jsx`).

Hard rules:
- Maintain a durable `geo_funding_sources`-style table keyed by ZIP.
- For each ZIP, persist **≥ 3 verified sources**, or the ZIP job remains incomplete and retries later.
- “REAL” means:
  - URL is valid and non-placeholder
  - URL is reachable (polite rate limiting, timeouts)
  - The source appears to be a funding/grants entity (heuristics + allow/deny list)
  - De-duplicate by normalized domain + name
- Must respect robots.txt and terms; prefer official/public datasets or directories.
- The nationwide crawl must be **incremental and resumable** (checkpointed).

### G8. Security, RBAC, and secrets handling

Hard rules:
- Secrets live in env vars; no keys in code.
- Admin access must be enforced server-side; UI-only protection is insufficient.
- Auth/session tokens handled securely; avoid leaking across accounts.

## INVARIANTS — enforce at a choke point, never trust per-call discipline

> **This table is stale relative to the live enforcer.** `backend/startup/enforceInvariants.js`
> has grown far beyond the ~11 rows below — CLAUDE.md's "INVARIANTS" section documents
> 50+ enforced invariants added through 2026-08-03, each with its own row in that file's
> table. This section was not kept in lockstep as new invariants shipped (a two-source-of-truth
> drift the rest of this doc explicitly warns against — see "MIGRATION PARITY" in CLAUDE.md).
> Treat the table below as a partial, dated snapshot of the *pattern*, and read CLAUDE.md's
> INVARIANTS table for the current, complete list.

**Why this section exists:** The same class of bug kept recurring because a
canonical rule above was enforced only by *convention* ("remember to check the
tombstone in every insert path", "remember to scope by `profile_id`
everywhere"). Every new code path that forgot the check re-introduced the
violation (deleted grants reappearing, cross-profile bleed, junk piling up).

**The standing rule for ALL future changes (humans and agents):** Do not rely
on remembering to do the right thing in each call site. A machine-checkable
product rule MUST be re-asserted in ONE place against the live DB so it holds
regardless of which path created the data. The per-call gate (e.g. a DISMISSED
check before insert) is the first line of defense; the boot sweep is the net.
When you add or change behavior that touches one of these invariants, you change
the single enforcer + its test — you do NOT scatter new ad-hoc checks.

The canonical enforcer is **`backend/startup/enforceInvariants.js`**, run on
every boot from `backend/server.js` immediately after `ensureSchemaInvariants()`.
The full `runSelfHeal()` orchestrator in `backend/startup/selfHeal.js` also calls
it as step 9 for Sam/Anya on-demand and maintenance runs, but boot wires the
invariant sweep directly so it cannot be skipped by self-heal schedule changes.
It mirrors `backend/startup/ensureSchemaInvariants.js`:
each invariant is its own guarded, idempotent, dialect-agnostic step that detects
violations, repairs/quarantines them, and logs a structured summary. Schema-shape
DDL stays in `ensureSchemaInvariants.js`; data-repair invariants go here.

| Invariant (rule above) | Single enforcer (one function) | Test that guards it |
| --- | --- | --- |
| **Sticky deletes** — a source a user deleted from a profile pipeline stays gone | `reconcileDismissedGrants()` in `backend/services/pipelineDismissals.js`, re-run by `enforceStickyDeletes()` | `backend/tests/enforceInvariants.test.js` ("sticky deletes") |
| **No cross-profile / cross-tenant bleed** (G4, G8) — a grant's `organization_id` must equal its `profile_id`'s org | `enforceNoCrossProfileBleed()` (re-aligns to the profile's org; profile_id is the authoritative tenancy signal) | `backend/tests/enforceInvariants.test.js` ("no cross-profile / cross-tenant bleed") |
| **Relevance / match-score floor** (G4 + prune playbook) — pipeline must not accumulate junk (`match_score < 5` on the data-point scale, excl. NULL) | `enforceRelevanceFloor()` (never touches NULL scores or protected statuses; `ENFORCE_RELEVANCE_FLOOR=0` for count-only) | `backend/tests/enforceInvariants.test.js` ("relevance floor") |
| **Every pipeline grant carries a match score when computable** — an unscored (NULL) row must not masquerade as an engine-endorsed match (the Eileen-Fisher-on-a-church class) | `enforceGrantScoreBackfill()` (canonical re-score of NULL-score rows, bounded per boot; `ENFORCE_GRANT_SCORE_BACKFILL=0` for count-only). UI first line: "Not scored" badge on NULL-score cards | `backend/tests/enforceInvariants.test.js` ("runner") |
| **Every live-qualified stored match converges into the real profile pipeline, and every non-admission has a durable reason** (G2 anti-zero-result) | `runQualifiedPipelinePromotion()` scans all non-terminal `profile_opportunity_matches` without stored-score/decision prefilters, then calls the sole public saver `saveToProfilePipeline` for a fresh canonical rescore + all retained gates. Outcomes are fingerprinted and re-open on profile/policy/opportunity drift; tombstones fail closed in the sweep; Amy markers exclude by OR; the job ALWAYS runs live — the count-only rollout switch `ENFORCE_QUALIFIED_PROMOTION` is removed outright (owner order 2026-08-13, no dry runs) and naming it fails the run | `backend/tests/pipelinePromotion.test.js` |
| **No search-engine application targets** (G6 "URL is valid and non-placeholder") — a search-engine RESULTS url (google.com/search?q=…, bing.com/search, …) is never a portal/application target on `application_tasks`, `funding_opportunities`, or `grants` | `enforceNoSearchEngineApplicationTargets()` (nulls the URL, reclassifies non-terminal tasks to blocked/unknown_application_method; bounded + idempotent; disable via `ENFORCE_URL_HYGIENE=0`). Producers gated at `opportunityInserter.upsertFundingOpportunity` + `hamiltonAutomationClassifier.readUrl` via the canonical `isSearchEngineUrl()` (urlRules.js) | `backend/tests/enforceInvariants.test.js` ("enforceNoSearchEngineApplicationTargets") |
| **Status provenance honesty** (G0 truthful data) — a protected `submitted` status means a human/Hamilton actually submitted; bulk imports stamped rows `submitted` from the SOURCE's own listing status (grants.gov "(posted)") with `submitted_date` NULL, permanently shielding never-scored, often-ineligible rows from every purge/re-score net (the HUD Section 4 $42M class) | `enforceImportedStatusHonesty()` — surgical demote to `discovered` ONLY when status `submitted` + `submitted_date IS NULL` + import/repair provenance (adapter "(posted)" notes or `admin_schema_repair` explanation) all hold; real submissions and human-noted rows are never touched; `ENFORCE_STATUS_PROVENANCE=0` for count-only | `backend/tests/enforceInvariants.test.js` ("enforceImportedStatusHonesty") |
| **Award-amount acquisition** (G2 useful discovery; G0 no-invented-data) — when an active-pipeline source carries no dollar figure but the funder's OWN page states one, GrantFlow reads the page instead of leaving the row blank (only ~18% of the catalog carried amounts; most pipelines honestly summed to $0). Write-side guards: untrusted-source structured amounts outside the $100–$10M plausibility window demote to TEXT (`resolveOpportunityAmounts` — a $42M program appropriation is not a per-award ceiling; boot net: `enforceGrantAmountBackfill` step 0 strips fabricated numerics already persisted and cleans grant values inherited from them, never touching user-entered asks or awarded money), and floor→ceiling ranges wider than `WIDE_AWARD_RANGE_RATIO` (10×) default `amount_requested` from the FLOOR | `enforceAmountEnrichment()` — bounded per boot (`AMOUNT_ENRICH_BOOT_LIMIT` 10, `AMOUNT_ENRICH_TIME_BUDGET_MS` 20s); SSRF-safe crawler-os fetcher + conservative `awardAmountExtractor` (per-award phrasings only; program totals stay text-only; an explicit tuition-coverage award — "pays tuition", "covers 100% of tuition and fees" — yields status `varies` + the phrase as text, never a number: the NM Lottery/Opportunity class, 2026-08-03); attempted ids in `system_kv`; `ENFORCE_AMOUNT_ENRICHMENT=0` for count-only. Service: `backend/services/amountEnrichment.js` | `backend/tests/enforceInvariants.test.js` ("enforceAmountEnrichment") + `backend/tests/amountEnrichment.test.js` |
| **A pipeline grant is LINKED to its catalog row when one plainly exists** (G2 useful discovery; the #954 census blind spot, 2026-07-17) — the amount nets reach a grant ONLY through `funding_opportunity_id`, so an unlinked grant is structurally invisible to enrichment and backfill and reads as `unanswered_no_catalog_row` (82 of 313 active rows in prod). The crawler often wrote the grant AND its catalog twin from one result but omitted the link; a shared URL is a canonical-dedup-identity tier, so grant + active catalog row at the same url are the same opportunity | `enforceGrantCatalogLink()` (`backend/startup/enforceInvariants.js`), run BEFORE `enforceAmountEnrichment` so a link is enriched the same boot. Links ONLY on URL identity (normalized) + EXACTLY ONE active match (2+ = ambiguous, never guessed) + NO profile conflict (a URL coincidence must not cross a pipeline — G4/G8); NULL→value only; bounded (`GRANT_CATALOG_LINK_LIMIT`); `ENFORCE_GRANT_CATALOG_LINK=0` for count-only. Reference only `source_url`/`application_url`/`evidence_url` (prod has a bare `url` the SQLite schema lacks — the schema-drift trap) | `backend/tests/enforceInvariants.test.js` ("enforceGrantCatalogLink") |
| **"No amount" and "no amount PUBLISHED" are different facts** (G0 no-invented-data; owner rule 2026-07-17) — only a READ can tell them apart, and until now the read's answer was discarded. `not_listed` is the extractor's DEFAULT: it means *nobody found a figure*, i.e. SILENCE, and it may never license a claim about the funder. `none_published` is the DENIAL: the funder's own page/API was actually read and states no per-award figure. Recording it is EVIDENCE (read, never invented); a `thin_page`/4xx is NOT a denial (we learned we cannot READ the source, not that it pays nothing — those rows need an adapter and must stay visible). **Consequence for health checks: a metric must measure US, not THE WORLD.** `pipeline.amountCoverage` failed nightly on a `pct < 60` bar, but coverage is capped by what share of funders publish figures at all (honest ceiling ~21%; prod 2026-07-17 `remaining=2 / exhausted=132` — the backlog was DRAINED). It now asserts every active row has an ANSWER — a value, an evidenced `none_published`, an honest label, or DIRECTORY-by-design — and fails on rows it cannot explain, grouped by why. Amy's `amount_recall_miss` uses the same rule, which is what makes the owner's "50/50 clean" flywheel goal reachable at all | `AMOUNT_STATUS_NONE_PUBLISHED` (`services/awardAmountExtractor.js`), written ONLY by `enforceAmountEnrichment` on `page_read && !found` — never by an extractor default or an ingest. `pipeline.amountCoverage` (`services/sam/samRegistry.js`) + `AMOUNT_UNKNOWABLE_STATUSES` (`services/amy/amyReport.js`). Un-burn: migrations 141/0145 | `backend/tests/pipelineAmountCoverageRatchet.test.js` ("A WIPED row still counts as a MISS") + `backend/tests/enforceInvariants.test.js` ("RECORDS the denial" / "does NOT record a denial when the page could not be READ") + `backend/tests/amyAgent.test.js` |
| **Admins are never re-interviewed** (owner-directed, 2026-07-06) — an ADMIN/owner account is interviewed by Anya at most once; a secondary login must never re-open the interview, regardless of `pending_reinterview` bulk-reset backfills. Non-admin users keep the deliberate reset flow | `enforceAdminReinterviewSuppression()` — resolves `users.guided_cycle_tour_status = 'pending_reinterview'` to `'completed'` for admin rows that already had their first-run (`has_completed_onboarding`, `onboarding_completed_at`, or any prior `last_login_at`); a genuinely fresh admin keeps their one first-run. Per-call first line: `resolveGuidedCycleTourStatus()` (`backend/services/onboardingGates.js`) at every auth-payload serialization (`buildUserPayload`, `GET /api/auth/me`, `PATCH /api/auth/onboarding-state`); UI belt-and-suspenders: the global `LoginGapInterviewLauncher` mount never interviews an admin (only the sequenced ResetOnboardingFlow pass may) | `backend/tests/adminReinterviewGate.test.js` + `backend/tests/enforceInvariants.test.js` ("runner") |
| **Amy synthetic profiles expire** (owner-directed, 2026-07-06 — "make sure those profiles are getting deleted afterwards") — a synthetic crawler-training profile (`created_by='agent:amy'`, metadata `synthetic:true` + `allow_sam_cleanup:true`) past its `expires_at` never outlives the next boot. Amy's end-of-run cleanup is scoped to the ids crawled in THAT run (`onlyIds`), so a run whose discovery skipped/threw deleted NOTHING and leftovers from prior runs were permanently out of scope (prod: 13 live synthetics, lifetime reap count 0) | `enforceAmySyntheticExpiry()` — delegates to the canonical `cleanupExpiredAmyProfiles()` (`backend/services/amy/amyProfileStore.js`), the same guarded sweep used by the unscoped expired-only pass at the end of every `runAmyTraining` (telemetry event `amy.cleanup.expired_sweep`) and the nightly maintenance sweep; guards never weakened: non-Amy rows never scanned, designated profiles never touched, `allow_sam_cleanup`/`synthetic` required, never-crawled rows reaped only far past TTL (`AMY_NEVER_CRAWLED_MAX_AGE_HOURS`, default 96h), 6h crawled grace for mid-flight runs; `ENFORCE_AMY_SYNTHETIC_EXPIRY=0` for count-only | `backend/tests/enforceInvariants.test.js` ("enforceAmySyntheticExpiry") + `backend/tests/amyAgent.test.js` |
| **Application-URL rescue** (G0 no-invented-data + G2 anti-zero-result) — a real candidate rejected ONLY for a missing URL (stage `url`, reason `missing_application_url`; docs/email/LLM extracts with title+sponsor but no link) gets ONE bounded, budget-paced chance to be rescued with a real, LIVENESS-VERIFIED page found by searching its own title+sponsor; a URL is never invented, guessed, or synthesized, and a search-provider outage never burns a candidate's one chance | `enforceApplicationUrlRescue()` (re-drives the rejection's `raw_meta.candidate` snapshot through the FULL `upsertFundingOpportunity` gate stack with the found URL; `system_kv` cursor `url_rescue_last_rejection_id` gives each rejection exactly one attempt and is NOT advanced when every search in a run came back empty/failed; bounds: `URL_RESCUE_BOOT_LIMIT` default 8, `URL_RESCUE_TIME_BUDGET_MS` default 20000; `ENFORCE_URL_RESCUE=0` for count-only). Finder: `findOfficialUrlForOpportunity()` (`backend/services/urlEnrichment.js`: searchWeb → token-overlap plausibility → `checkUrl` probe); write-side first line: the url-gate `logRejection` in `opportunityInserter.js` persists the reconstructable candidate snapshot | `backend/tests/enforceInvariants.test.js` ("enforceApplicationUrlRescue") + `backend/tests/urlEnrichment.test.js` |

**Guardrails baked into the enforcer (do not weaken):**
- NULL `match_score` is NEVER junk (G4 "missing fields are neutral").
- Grants in `PROTECTED_PIPELINE_STATUSES` (submitted/awarded/drafting/… + legacy) are NEVER auto-purged — that is user work (Mission Goal #10).
- `reality_status='downgraded'` / `link_unverified` means "URL not yet pinged", NOT "dead" — never delete on that signal (G2/G5).
- Tombstone matching and every comparison are profile-scoped so one profile can never delete another's data.

**Invariants documented but NOT yet auto-enforced (TODO — add a step + test before relying on convention):**
- **Source allowlist / denylist** — blocklist currently matches 0 grant funders in prod; auto-purge needs a confirmed funder→blocklist match rule before it's safe to delete on.
- **Zero-result-but-no-junk** (G2) — "relax constraints and re-score on empty" is a request-time behavior, not a stored-state invariant; can't be reconciled by a boot sweep.
- **Agent observability rule** — any change in an agent's scope must be visible to Sam (diagnostics) + usable by Anya; this is a wiring/process rule, enforced in review, not by a DB sweep.

**Nightly ratchets (asserted by Sam checks, not boot sweeps):** the
self-improvement loop's guarantees — golden-outcome expectations
(`coverage.goldenOutcomes`), gap-scoreboard freshness
(`coverage.gapScoreboard`), and web-parity non-regression
(`coverage.webParityBenchmark`) — are LIVE-state assertions over `system_kv`
stores, so they run in Sam's nightly sweep rather than the boot enforcer. The
same standing rule applies: one canonical check each, never per-call
discipline, and a ratchet regression is a red finding, never a silent trend.

## Feature flags for recall/grounding/critic lanes (all default OFF; reversible)

| Flag | Feature | Off-state behavior |
| --- | --- | --- |
| `SEMANTIC_RECALL=1` (+ `SEMANTIC_RECALL_TOP_K`, `SEMANTIC_RECALL_SCAN_LIMIT`, `EMBEDDING_MODEL`) | Semantic recall booster on `/api/ai/match` + `/api/ai/comprehensive-match`; lazy embeds on `upsertFundingOpportunity`; backfill via `backend/scripts/backfill-opportunity-embeddings.mjs` | Pure keyword path, zero embedding calls |
| `COMPARABLE_AWARDS=1` | `GET /api/ai/comparable-awards` (real NIH RePORTER awards, reference-only) + comparable-awards block in Hamilton proposal prompts | Endpoint answers `{ enabled:false, data:[] }`; UI panel explains; prompts omit the block |
| `PROPOSAL_CRITIC=1` | `POST /api/ai/proposal-critic` multi-pass critic (compliance + evidence consistency + deterministic fabrication scan) behind the AI Grant Scorer | Endpoint answers `{ enabled:false }`; scorer UI unchanged |

All three degrade cleanly without `OPENAI_API_KEY` (no-op / honest
"unavailable" — never invented output). Schema shape for
`opportunity_embeddings` is re-asserted at the boot choke point
(`ensureSchemaInvariants.js` → `opportunity_embeddings_table` step; migrations
131 / pg 0135, pgvector optional + guarded).

## Known gaps / TODOs (must become hard rules once implemented)

- Standardized crawler output schema: `{ raw, normalized, score_0_1, explain, provenance }`
  - **Page-fact provenance storage (Phase 0.1, LAID — extractor not yet built).**
    `funding_opportunities` carries additive, NULL-default columns
    `eligibility_text`, `eligibility_bullets` (pre-existing), `page_fact_schema_version`,
    and `field_provenance` (JSON `{ field: { value, evidence_snippet, source } }`).
    Migration `144` / pg `0148` (guarded numbered migration, NOT `ensureOsTables`).
    The OS opportunity shape (`contract.makeOpportunity`) carries the fields;
    `storage.upsertOpportunity`, `osOppToLiveRow`, and the `crawler-os/matchEngine`
    facade thread them through so they round-trip write→read. **Nothing populates
    them yet — they default null and change no matching / scoring / behavior.** The
    tri-state for `is_loan` / `requires_match` / `is_national` lives in
    `field_provenance`: an ABSENT key means "not stated", distinct from the boolean
    columns' coalesced false (which existing consumers keep reading unchanged). A
    later profile-blind extractor is the consumer that will fill these.
- Deterministic pipeline runner: every crawler × every profile, persist results with score > 0.50
- Stripe end-to-end billing contract and idempotent webhook handling
