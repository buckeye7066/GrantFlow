# EVA — Portfolio User-Journey QA (Coordinator)

EVA (**E**nd-user **V**alidation **A**gent) proves whether a *real person* can use
each program in the portfolio. It is the functional-testing counterpart to Sam
(who inspects source code, config, routes, and security). Anya combines both into
one morning owner email.

- **Sam** inspects code, configuration, routes, security, and quality.
- **EVA** launches each app, navigates its important workflows, enters realistic
  synthetic data, submits forms in safe test mode, saves & reloads data, tests
  validation/recovery paths, and verifies visible results are correct.
- **Anya** merges Sam's and EVA's results into the existing 09:00 ET owner email.

## Architecture decision: EVA is a dedicated agent (not a Sam lane)

EVA is implemented as a **dedicated agent**, registered as `eva` in
`backend/services/agentTelemetry/agentTelemetryTypes.js` (`AGENT_NAMES`), not as a
lane inside Sam. Rationale:

1. **Separation of concerns is the whole point.** Sam is a *static* analyzer that
   runs in the cloud and never launches anything. EVA is a *dynamic* end-user
   simulator that must launch real apps — which the GrantFlow cloud server cannot
   do. They have different trust models, different runtimes (cloud vs. the owner's
   Windows box), and different failure modes. Folding EVA into Sam would blur the
   very distinction the owner asked to preserve.
2. **Different trust boundary.** EVA's results arrive from an *untrusted* edge
   runner over the network and are HMAC-verified; Sam's run in-process. A shared
   lane would have to straddle both.
3. **Independent report streams.** The owner email must send even when one stream
   is down. Distinct agents make "Sam unavailable, EVA present" (and vice-versa) a
   natural state rather than a special case.

## Two layers

### A. GrantFlow EVA coordinator (this repo)

| Module | Responsibility |
| --- | --- |
| `backend/services/eva/evaTypes.js` | Versioned result contract validation, stable finding fingerprint, redaction (secrets/PII/PHI/private paths), vocabularies, limits. Pure. |
| `backend/services/eva/evaRegistry.js` | Loads `qa/portfolio-registry.json`; validates per-repo manifests (rejects any without a prohibited-action policy or cleanup). |
| `backend/services/eva/evaIngest.js` | The trust boundary: HMAC signature verification, replay (nonce) prevention, freshness, idempotency, schema validation, size limits. |
| `backend/services/eva/evaRunStore.js` | Persistence + finding **deduplication** + lifecycle transitions (new/recurring/worsened/intermittent/resolved) + runner heartbeats. |
| `backend/services/eva/evaSummary.js` | Loader + pure summarizer that produces the exact object the email renders; freshness/stale/heartbeat analysis. |
| `backend/services/eva/evaReportSection.js` | Renders the `PORTFOLIO USER-JOURNEY TESTS` HTML + plain-text section, escaped and secret-masked. |
| `backend/services/eva/evaScheduler.js` | Best-effort maintenance sweep: marks open findings `stale` when no fresh run re-observed them; reports heartbeat health. |
| `backend/services/eva/evaTelemetry.js` | Records EVA events into `agent_activity_events` so EVA appears in Mission Control. |
| `backend/routes/adminPortfolioQa.js` | `POST /api/eva/ingest` + `/api/eva/heartbeat` (signed), `GET /api/eva/status` + `/api/eva/preview-email` (admin). |

**DB:** migration `backend/db/migrations/151_eva_portfolio_qa.sql` (+ Postgres twin
`0155_…`, + the `schema.sql` mirror for fresh SQLite). Tables: `eva_runs`,
`eva_app_runs`, `eva_journey_results`, `eva_findings`, `eva_runner_heartbeats`,
`eva_evidence`, plus `eva_seen_nonces` (created lazily by the ingest layer). No
BOOLEAN columns are filtered in SQL — lifecycle/status are TEXT — which sidesteps
the Postgres `boolean = integer` shim trap by construction.

### B. Windows edge runner

See `docs/EVA_WINDOWS_RUNNER.md`. The runner launches apps on the owner's Windows
machine, runs journeys, and uploads **signed** results. It exposes no general
remote-command capability.

## Signed ingest contract

The runner signs every upload with **HMAC-SHA256** over a canonical string:

```
v1 \n runner_id \n timestamp \n nonce \n idempotency_key \n sha256(body)
```

Headers: `x-eva-runner-id`, `x-eva-timestamp`, `x-eva-nonce`,
`x-eva-idempotency-key`, `x-eva-signature`. The coordinator **rejects**:

| Condition | HTTP |
| --- | --- |
| Missing signature headers | 401 |
| Invalid signature / tampered body (digest is signed) | 401 |
| Unknown runner id | 401 |
| Stale/future timestamp (> 5 min skew) | 401 |
| Replayed nonce | 409 |
| Conflicting duplicate idempotency key | 409 |
| Oversized payload (> 2 MB) | 413 |
| Malformed JSON | 400 |
| Schema-invalid payload | 422 |

The shared secret lives in `EVA_RUNNER_SECRETS` (JSON `{runnerId: secret}`) or
`EVA_RUNNER_SECRET` + `EVA_RUNNER_ID` — **environment only**, never in source,
logs, screenshots, emails, or reports. A duplicate idempotency key with a fresh
nonce is a benign no-op returning the stored run (idempotent retry).

## Result contract (v1)

Validated against `qa/eva-result.schema.json` / `evaTypes.validateResultPayload`.
A **failed** journey must carry: severity, retry classification, failure class,
expected & observed behavior, reproduction steps, user impact, and diagnostic
confidence. **Below 0.70 confidence a diagnosis must name its missing evidence and
the next diagnostic step** — the validator enforces this. Candidate files asserted
at implausibly low confidence are rejected (no manufactured diagnoses).

## Finding lifecycle & deduplication

Each failure gets a **stable fingerprint** = FNV-1a hash over
`(app_id, journey_id, normalized failure class, normalized route/control,
normalized error signature)`. IDs in the route and volatile numbers/UUIDs in the
error are collapsed, so the same real defect fingerprints identically across runs.

`eva_findings` is one row per fingerprint. Transitions:

- **new** — first observation.
- **recurring** — seen again; `recurrence_count` increments.
- **worsened** — severity climbed vs. the stored value.
- **intermittent** — a retry classified it intermittent; never presented as a
  clean pass.
- **resolved** — a passing run of that journey closes every open finding on it,
  stamping `last_passing_run`/`resolved_at`.
- A resolved finding that reappears **reopens as recurring** (regression).
- **stale** — the maintenance sweep marks open findings stale when no fresh run
  re-observed them within 30 h (default). A stale finding is neither "still
  failing today" nor "resolved" — an honest third state.

Yesterday's pass may inform trend context but is never presented as today's pass.

## Anya morning email

`backend/services/anya/anyaDailyOwnerReport.js` gained:

- `defaultLoadEvaPortfolioQa` (loader, injectable) + `summarizeEvaPortfolioQa`
  (pure, exported) via `evaSummary.js`.
- EVA support in `buildOwnerReport` (new `eva` option) — renders the
  `PORTFOLIO USER-JOURNEY TESTS` section in HTML and text.
- EVA loading in `runAnyaDailyOwnerReport` (independent of Sam).
- Subject now reflects **both** code and functional findings.

**The two report streams never gate each other:**

- Sam has no run but EVA has data → the email sends and states the Sam sweep was
  unavailable.
- EVA has no fresh run → the email sends and states portfolio testing was stale or
  not run (an explicit "not a pass / UNVERIFIED" block — missing testing can never
  read as all-clear).
- Neither has data → nothing to send.

One morning email is preserved; the scheduler is unchanged (EVA data flows into
the existing 09:00 ET job).

## Rollback

EVA is **additive and default-off**. To disable:

1. **Stop ingesting**: unset `EVA_RUNNER_SECRETS` / `EVA_RUNNER_SECRET`. The ingest
   endpoints then return `503 eva_ingest_not_configured`; the runner cannot upload.
2. **Remove the email section**: with no EVA data the loader returns null and the
   section renders "not run" — or revert the four edits in
   `anyaDailyOwnerReport.js` (imports, `buildOwnerReport` eva option, the two
   render injections, and the `loadEva` wire-up) to remove it entirely.
3. **Full removal**: revert this branch. The migrations only `CREATE TABLE IF NOT
   EXISTS` and touch nothing else, so leaving the tables in place is harmless; drop
   them only if desired. No existing table or column is modified.

Nothing EVA does mutates real user data, and every external action is prohibited by
the per-app manifests (see `qa/manifests/*.json`).
