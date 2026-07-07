# GrantFlow Agents — Missions, Inputs, Outputs, and the Self-Improvement Loop

_One page. Doctrine and hard separations live in
[AGENT_AUTOMATION_CHARTER.md](./AGENT_AUTOMATION_CHARTER.md); the
owner-ratified product thesis and the measured Google-bar live in
[canonical_rules.md](./canonical_rules.md) ("The product thesis"). Where this
page and a per-agent doc disagree on ROLE, this page and the charter win._

Last reviewed: 2026-07-07 · Owner/admin: `buckeye7066@gmail.com`

## The loop (in prose)

The system is wired to only get better:

1. **Verify → golden expectation → sentinel.** The owner verifies a result
   live ("this profile really should find X") → it is appended as a permanent
   expectation (data, not code) → Sam's nightly `coverage.goldenOutcomes`
   check asserts it forever after.
2. **Gap → Amy task → lane/coverage.** The Coverage & Evidence dashboard folds
   every real profile's misses into the gap scoreboard (`system_kv`
   `coverage_gap_scoreboard`) → Amy derives her next training/crawl tasks from
   it (never at random) → fixable gaps become coverage/query-steering changes;
   structural gaps become adapter-wishlist items awaiting a new lane.
3. **Benchmark → parity ratchet.** The web-parity benchmark (`system_kv`
   `web_parity_benchmark`) replays each golden profile against a competent
   30-minute web-search session → Sam's `coverage.webParityBenchmark` check
   enforces no regression → failures land in `system_kv`
   `web_parity_gap_queue` and feed step 2.
4. **Tune → KEEP/REVERT.** Amy's tuning changes apply only when proven on a
   big-enough cohort, bounded, backed up, and auto-reverted on mismatch.
5. **Anya reports it all** to the owner each morning; owner judgments (verify
   a find, approve a wishlist item) re-enter at step 1.

No ratchet may regress without a red finding. Every owner-verified outcome
becomes a golden expectation. Every benchmark failure becomes queued work.

## Amy — coverage-gap closer (synthetic crawler training)

- **Mission:** close coverage gaps and win the Google-bar. Derive every
  training/crawl task from the gap scoreboard, the structural matrix, and the
  web-parity gap queue; propose adapter-wishlist items for gaps she cannot
  fix; tune empirically with KEEP/REVERT.
- **Inputs:** `system_kv` `coverage_gap_scoreboard` (+ structural matrix),
  `system_kv` `web_parity_gap_queue`, `system_kv` `amy_archetype_learning` /
  `amy_archetype_metrics`, the live discovery seam `runProfileDiscoveryLive`.
- **Outputs:** weighted synthetic cohorts and measured crawl runs; bounded,
  reversible tuning (floor/weights, backed up, auto-revert); learned
  query-steering per archetype; adapter-wishlist telemetry
  (`amy.adapter_wishlist`); handoff reports to Anya (root cause) → Sam
  (verified safe fixes); run reports in the Agent Amy admin panel.
- **Never:** writes adapter code, loosens a display floor, keeps a synthetic
  profile past its TTL, or picks tasks at random.
- Doc: [AMY_AGENT.md](./AMY_AGENT.md) · Code: `backend/services/amy/`

## Sam — ratchet keeper (production readiness)

- **Mission:** assert the ratchets nightly — golden outcomes, gap-scoreboard
  freshness, web-parity non-regression, and invariant sweep outcomes — on top
  of the existing diagnostics/gates. Every finding carries a
  `recommended_fix`.
- **Inputs:** the `samRegistry.js` check registry (incl.
  `coverage.gapScoreboard`, `coverage.goldenOutcomes`,
  `coverage.webParityBenchmark`), production-gate scripts, agent telemetry,
  `enforceInvariants` sweep results.
- **Outputs:** `sam_runs` / `sam_findings` rows (each finding severity-ranked
  with a `recommended_fix`), owner email reports, critical escalations,
  gated safe fixes (`repair-safe` mode only).
- **Never:** claims a check passed that didn't run, touches matching/scoring/
  payments/auth code, or lets a ratchet regress without a red finding.
- Docs: [SAM_PRODUCTION_AGENT.md](./SAM_PRODUCTION_AGENT.md),
  [SAM_AGENT_AUDITOR.md](./SAM_AGENT_AUDITOR.md) · Code: `backend/services/sam/`

## Anya — the owner's morning brief (and in-app guide)

- **Mission:** for users, the in-app guide who can explain GrantFlow's case
  over a Google search (the four pillars) and act on the profile. For the
  owner: the morning brief — what changed autonomously overnight, the
  benchmark trend, the top gaps, web-only finds awaiting judgment, and
  wishlist items needing an owner decision.
- **Inputs:** the live profile + page context, agent telemetry and run
  reports (Amy/Sam/Robert/Hamilton/John/Yana), the gap scoreboard, benchmark
  results, Sam findings.
- **Outputs:** conversational guidance + tool actions (profile edits, match
  summaries, owner merges), the daily owner report
  (`backend/services/anya/anyaDailyOwnerReport.js`), root-cause code crawls on
  Amy's flagged files.
- **Never:** fabricates results, claims a tool ran when it didn't, or buries
  an owner decision (wishlist/verification) instead of surfacing it.
- Docs: [ANYA_SETUP_GUIDE.md](./ANYA_SETUP_GUIDE.md) · Code:
  `backend/services/anyaOrchestrator.js`, `backend/services/anya/`

## Robert — lane grower (funding discovery)

- **Mission:** grow pillar 2's surface — find real official sources and
  opportunities on the public internet and push them through the canonical
  gates. Discovered sources feed the lane registry; a shipped lane retires
  its adapter-wishlist item.
- **Inputs:** profile coverage analysis, the adapter wishlist / structural
  gaps (as search demand), his source registry, email feeds.
- **Outputs:** verified source candidates, canonical-ingested opportunities,
  per-profile recommendations (toast-only; never mutates a pipeline without a
  user click).
- **Never:** invents scoring (delegates to the canonical matcher), bypasses
  ingestion gates, or writes code.
- Doc: [ROBERT_FUNDING_DISCOVERY_AGENT.md](./ROBERT_FUNDING_DISCOVERY_AGENT.md)
  · Code: `backend/services/robert/`

## The others (pillar 3 — "it acts")

- **Hamilton** completes applications (live portal automation; hard stops per
  charter §3) — [HAMILTON_APPLICATION_AGENT.md](./HAMILTON_APPLICATION_AGENT.md).
- **Yana** discovers prospective clients; **John** drafts (never sends)
  outreach — [YANA_LEAD_PIPELINE_AGENT.md](./YANA_LEAD_PIPELINE_AGENT.md),
  [JOHN_OUTREACH_AGENT.md](./JOHN_OUTREACH_AGENT.md).

Their run telemetry is part of Anya's morning brief and Sam's sweep like every
other agent's (Agent Observability Rule).
