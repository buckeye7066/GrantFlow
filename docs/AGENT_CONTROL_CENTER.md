# Agent Control Center

The Admin Agent Control Center is the **start / stop / pause / resume**
console for GrantFlow's five canonical agents. It sits at the top of
Admin Mission Control and is restricted to a single operator account.

## Quick reference

- **Page:** Admin Panel → **Mission Control** tab → top section
  ("Agent Control Center").
- **Component:** `src/components/admin/agentControl/AgentControlCenter.jsx`
  (plus per-agent card / run details / events timeline children).
- **API root:** `/api/admin/agent-control/*` (admin-only).
- **Backend service:**
  `backend/services/agentControl/agentControlOrchestrator.js`.
- **Adapters:**
  `backend/services/agentControl/agentAdapters/` — one per agent
  (Sam / Robert / Yana / John / Hamilton).
- **Tables:** `agent_control_runs`, `agent_control_steps`,
  `agent_control_events`, `agent_control_locks`,
  `agent_control_stop_requests` (migration `091` SQLite,
  `0087` Postgres).

## Who can use it

There is **one** GrantFlow admin/operator, resolved as
`AGENT_CONTROL_ADMIN_EMAIL || ADMIN_EMAIL || CANONICAL_ADMIN_EMAIL_DEFAULT`
(`backend/services/agentControl/agentControlOrchestrator.js`,
`backend/services/agentControl/agentControlTypes.js`):

- `AGENT_CONTROL_ADMIN_EMAIL` — preferred override
- `ADMIN_EMAIL` — fallback
- `CANONICAL_ADMIN_EMAIL_DEFAULT` (`admin@grantflow.local`) — a **local/test
  fixture only**. In a deployed runtime (production, or any Railway
  environment) that fixture default is **not** used — the effective default
  collapses to an empty string, so `AGENT_CONTROL_ADMIN_EMAIL` or
  `ADMIN_EMAIL` **must** be set explicitly or no email will ever match the
  canonical-admin check.

The router gate is `isControlCenterAdmin(req.user)`, which compares
`user.email` (or `user.primary_email`) directly to the canonical
address. **Role checks (`is_admin = 1`, `role = 'admin'`) are
intentionally NOT honoured** — only the email match counts. Anyone else
gets HTTP `403 agent_control_admin_only`.

## Agents the Control Center coordinates

| Order | Agent | Role |
|---|---|---|
| 1 | **Sam** (preflight) | Production readiness / audit; runs first to catch a broken system before kicking off the others |
| 2 | **Robert** | Funding discovery; coverage analysis → source discovery → opportunity verification → ingest → match → recommend |
| 3 | **Yana** *(client discovery, NOT autopilot)* | Lead intelligence; refresh candidates, qualify, push approved leads to John's queue |
| 4 | **John** | Outreach drafts (Outlook); processes the queue, draft-only by default |
| 5 | **Hamilton** *(application autopilot, NOT Yana)* | Application completion; processes `application_tasks` via portal/PDF/DOCX/mail/fax/email |
| 6 | **Sam** (postflight) | Production readiness audit run after the rest, catches silent failures |

> **Yana and Hamilton are separate agents.** Yana = lead discovery.
> Hamilton = application completion. The orchestrator runs them as
> distinct steps with distinct adapters. The UI labels make this
> distinction explicit.

## Run types

| `run_type` | What it does |
|---|---|
| `full_cycle` | Sam preflight → Robert → Yana → John → Hamilton → Sam postflight |
| `selected_agents` | Same ordered subset of agents, picked via `agents: [...]` |
| `sam_only` | Sam preflight + observe + postflight |
| `robert_only` / `yana_only` / `john_only` / `hamilton_only` | Single-agent run, no Sam wrapper |
| `scheduled_cycle` | Same plan as `full_cycle`; reserved for cron-driven runs |

Only **one `full_cycle` run can be active at a time**. The
`agent_control:full_cycle` lock enforces this: a second `POST /start`
gets back HTTP `409`. Per-agent runs each take `agent_control:agent:<name>`
locks so the same agent can't be started twice at the same time.

### Lock self-healing

Locks live in `agent_control_locks` and are designed to survive crashes and
Railway dyno restarts without manual intervention:

- **TTL** — every lock carries an `expires_at` (derived from the run's
  `max_runtime_minutes`, 1h ceiling). A holder that crashes mid-cycle can
  never wedge the system: the row self-heals once the deadline passes.
- **Atomic takeover** — acquisition sweeps expired locks and atomically takes
  over an expired holder (`UPDATE … WHERE expires_at < now`), so a single
  orphaned lock is reclaimed by the very next run.
- **Owner-token fencing** — each acquisition stamps a unique `owner_token`;
  release is scoped to `(control_run_id, owner_token)` so a stale, late
  release can never free a successor's lock.
- **Always-release** — the orchestrator wraps the run in try/finally; the lock
  is released on success, agent failure, OR an unexpected exception. (A
  deliberate `pause` keeps the lock so `resume` can continue — the TTL is the
  backstop if resume never comes.)
- **Bounded retry** — acquisition retries with exponential backoff before
  giving up, smoothing over a prior run's brief teardown window.
- **Graceful skip** — a `scheduled_cycle` (or any caller passing
  `options.skip_if_locked`) whose lock is held is recorded as a `cancelled`
  no-op (with a `control.run.skipped` event), NOT a `failed` run — so a
  recurring scheduler never pollutes the "Last failure" dashboard. A manual
  start on a held lock still returns `409`, but is likewise recorded as
  `cancelled`, not `failed`.
- **Boot recovery** — boot self-heal (`ensureAgentSubsystemTables`) sweeps any
  already-orphaned locks the instant a new build comes up.

## API surface

All routes require authentication and the canonical-admin check above.

```
GET  /api/admin/agent-control/status
GET  /api/admin/agent-control/runs
GET  /api/admin/agent-control/runs/:runId
GET  /api/admin/agent-control/runs/:runId/events
POST /api/admin/agent-control/start
POST /api/admin/agent-control/runs/:runId/pause
POST /api/admin/agent-control/runs/:runId/resume
POST /api/admin/agent-control/runs/:runId/stop
POST /api/admin/agent-control/runs/:runId/emergency-stop
POST /api/admin/agent-control/runs/:runId/cancel
POST /api/admin/agent-control/agents/:agentName/start
POST /api/admin/agent-control/agents/:agentName/stop
GET  /api/admin/agent-control/agents/:agentName/status
```

### Start body

```json
{
  "run_type": "full_cycle",
  "agents": ["sam", "robert", "yana", "john", "hamilton"],
  "options": {
    "dry_run": false,
    "run_sam_preflight": true,
    "run_sam_postflight": true,
    "allow_robert_ingest": true,
    "allow_yana_leads": true,
    "allow_john_drafts": true,
    "allow_john_send": false,
    "allow_hamilton_autopilot": true,
    "stop_on_critical_sam_finding": true,
    "stop_on_agent_failure": false,
    "max_runtime_minutes": 60
  }
}
```

`POST /start` returns HTTP `202` with `{ ok, run, steps }` — the run
proceeds asynchronously after the response so the UI can render the
new run row immediately.

## Stop / pause / resume semantics

The orchestrator polls `agent_control_stop_requests` between every step
so commands are honoured even when an adapter is mid-loop. Adapters
also receive a `signal` object with `signal.shouldStop()` /
`signal.shouldPause()` — long-running adapters MUST poll these between
atomic operations so emergency stops are noticed within ~tens of ms.

| Command | Effect on the run | Effect on in-flight step |
|---|---|---|
| `pause` | `running` → `pausing` → `paused` | step finishes its current atomic op, no new step starts |
| `resume` | `paused` → `running`; old pause requests fulfilled | next queued step picked up by `executeRun` |
| `stop` (graceful) | `running` → `stopping` → `stopped` | finish current atomic op, queued steps marked `skipped`/`stopped` |
| `cancel` | terminal `cancelled` immediately | queued steps marked `skipped` |
| `emergency-stop` | terminal `stopped` (or `partial_stop` if in-flight steps couldn't be aborted safely) | queued steps `stopped` immediately, in-flight rely on signal |

The UI never says "stopped" while an agent is still running. Statuses
include `stopping`, `stopped`, `partial_stop`, and `stop_failed` so the
operator can see exactly where the system is.

## Adapter contract

Every agent implements `BaseAgentAdapter`:

```js
adapter.getStatus({ db })           // health snapshot
adapter.start({ db, controlRunId, stepId, options, stage, signal })
adapter.pause({ db, controlRunId })
adapter.resume({ db, controlRunId })
adapter.stop({ db, controlRunId, emergency })
adapter.health({ db })
```

The orchestrator never imports adapters directly — it asks the
`agentAdapterRegistry` for a name. Tests can swap any adapter via
`setAdapter(name, mock)` and restore the defaults with
`resetRegistry()`.

`signal.heartbeat(progress)` writes a `heartbeat_at` row on the step
plus the supplied progress JSON. `signal.recordEvent(args)` writes a
new row in `agent_control_events`. Adapters should call both
liberally; the timeline + progress UI relies on them.

## Notifications

Every lifecycle transition creates one persistent
`notifications` row addressed to the canonical admin (see "Who can use it"
above for how that address is resolved). Types:

- `agent_control_started`
- `agent_control_completed`
- `agent_control_failed`
- `agent_control_paused`
- `agent_control_resumed`
- `agent_control_stopped`
- `agent_control_emergency_stopped` (severity: high; 90-day expiry)
- `agent_control_agent_failed`
- `agent_control_agent_blocked`

If the admin is logged in, the existing NotificationBell + toast bridge
picks the row up on its next poll. Otherwise the row stays in the bell
list until acknowledged.

## Database tables

```
agent_control_runs            top-level orchestration runs
agent_control_steps           one row per agent step in a run
agent_control_events          audit timeline (every transition + heartbeats + adapter events)
agent_control_locks           single-flight enforcement (full_cycle, per-agent)
agent_control_stop_requests   durable pause/resume/stop/cancel/emergency_stop signals
```

All five tables come from migration `091_agent_control_center.sql`
(SQLite) and `0087_agent_control_center.sql` (Postgres). Both are
idempotent — every CREATE uses `IF NOT EXISTS`.

## Sam monitoring

Sam owns two checks specific to the Control Center:

- `agent.controlCenter.status` — HTTP probe against
  `/api/admin/agent-control/status` so Sam catches a broken router
  before the next full cycle starts.
- `agent.controlCenter.lockHygiene` — internal check that any expired
  lock past its TTL has been released. A wedged lock would prevent any
  new run from starting; Sam reports a medium finding so we never have
  a silent halt.

## Manual verification checklist

1. Sign in as the resolved canonical admin (see "Who can use it" above —
   in local/test this is `admin@grantflow.local`; in production it is
   whatever `AGENT_CONTROL_ADMIN_EMAIL`/`ADMIN_EMAIL` is set to). Open
   Admin → Mission Control. The Agent Control Center renders at the top
   of the page.
2. Click **Start full cycle** with the default options. The card shows
   the active run id, runtime ticking, and a step-by-step timeline.
3. While the run is in flight, click **Pause**. The status badge
   transitions to `pausing` then `paused`. Click **Resume**: the
   timeline continues from the next queued step.
4. Click **Stop**. The status badge transitions to `stopping` then
   `stopped`. Queued steps end up `skipped` or `stopped`.
5. Start another full cycle, then click **Emergency stop**. Confirm the
   prompt. The status badge goes to `stopped` (or `partial_stop` if a
   long-running adapter is still finishing). The notification bell
   surfaces an `agent_control_emergency_stopped` row.
6. Sign in as a different user (e.g. `someone@example.com` with
   `is_admin = 1`). Open the same page — the Agent Control Center card
   shows a friendly "operator only" notice and every API call returns
   HTTP `403`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Lock "agent_control:full_cycle" already held` | Previous full_cycle didn't release the lock (process crashed) | The `tryAcquireLock` function already sweeps expired locks, but you can manually `DELETE FROM agent_control_locks WHERE lock_name = 'agent_control:full_cycle'` |
| Run stuck in `pausing` or `stopping` | Adapter not polling `signal.shouldStop()` / `signal.shouldPause()` | Edit the adapter to poll between every atomic operation |
| Buttons greyed out for a logged-in user | Email does not match the resolved canonical admin | Set `AGENT_CONTROL_ADMIN_EMAIL` env override or sign in as the canonical operator |
| Hamilton step counts the same task twice | `application_tasks` query returned a row that was already running | The adapter only picks up `queued` and `running` rows in a single batch; reduce `hamilton_batch_size` or add `WHERE control_run_id IS NULL` if you assign per-run task ownership |

## Related docs

- [`AGENT_MISSION_CONTROL.md`](./AGENT_MISSION_CONTROL.md) — read-only
  telemetry dashboard that sits below the Control Center.
- [`HAMILTON_AUTOMATION_AGENT.md`](./HAMILTON_AUTOMATION_AGENT.md) —
  Hamilton (Application Autopilot) details.
