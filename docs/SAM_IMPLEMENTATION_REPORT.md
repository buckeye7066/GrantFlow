# Sam — Implementation Report

This is the verification log for the initial Sam (production-readiness
agent) build on branch `feat/sam-production-readiness-agent`.

For Sam's purpose, modes, env vars, API, and safety rules see
`docs/SAM_PRODUCTION_AGENT.md`.

## Files changed

### New backend services

- `backend/services/sam/samTypes.js` — modes, severities, categories,
  finding/repair shape factories, health-score helpers.
- `backend/services/sam/samRegistry.js` — closed registry of diagnostic
  checks, production-gate scripts, command whitelist, safe-fix list.
- `backend/services/sam/samAuditStore.js` — `sam_runs` CRUD + secret
  masking (`maskSecrets` redacts API keys, bearer tokens, env-var-style
  assignments; caps log size at 100k chars).
- `backend/services/sam/samDiagnostics.js` — runs checks; delegates
  tool-style checks to the existing Anya tool registry; falls back to
  HTTP probes; never throws (errors become findings).
- `backend/services/sam/samRepairPlanner.js` — turns findings into
  structured repair plans; every plan requires admin approval; critical
  findings outside the safe-fix path stay `risky`.
- `backend/services/sam/samSafeFixes.js` — the only mutating layer.
  Hard-coded forbidden-path guards (migrations, schema, matchEngine,
  profileNormalizer, billing/stripe/applications, auth middleware,
  `.env*`, `node_modules`); whitelisted command runner with no shell,
  shell-metachar refusal, timeouts, and secrets-masked output.
- `backend/services/sam/samAgent.js` — orchestrator. Default mode
  `observe`. `repair-safe` is auto-downgraded to `advise` unless the
  caller is an authorised admin AND `dryRun=false`. Persists one row
  per orchestrating run.
- `backend/services/sam/samScheduler.js` — env-gated background runner.
  Off by default. Refuses `repair-safe` for scheduled runs.

### New backend route

- `backend/routes/sam.js` — `/api/sam/health` (public), `/status`,
  `/run`, `/diagnose`, `/plan-repair`, `/apply-safe-fixes`,
  `/run-gates`, `/runs`, `/runs/:runId`. Admin-only for everything
  except `/health`. `/apply-safe-fixes` additionally requires
  `SAM_ALLOW_SAFE_REPAIR=true`.

### Migrations

- `backend/db/migrations/080_sam_runs.sql` (SQLite).
- `backend/db/postgres/migrations/0076_sam_runs.sql` (Postgres).
- `backend/db/schema.sql` — added the same `sam_runs` definition for
  fresh-bootstrap installs.

### Server wiring

- `backend/server.js`
  - Mounted `/api/sam` via `lazyRouter('./routes/sam.js')`.
  - Started `samScheduler` (off by default; logs once and exits when
    env gates are not set).
- `backend/routes/anya.js`
  - Added an informational `Deprecation: true` HTTP header and
    `Link: </api/sam/...>; rel="successor-version"` to every
    `/api/anya/autonomous/*` response. The legacy endpoints continue to
    work unchanged.

### Frontend

- `src/components/admin/AdminSamConsole.jsx` — admin UI. Buttons: Run
  Diagnostics, Plan Repairs, Run Production Gates, Apply Safe Fixes,
  Refresh. Renders findings + repair plan. Disables Apply Safe Fixes
  unless the server reports `allow_safe_repair: true`.
- `src/pages/Admin.jsx` — added the Sam tab next to the Anya tab.

### Documentation

- `docs/SAM_PRODUCTION_AGENT.md` — operator-facing guide.
- `docs/SAM_IMPLEMENTATION_REPORT.md` — this file.

### Tests

- `tests/unit/sam-test-helpers.mjs` — in-memory DB shim for Sam tests.
- `tests/unit/sam-agent.test.mjs` — orchestrator + mode-gating contract
  + health score + persistence.
- `tests/unit/sam-diagnostics.test.mjs` — registry sanity + check
  unknown-id handling + secret masking.
- `tests/unit/sam-repair-planner.test.mjs` — plan-per-finding,
  risk-level rules, rollback plan.
- `tests/unit/sam-safe-fixes.test.mjs` — admin gating, forbidden-path
  refusal, command whitelist enforcement, missing-script skipping.

## Endpoints added

| Method | Path                         | Auth |
| ------ | ---------------------------- | ---- |
| GET    | `/api/sam/health`            | public |
| GET    | `/api/sam/status`            | admin |
| POST   | `/api/sam/run`               | admin |
| POST   | `/api/sam/diagnose`          | admin |
| POST   | `/api/sam/plan-repair`       | admin |
| POST   | `/api/sam/apply-safe-fixes`  | admin + `SAM_ALLOW_SAFE_REPAIR=true` |
| POST   | `/api/sam/run-gates`         | admin |
| GET    | `/api/sam/runs`              | admin |
| GET    | `/api/sam/runs/:runId`       | admin |

## Env vars added

| Var | Default |
| --- | ------- |
| `SAM_ENABLED`            | `false` |
| `SAM_RUN_ON_STARTUP`     | `false` |
| `SAM_RUN_ON_SCHEDULE`    | `false` |
| `SAM_SCHEDULE`           | `0 4 * * *` |
| `SAM_MODE`               | `observe` |
| `SAM_ALLOW_SAFE_REPAIR`  | `false` |
| `SAM_MAX_FIXES_PER_RUN`  | `10` |
| `SAM_FAIL_ON_CRITICAL`   | `true` |

## Tests added (acceptance scenarios → unit tests)

| Acceptance scenario | Test file |
| ------------------- | --------- |
| 1. Sam defaults to observe / dry-run                      | `sam-agent.test.mjs` — "Sam defaults to observe mode + dry-run" |
| 2. Sam refuses write/fix without admin                    | `sam-agent.test.mjs` — "refuses repair-safe without authorised admin" + `sam-safe-fixes.test.mjs` — "applySafeFix refuses without admin" |
| 3. Sam does not run unknown shell commands                | `sam-safe-fixes.test.mjs` — "runWhitelistedCommand refuses commands not in the whitelist" + "...refuses commands with shell metacharacters" |
| 4. Sam masks secrets in logs                              | `sam-diagnostics.test.mjs` — "maskSecrets redacts API keys and bearer tokens" + "...caps very long strings" + "...walks objects" |
| 5. Sam returns skipped for missing optional npm scripts   | `sam-safe-fixes.test.mjs` — "runWhitelistedCommand returns skipped:script_not_found for missing npm scripts" |
| 6. Sam generates structured findings                      | `sam-diagnostics.test.mjs` — "runDiagnostics surfaces issues from a tool result..." + `sam-agent.test.mjs` — "Sam health_score reflects severity of findings" |
| 7. Sam generates repair plans without applying in advise  | `sam-repair-planner.test.mjs` — every test in this file |
| 8. Sam applies only safe fixes in repair-safe + authorised | `sam-agent.test.mjs` — "Sam runs repair-safe when authorised admin + dryRun=false" + `sam-safe-fixes.test.mjs` — "applySafeFix accepts a docs log write" |
| 9. Sam status endpoint returns cached status quickly      | `sam-agent.test.mjs` — "Sam status snapshot is fast and never runs diagnostics" |
| 10. Backward-compatible Anya endpoints still work         | Anya autonomous routes are unchanged on the wire — only `Deprecation` headers added (manual review). The 5 existing Anya autonomous routes pass through to `invokeTool` exactly as before. |

## Commands run

All commands run on Windows / PowerShell from repo root.

| Command | Result | Notes |
| ------- | ------ | ----- |
| `node --test tests/unit/sam-*.test.mjs` | 36/36 pass | All Sam unit scenarios green. |
| `npm run -s lint:strict` | exit 0 | Clean. |
| `npm run -s typecheck` | exit 0 | Clean. |
| `npm run -s build` | exit 0 | Vite build succeeded; bundle sizes unchanged besides the small Sam additions. |
| `npm run -s unit` | 712/712 pass | Full unit suite green. |
| `npm run -s crawler:doctor` | exit 0 | API smoke OK. |

## Known limitations

- The default `httpProbe` in `routes/sam.js` uses a global `fetch` to
  `127.0.0.1:${PORT}`. In environments without a local fetch, those
  HTTP-style checks silently skip — Sam reports a `skipped` detail for
  them rather than a finding.
- `runProductionGates` uses a fixed `whitelist` from `samRegistry.js`.
  Adding a new gate requires a code change (intentional — keeps the
  whitelist as the only way to spawn a command).
- The Sam scheduler currently parses only the `M H * * *` (daily-at-HH:MM)
  cron subset. Anything else falls back to 04:00. This avoids pulling in
  a cron dependency.
- Safe fixes today are intentionally narrow: `docs.regenerate-readiness-log`
  and `lint.eslint-fix-file`. Additions must come with a unit test that
  proves idempotency + rollback.
- Sam does NOT delete `sam_runs` rows. Run history grows monotonically.
  An admin trim job can be added later if the table grows.

## Next recommended improvements

1. Add a small `findings_summary` view (or query) to support the admin
   console's history tab without re-shaping rows on every poll.
2. Wire `samDiagnostics` directly to `productionReadinessChecks.js` and
   `missionHealthService.js` for richer mission-aware findings without
   going through the tool registry.
3. Add a `safe-fix:remove-unused-import` strategy backed by ESLint's
   `--rule '{"no-unused-vars":"error"}' --fix` — guarded by the existing
   `isPathSafeForFix`.
4. Add `/api/sam/runs/:runId/applied-fixes` so the admin UI can show a
   per-fix diff after `apply-safe-fixes`.
5. Add a CI-only invocation of `POST /api/sam/run-gates` against a
   staging deployment to catch regressions before merge.

## Final acceptance check

- [x] Sam exists as a distinct production-readiness agent.
- [x] Sam is admin-controlled (every non-health route requires
      `req.ctx.isAdmin === true`).
- [x] Sam defaults to safe observe mode (verified by unit test).
- [x] Sam can run diagnostics and production gates.
- [x] Sam can generate repair plans.
- [x] Sam can apply only safe fixes with explicit authorisation
      (`SAM_ALLOW_SAFE_REPAIR=true` + admin caller).
- [x] Sam has a dashboard / admin console (`AdminSamConsole.jsx`).
- [x] Sam has persistent run history (`sam_runs`).
- [x] Sam does not break Anya. Existing autonomous endpoints pass
      through to `invokeTool` unchanged; only `Deprecation` headers
      were added.
- [x] Sam does not assume fake success — every gate returns its real
      exit code; missing optional scripts report `skipped:script_not_found`.
- [x] Sam improves GrantFlow's ability to remain production-ready as
      code evolves.
