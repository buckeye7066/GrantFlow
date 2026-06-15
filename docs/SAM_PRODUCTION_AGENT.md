# Sam — GrantFlow Production-Readiness Agent

Sam is GrantFlow's dedicated background **production engineer**. Sam keeps
the codebase, wiring, admin tools, API routes, frontend/backend
integration, tests, migrations, health checks, and release-readiness
gates in good shape as the application evolves.

Sam is **not** a grant finder, a user-facing funding assistant, or a
replacement for Anya. Anya remains focused on user/admin grant workflow
guidance; Sam owns production health.

## What Sam is

- A modular, auditable, **admin-controlled** background agent.
- An orchestrator: Sam delegates to existing Anya autonomous tooling and
  the project's release gates rather than reimplementing scanners.
- Strictly read-only by default. Mutations require an authorised admin
  AND the `repair-safe` mode.
- Always honest: Sam **never** marks anything production-ready unless the
  underlying check actually passed.

## What Sam is not

- Not a grant finder.
- Not a user-facing chat assistant.
- Not allowed to modify grant matching, scoring, crawler persistence,
  application submission, financial/legal/medical wording, or auth code.
- Not allowed to run shell commands that aren't in the registered
  whitelist.
- Not allowed to silently mutate production code. Ever.

## Operating modes

| Mode          | Read/write | What it does |
| ------------- | ---------- | ------------ |
| `observe`     | read-only  | Default. Runs diagnostics, reports findings, returns a health score. No plan, no writes. |
| `advise`      | read-only  | Diagnostics + structured repair plan with risk levels and rollback notes. No writes. |
| `repair-safe` | writes (gated) | Applies only deterministic safe fixes from `SAFE_FIX_REGISTRY`. Requires authorised admin AND `SAM_ALLOW_SAFE_REPAIR=true`. Refuses if dryRun is true. |
| `gatekeeper`  | read-only  | Runs the production-gate scripts (`scan:secrets`, `lint:strict`, `typecheck`, `build`, `unit`, `db:setup`, `crawler:doctor`, `crawler:smoke`, `smoke:apply-engine`, `release:gates`, `test:all`). Reports pass/fail/skipped per gate. Skips missing optional scripts. |

## Environment variables

All env vars default to the safest possible value.

| Var                       | Default       | Purpose |
| ------------------------- | ------------- | ------- |
| `SAM_ENABLED`             | `false`       | Master switch. When `false`, the scheduler logs once and exits. |
| `SAM_RUN_ON_STARTUP`      | `false`       | If true and `SAM_ENABLED=true`, run a dry observe pass on boot. |
| `SAM_RUN_ON_SCHEDULE`     | `false`       | If true and `SAM_ENABLED=true`, run on a recurring schedule. |
| `SAM_SCHEDULE`            | `0 4 * * *`   | Cron-style. We support the daily-at-HH:MM subset. Anything else falls back to `04:00`. |
| `SAM_MODE`                | `observe`     | Mode for scheduled runs. `repair-safe` is REJECTED here — the scheduler will never silently mutate code. |
| `SAM_ALLOW_SAFE_REPAIR`   | `false`       | Even when admin clicks "Apply Safe Fixes", Sam refuses unless this is `true`. |
| `SAM_MAX_FIXES_PER_RUN`   | `10`          | Hard cap on how many safe fixes Sam will apply in one run. |
| `SAM_FAIL_ON_CRITICAL`    | `true`        | If `true`, any critical finding flips `production_ready` to `false`. |

## API endpoints

Mounted at `/api/sam/*`. Every non-health route is admin-only
(`req.ctx.isAdmin === true`).

| Method | Path                                | Purpose |
| ------ | ----------------------------------- | ------- |
| GET    | `/api/sam/health`                   | **Public.** Tiny `{ ok, agent, status, enabled }`. Never returns secrets, env, or run details. |
| GET    | `/api/sam/status`                   | Cached snapshot of the latest run, scheduler config, check rollup. Fast. |
| POST   | `/api/sam/run`                      | Canonical orchestrator. Body: `{ mode, checks, dryRun, fixIds, maxFixes }`. |
| POST   | `/api/sam/diagnose`                 | Convenience for `mode: observe`. |
| POST   | `/api/sam/plan-repair`              | Convenience for `mode: advise`. |
| POST   | `/api/sam/apply-safe-fixes`         | `mode: repair-safe`. Requires `SAM_ALLOW_SAFE_REPAIR=true`. |
| POST   | `/api/sam/run-gates`                | `mode: gatekeeper`. Runs the production-gate scripts. |
| GET    | `/api/sam/runs`                     | Recent runs (default 25). |
| GET    | `/api/sam/runs/:runId`              | Single run with findings, repair plan, applied fixes. |

### Sample run response

```json
{
  "ok": true,
  "run_id": "sam-l3pkgo-q1z2x3",
  "status": "completed",
  "mode": "observe",
  "health_score": 84,
  "production_ready": true,
  "findings": [
    {
      "id": "sam-...",
      "severity": "medium",
      "category": "broken_imports",
      "title": "TODO leftover",
      "affected_files": ["src/components/X.jsx"],
      "recommended_fix": "...",
      "safe_auto_fix_available": false,
      "confidence": 0.7,
      "created_at": "2026-06-15T18:32:14.123Z"
    }
  ],
  "repair_plan": [],
  "applied_fixes": []
}
```

## Safety rules

1. **Default mode is `observe`** — read-only, no plan, no writes.
2. **`repair-safe` requires** an authorised admin (`req.ctx.isAdmin === true`)
   AND `SAM_ALLOW_SAFE_REPAIR=true` AND `dryRun: false`. Any of those
   missing → Sam silently downgrades to `advise`.
3. **Whitelisted commands only.** Production gates spawn npm/node scripts
   from a closed list in `samRegistry.js`. Anything else is refused with
   `skipped: not_in_whitelist`.
4. **No shell.** All commands are spawned with `shell: false` and rejected
   if they contain shell metacharacters (`;`, `&`, `|`, backticks, etc).
5. **Forbidden paths** — Sam refuses to write to migrations,
   `schema.sql`, `matchEngine.js`, `profileNormalizer.js`, billing /
   stripe / application / grant / saved / crawler service files, auth
   middleware, auth/admin routes, `.env*`, `node_modules`, or `.git`.
6. **Secrets are masked** before persistence and before any response.
   See `samAuditStore.maskSecrets`.
7. **Never invents results.** A check that errors becomes a `medium`
   finding describing the error — Sam doesn't pretend the check passed.

## How to run Sam manually

### From the admin console

1. Sign in as an admin.
2. Open `Admin → Sam` tab.
3. Click **Run Diagnostics** (or **Plan Repairs**, **Run Production Gates**).
4. To apply safe fixes, the server must have `SAM_ALLOW_SAFE_REPAIR=true`.
   Type the desired fix ids into the JSON payload editor and click **Apply Safe Fixes**.

### From curl

```bash
# Diagnostics (requires admin session cookie or x-anya-token)
curl -s -X POST http://localhost:3911/api/sam/diagnose \
  -H 'Content-Type: application/json' -b admin.cookie.txt \
  -d '{"checks":["code.scan","http.readyz"]}' | jq .

# Production gates
curl -s -X POST http://localhost:3911/api/sam/run-gates -b admin.cookie.txt | jq .

# Status snapshot
curl -s http://localhost:3911/api/sam/status -b admin.cookie.txt | jq .

# Public health
curl -s http://localhost:3911/api/sam/health
```

## Interpreting findings

Each finding has:

- `severity` — `critical | high | medium | low | info`
- `category` — closed list in `samTypes.SAM_CATEGORIES`
- `title` / `description` — human summary
- `evidence` — structured payload from the underlying tool
- `affected_files` / `affected_routes` — what the finding targets
- `recommended_fix` — sentence-level remediation
- `safe_auto_fix_available` — whether `repair-safe` mode could auto-fix it
- `confidence` — 0..1, the agent's certainty

`production_ready` flips to `false` if any critical finding exists (when
`SAM_FAIL_ON_CRITICAL=true`) OR more than 5 high findings exist OR the
health score (100 minus severity-weighted penalties) drops below 80.

## How Sam differs from Anya

| Concern                          | Owner |
| -------------------------------- | ----- |
| User/admin grant workflow chat   | **Anya** |
| Funding discovery / suggestions  | **Anya** |
| Profile guidance                 | **Anya** |
| Code crawl / function tests      | **Sam** (delegates to Anya tools) |
| Production gates / release gates | **Sam** |
| Health & readiness aggregation   | **Sam** |
| Safe-fix application             | **Sam** |
| Repair plans                     | **Sam** |

The legacy Anya autonomous endpoints (`/api/anya/autonomous/*`) keep
working so existing UI doesn't break. Each one returns a `Deprecation:
true` HTTP header and a `Link: </api/sam/...>; rel="successor-version"`
pointing at the canonical Sam route.

## Production deployment guidance

1. Deploy with the safe defaults — `SAM_ENABLED=false`, no scheduler.
2. Once an admin has used the console manually for a release cycle,
   flip `SAM_ENABLED=true` + `SAM_RUN_ON_SCHEDULE=true` + `SAM_MODE=observe`.
   Sam will run a daily dry observe pass and persist findings to
   `sam_runs`.
3. Only consider `SAM_ALLOW_SAFE_REPAIR=true` AFTER you've reviewed at
   least one weeks of advise-mode reports and confirmed the safe-fix
   registry is conservative enough.
4. Never set `SAM_MODE=repair-safe` for the scheduler — Sam will reject
   that and fall back to observe.

## Rollback plan

- The `sam_runs` table is additive — dropping it doesn't affect any
  existing GrantFlow behaviour.
- The `/api/sam/*` routes are mounted via `lazyRouter`. Removing the
  mount from `backend/server.js` disables Sam without removing the
  files.
- The `Sam` admin tab in `src/pages/Admin.jsx` can be commented out
  while leaving the rest of the admin UI intact.
- The Anya autonomous routes' `Deprecation` header is informational —
  removing the `attachSamDeprecationHeader` calls is a one-line revert
  per route.
- Migrations are idempotent (`CREATE TABLE IF NOT EXISTS`). Re-applying
  is safe; rolling back means dropping `sam_runs` manually.

## See also

- `backend/services/sam/samTypes.js` — modes, categories, severity, shape factories
- `backend/services/sam/samRegistry.js` — checks + safe-fix registry + command whitelist
- `backend/services/sam/samAgent.js` — orchestrator
- `backend/services/sam/samDiagnostics.js` — runs checks
- `backend/services/sam/samRepairPlanner.js` — turns findings into plans
- `backend/services/sam/samSafeFixes.js` — the only mutating layer
- `backend/services/sam/samAuditStore.js` — persistence + secret masking
- `backend/services/sam/samScheduler.js` — env-gated background runner
- `backend/routes/sam.js` — HTTP surface
- `src/components/admin/AdminSamConsole.jsx` — admin UI
- `tests/unit/sam-*.test.mjs` — 36 unit tests covering mode gating, secrets, plans, safe fixes
