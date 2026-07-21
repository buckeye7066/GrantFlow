# EVA — End-user Validation Agent: Implementation Report

**Date:** 2026-07-21 · **Branch:** `claude/eva-user-journey-qa` (GrantFlow) ·
**Status:** coordinator + edge runner + Anya integration built, tested, and
verified end-to-end on isolated branches. Nothing merged, deployed, or sent.

## What was built

A two-layer, evidence-driven functional-testing system that proves whether a real
person can use each program in the 19-surface portfolio, wired into Anya's existing
morning owner email — alongside (never replacing) Sam's code sweep.

- **Sam** inspects code/config/routes/security. **EVA** proves a person can use the
  app. **Anya** merges both into one 09:00 ET email.
- **Architecture decision:** EVA is a **dedicated agent** (`eva` in
  `AGENT_NAMES`), not a Sam lane — different runtime (owner's Windows box vs.
  cloud), different trust boundary (untrusted signed uploads vs. in-process), and
  independent report streams. Rationale in `docs/EVA_PORTFOLIO_QA.md`.

## Repositories changed

| Repo | Branch | Change |
| --- | --- | --- |
| **GrantFlow** (`~/GrantFlow`) | `claude/eva-user-journey-qa` | The whole coordinator, edge runner, manifests, migrations, tests, docs, and the Anya email integration. |

All 19 portfolio surfaces were **resolved to a real repo/runtime** (not inferred
from a shortcut label). Manifests live centrally at `qa/manifests/*.json` (the
authoritative bundle, version-controlled and totality-tested); GrantFlow's own copy
is also at `qa/user-journeys.json`. Per-repo placement of the other 18 manifests is
a mechanical one-file follow-up per repo (each on a `claude/eva-user-journey-qa`
branch); the runner already loads the bundle via `EVA_MANIFEST_DIR`, so nothing is
blocked on it.

### Files added (GrantFlow)

- **Coordinator services:** `backend/services/eva/{evaTypes,evaRegistry,evaIngest,evaRunStore,evaSummary,evaReportSection,evaScheduler,evaTelemetry}.js`
- **Route:** `backend/routes/adminPortfolioQa.js` (signed ingest/heartbeat + admin reads)
- **Migrations:** `backend/db/migrations/151_eva_portfolio_qa.sql`, `backend/db/postgres/migrations/0155_eva_portfolio_qa.sql`, + `backend/db/schema.sql` mirror
- **Registry + contract:** `qa/portfolio-registry.json`, `qa/eva-result.schema.json`, `qa/manifests/*.json` (19), `qa/user-journeys.json`, `qa/FEATURE_COVERAGE_MATRIX.md`, `qa/build-coverage-matrix.mjs`
- **Edge runner:** `tools/eva-edge-runner/` (bin, src, adapters, fixtures, tests)
- **Tests:** `backend/tests/eva{Types,Ingest,RunStore,OwnerReport,Registry,ManifestTotality}.test.js`, `backend/tests/evaTestDb.js`
- **Docs:** `docs/EVA_PORTFOLIO_QA.md`, `docs/EVA_WINDOWS_RUNNER.md`, this report, `docs/eva-sample-email.{html,txt}`

### Files modified (GrantFlow)

- `backend/services/anya/anyaDailyOwnerReport.js` — `defaultLoadEvaPortfolioQa` +
  `summarizeEvaPortfolioQa` (exported), EVA support in `buildOwnerReport`, EVA
  loading in `runAnyaDailyOwnerReport`, subject reflects both streams. Existing
  behavior preserved (all 20 pre-existing tests still pass).
- `backend/services/agentTelemetry/agentTelemetryTypes.js` — registered `eva` in
  `AGENT_NAMES`/`AGENT_LABELS`/`AGENT_TAGLINES` (else telemetry silently no-ops).
- `backend/server.js` — mounted signed ingest (raw-body, before JSON parser),
  admin reads (normal block), and the hourly EVA maintenance sweep.

## Portfolio resolution (all 19)

Every surface resolved to a real runtime. **Four assumptions were corrected by
reading the actual repos** — the exact "a shortcut is only a pointer" discipline
the task demanded:

- **Free and Clean** — canonical app is at `G:/One Drive/Desktop/Free and Clean`
  (Python `system_cleaner/cleaner.py`), **not** the stale `C:/FreeAndClean-v3.0`
  PowerShell-GUI copy.
- **FlexFactor / Scout a Program** — a single-file **Python CLI**
  (`python flexfactor.py`), **not** web apps; Scout is the argparse subcommand
  `flexfactor.py scout`, not an env-var mode.
- **CRISPR Compass** — a **Streamlit** app (`:8501`), not Vite/React.
- **Kidney Antigen Discovery** — FastAPI (`/api` prefix) + Next.js 14, confirmed.

Truthful runtime states are recorded in `qa/portfolio-registry.json`
(`available` / `blocked_by_external_service`). **Factory Deck** is
`blocked_by_external_service` (Anthropic credits empty) — its manifest declares
only a launch-smoke + Demo-stub journey (no real model call).

## Journeys & coverage

- **19 manifests**, **41 journeys**, **111 features catalogued** (feature coverage
  matrix: `qa/FEATURE_COVERAGE_MATRIX.md`). Every feature maps to a journey or an
  explicit `unautomated_reason` — enforced by `validateManifest` + the totality
  test.
- Web journeys assert **semantic** correctness (visible text / value / URL), record
  console errors and 5xx as findings, and capture screenshot/console/network on
  failure. CLI/Python/PowerShell journeys run read-only invocations
  (`--help`/`health`/dry-run) under a strict process allowlist, against throwaway
  fixture dirs.
- Nightly = each app's `nightly_critical_journeys` (launch smoke + a primary
  journey); weekly = the full set. Electron/api adapters are declared and route to
  a `blocked` "adapter harness pending" result — never a fabricated pass.

## Safety (every per-app prohibition encoded)

Each manifest carries a non-empty `prohibited_actions` policy and an allowlist
(hosts/ports/routes/file-roots/processes). Synthetic fixtures only. The specific
guarantees the task named are all present: **no** real social post (PromoPilot,
`PROMO_ENABLED=false` + zero creds), **no** app-store submission (App Store
Publisher, creds unset), **no** Bowker/ISBN/publish (ForgePress), **no** scan/delete
outside fixtures (Free and Clean, dry-run only), **no** real secrets/PII (Incognito),
**no** real financial/PHI/genomic data (Family Stewardship, LiveHealth, GeneMap,
Kidney Antigen), **no** high-risk bio design (CRISPR Compass — a disclaimer-present
safety journey), **no** untrusted-code execution (Scout/FlexFactor), **no**
deploy/publish (Factory Deck), **no** grant submission / real email / uncontrolled
crawl (GrantFlow), **no** community posting/payment/email (SermonSmith), **no**
repo install/execution (Repo Rewards), **no** private family assets (Family Castle
Clash), educational-only (Are We Mice). The runner has no code path that performs
any prohibited action.

## Trust boundary & result contract

Signed ingest (`POST /api/eva/ingest`): HMAC-SHA256 over
`v1\nrunner_id\ntimestamp\nnonce\nidempotency_key\nsha256(body)`. The coordinator
rejects missing/invalid signatures (401), unknown runners (401), stale timestamps
(401), replayed nonces (409), conflicting idempotency keys (409), oversized bodies
(413), malformed JSON (400), and schema-invalid payloads (422). Secret is env-only.
A failed journey must carry severity, retry classification, failure class,
expected/observed, repro, impact, and confidence; **below 0.70 confidence the
diagnosis must name its missing evidence** (validator-enforced). No manufactured
diagnoses.

Findings dedupe on a stable fingerprint `(app, journey, failure-class, route,
error-signature)` and carry a lifecycle: new / recurring / worsened / intermittent
/ resolved / blocked / stale. Yesterday's pass never masquerades as today's; an
intermittent failure never becomes a clean pass; missing/stale testing renders an
explicit "not a pass / UNVERIFIED" block.

## Exact commands run & outcomes

| Command | Outcome |
| --- | --- |
| `vitest run` on the 7 EVA/Anya test files | **76 passed** (evaTypes 11, evaIngest 11, evaRunStore 10, evaOwnerReport 10, evaRegistry 10, evaManifestTotality 4, anyaDailyOwnerReport 20) |
| `node --test` edge-runner (sign + runner) | **7 passed** (signature cross-check with the coordinator; upload retry/terminal classification; failure confirmation; dry-run skip) |
| `node bin/eva-runner.mjs --selftest` | **7/7 checks passed** — incl. the coordinator verifier accepting a runner-signed payload end-to-end |
| `node bin/eva-runner.mjs --dry-run` (19 apps) | resolves all 19; 18 not-run (nothing launched), 1 blocked (Factory Deck); **0 crashes, 0 missing manifests** |
| Migration `151` applied twice on a fresh sqlite DB | idempotent; 6 tables created |
| Existing telemetry tests (`agentHealthAndCrawlerErrors`, `samAgentObservabilityDepth`) | pass with `eva` registered |
| Representative email render (no send — no Resend key) | `docs/eva-sample-email.{html,txt}`; subject "…1 code (0C/1H) · 2 user-journey fails" |

## Sample email (excerpt)

```
PORTFOLIO USER-JOURNEY TESTS
----------------------------
2 user journeys failed across 3 tested programs.

Apps: 19 expected | 3 tested | 1 blocked | 0 startup-failed | 15 not run
Journeys: 3 executed | 1 passed | 2 failed | pass rate 33%
Findings: 1 new | 0 recurring | 0 worsened | 1 intermittent
Coverage: 37% | Runner heartbeat: missing

ACTIONABLE FINDINGS (critical/high first):

  [Critical] GrantFlow — Login page loads and identifies GrantFlow (NEW)
    Expected: Login page renders the GrantFlow sign-in form
    Observed: White screen; console: TypeError reading map
    Impact: No user can sign in — total outage of the entry point.
    Likely cause: authStore selector returns undefined before hydration
    Suggested repair: Guard the profiles.map with an empty-array default in Login.jsx
    Candidate files: src/pages/Login.jsx, src/stores/authStore.js
    Confidence: 0.86

  [Medium] GeneMap Discovery — Reach register form (Intermittent)
    Confidence: 0.60 (low — needs more evidence)
    Missing evidence: capture 5 consecutive runs with timing to separate cold
      Vite first-paint from a real hydration stall.
```

Full HTML + text: `docs/eva-sample-email.{html,txt}`.

## Independent report streams (verified by test)

- Sam absent + EVA present → email **sends**, states "Sam sweep was unavailable".
- EVA absent → email **sends**, states portfolio testing not run ("not a pass /
  UNVERIFIED"), never all-clear.
- Neither → nothing to send.

## Known limitations & external blockers

1. **Per-repo manifest placement.** The 18 non-GrantFlow manifests live in the
   central bundle (loaded via `EVA_MANIFEST_DIR`); copying each into its own repo's
   `qa/user-journeys.json` on a matching branch is a mechanical follow-up.
2. **App launch harness.** The orchestrator runs journeys via the adapter against a
   resolved base URL / declared command; the per-runtime *launch* (start_command →
   readiness probe → stop) is documented per manifest and installed per-environment.
   Apps without a resolvable launch report `manual_required`, never a silent pass.
   Electron/api/windows-ui journeys currently return `blocked` (adapter harness
   pending) rather than a fabricated pass.
3. **Playwright is an optional dependency.** Without it, web journeys report
   `blocked` naming the missing dep. Install per `docs/EVA_WINDOWS_RUNNER.md`.
4. **External blockers:** Factory Deck (Anthropic credits empty); Repo Rewards,
   GeneMap, SermonSmith, Family Stewardship require a scratch Postgres for authed
   journeys; GeneMap needs Node 24 + pnpm; Family Stewardship needs Docker. All are
   recorded truthfully in the registry/manifests — a blocked app is never green.
5. **Nonce table growth** is bounded by the hourly maintenance sweep (nonces older
   than the freshness window can't enable a replay and are pruned).

## Privacy review

Redaction (`redactText`/`redactDeep`) strips API keys, bearer tokens, JWTs, emails,
SSNs, card numbers, and private Windows paths (`C:\Users\<name>` → `[USER_HOME]`) —
applied at ingest (belt-and-suspenders with the runner) and again at render via
GrantFlow's `maskSecrets`, then HTML-escaped. Evidence is stored **by reference**
(sanitized relative names + sha256), never raw log bodies/screenshots. Tested: a
secret embedded in an observed-behavior string never appears in the rendered HTML
or text. The runner secret is env-only and excluded from logs, emails, and reports.

## Rollback

EVA is additive and default-off. (1) Unset `EVA_RUNNER_SECRETS`/`EVA_RUNNER_SECRET`
→ ingest 503s, runner can't upload. (2) With no EVA data the email section renders
"not run"; or revert the four `anyaDailyOwnerReport.js` edits to remove it. (3)
Revert the branch — migrations only `CREATE TABLE IF NOT EXISTS`, so no existing
table/column is touched. Full detail in `docs/EVA_PORTFOLIO_QA.md`.

## Truthfulness statement

Every app's state is one of: verified-working, failed, intermittent, blocked,
not-tested, stale, or manual-verification-required — and these are kept distinct in
the store, the summary, and the email. No untested feature is painted green; a
stale run is not a pass; a blocked app is not a pass; yesterday's pass is not
today's. The morning email tells the owner what a real user could and could not
accomplish overnight, which program was affected, why it probably failed, and the
most credible repair — with a confidence score and, below 0.70, the missing
evidence and next diagnostic step.
