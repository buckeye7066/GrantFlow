# GrantFlow Canonical Rules & Goals

_Last updated: 2026-07-05_

This document is the **single source of truth** for GrantFlow’s product rules, correctness invariants, and acceptance criteria.

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

### Evolved product goals (2026-07)

The G-rules below remain binding, but the product has evolved past
"discovery catalog + pipeline" — every new feature should also serve these
evolved goals:

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
4. **Agent ecosystem observability.** Amy/Anya/Sam/Hamilton/Robert/Yana
   actions must be visible to Sam diagnostics and usable by Anya; new
   automation ships with structured logs and result_meta counters.
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
| **An active profile with above-bar stored matches never shows a near-empty pipeline** (G2 anti-zero-result, the purge-then-refill gap) | `enforcePipelineRefill()` (promotes top `profile_opportunity_matches ≥ AUTO_ADD_SCORE` through the fully-gated `saveToProfilePipeline` — tombstones/source gate/dupe guard enforced; re-scored at promote time; `ENFORCE_PIPELINE_REFILL=0` for count-only; `PIPELINE_REFILL_MIN_ROWS` default 5) | `backend/tests/enforceInvariants.test.js` ("runner") |
| **No search-engine application targets** (G6 "URL is valid and non-placeholder") — a search-engine RESULTS url (google.com/search?q=…, bing.com/search, …) is never a portal/application target on `application_tasks`, `funding_opportunities`, or `grants` | `enforceNoSearchEngineApplicationTargets()` (nulls the URL, reclassifies non-terminal tasks to blocked/unknown_application_method; bounded + idempotent; disable via `ENFORCE_URL_HYGIENE=0`). Producers gated at `opportunityInserter.upsertFundingOpportunity` + `hamiltonAutomationClassifier.readUrl` via the canonical `isSearchEngineUrl()` (urlRules.js) | `backend/tests/enforceInvariants.test.js` ("enforceNoSearchEngineApplicationTargets") |
| **Status provenance honesty** (G0 truthful data) — a protected `submitted` status means a human/Hamilton actually submitted; bulk imports stamped rows `submitted` from the SOURCE's own listing status (grants.gov "(posted)") with `submitted_date` NULL, permanently shielding never-scored, often-ineligible rows from every purge/re-score net (the HUD Section 4 $42M class) | `enforceImportedStatusHonesty()` — surgical demote to `discovered` ONLY when status `submitted` + `submitted_date IS NULL` + import/repair provenance (adapter "(posted)" notes or `admin_schema_repair` explanation) all hold; real submissions and human-noted rows are never touched; `ENFORCE_STATUS_PROVENANCE=0` for count-only | `backend/tests/enforceInvariants.test.js` ("enforceImportedStatusHonesty") |
| **Award-amount acquisition** (G2 useful discovery; G0 no-invented-data) — when an active-pipeline source carries no dollar figure but the funder's OWN page states one, GrantFlow reads the page instead of leaving the row blank (only ~18% of the catalog carried amounts; most pipelines honestly summed to $0). Write-side guards: untrusted-source structured amounts outside the $100–$10M plausibility window demote to TEXT (`resolveOpportunityAmounts` — a $42M program appropriation is not a per-award ceiling; boot net: `enforceGrantAmountBackfill` step 0 strips fabricated numerics already persisted and cleans grant values inherited from them, never touching user-entered asks or awarded money), and floor→ceiling ranges wider than `WIDE_AWARD_RANGE_RATIO` (10×) default `amount_requested` from the FLOOR | `enforceAmountEnrichment()` — bounded per boot (`AMOUNT_ENRICH_BOOT_LIMIT` 10, `AMOUNT_ENRICH_TIME_BUDGET_MS` 20s); SSRF-safe crawler-os fetcher + conservative `awardAmountExtractor` (per-award phrasings only; program totals stay text-only); attempted ids in `system_kv`; `ENFORCE_AMOUNT_ENRICHMENT=0` for count-only. Service: `backend/services/amountEnrichment.js` | `backend/tests/enforceInvariants.test.js` ("enforceAmountEnrichment") + `backend/tests/amountEnrichment.test.js` |
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
- Deterministic pipeline runner: every crawler × every profile, persist results with score > 0.50
- Stripe end-to-end billing contract and idempotent webhook handling
