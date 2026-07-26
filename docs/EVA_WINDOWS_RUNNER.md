# EVA Windows Edge Runner — Install, Selftest, Uninstall

The GrantFlow cloud server cannot open programs installed on your Windows PC, so a
small **edge runner** runs there: it launches each portfolio app, runs end-user
journeys, captures sanitized evidence, and uploads **signed** results to GrantFlow.

It lives at `tools/eva-edge-runner/`. It exposes **no general remote-command
capability** — it only reads manifests, launches declared apps, and POSTs to two
fixed coordinator endpoints (`/api/eva/ingest`, `/api/eva/heartbeat`).

## What it does (and refuses to do)

- Resolves shortcuts **without trusting their labels** — a `.lnk`/`.url` is only a
  pointer; app identity always comes from the manifest `app_id` + its repo
  (`src/resolve.mjs`).
- Uses disposable directories, databases, browser profiles, and app data.
- Allocates **non-conflicting ports** and **never kills an unknown process** to
  free one (`src/ports.mjs`).
- Starts/stops apps cleanly; bounds per-app runtime and concurrency; runs apps
  sequentially when they share ports/DBs/dirs.
- Adapters: **web** (Playwright), **cli/python/powershell** (subprocess with a
  strict argument allowlist), with electron/api/windows-ui hooks documented per
  manifest.
- Captures sanitized evidence (trace/screenshot/console/network) **by reference** —
  never raw log bodies, tokens, or full private paths.
- Signs every upload (HMAC), sends a heartbeat **even when it can't test**, and
  retries uploads in a bounded, idempotent way.
- **Catches up** after the PC wakes from sleep and missed a scheduled window.

## Prerequisites

- Node.js ≥ 20 on the Windows machine.
- For web journeys: `npm i playwright && npx playwright install chromium` inside
  `tools/eva-edge-runner/` (Playwright is an *optional* dependency — without it,
  web journeys report `blocked` naming the missing dep rather than crashing).
- If the shared `%LOCALAPPDATA%\ms-playwright` store throws "Unable to update
  lock within the stale threshold" (AV interference on the `__dirlock`), point
  EVA at its own store: set `PLAYWRIGHT_BROWSERS_PATH` (user scope, so the
  scheduled task inherits it) and re-run the install.

## Configuration (environment only — never in source)

| Variable | Meaning |
| --- | --- |
| `EVA_COORDINATOR_URL` | GrantFlow base URL (e.g. `https://grantflow-production.up.railway.app`). |
| `EVA_RUNNER_ID` | This runner's id (must match a key in the coordinator's `EVA_RUNNER_SECRETS`). |
| `EVA_RUNNER_SECRET` | The HMAC secret. **Keep it out of source control, logs, and screenshots.** |
| `EVA_RUNNER_ENV` | `local-windows` (default). |
| `EVA_RUNNER_DATA_DIR` | Where the run marker + disposable data live (default: temp). |
| `EVA_REGISTRY_PATH` | Path to `qa/portfolio-registry.json`. |
| `EVA_MANIFEST_DIR` | Path to the manifest bundle `qa/manifests/` (fallback when a repo has no `qa/user-journeys.json`). |
| `EVA_RUNNER_ONLY` | Optional comma-separated `app_id`s to restrict the run. |

On the **coordinator** side, set `EVA_RUNNER_SECRETS` (JSON `{ "<runner-id>":
"<secret>" }`) or `EVA_RUNNER_SECRET` + `EVA_RUNNER_ID`.

## Selftest (fixture apps only — no real apps, no upload)

```
cd tools/eva-edge-runner
node bin/eva-runner.mjs --selftest
```

Runs the adapters against tiny local fixture scripts (`fixtures/good-cli.mjs`,
`fixtures/bad-cli.mjs`), asserts the diagnostic bundle is produced on failure, that
a non-allowlisted process is **blocked** (not run), and that a signed payload is
accepted by the coordinator's verifier. Exit 0 = all checks passed.

## Dry run (resolve + build payload, launch nothing, upload nothing)

```
EVA_REGISTRY_PATH=.../qa/portfolio-registry.json \
EVA_MANIFEST_DIR=.../qa/manifests \
node bin/eva-runner.mjs --dry-run
```

Prints the exact v1 payload it *would* upload. Safe to run anywhere.

## Real run

```
node bin/eva-runner.mjs            # scheduled run
node bin/eva-runner.mjs --catchup  # force the wake-from-sleep catch-up path
```

Sends a `testing` heartbeat first (so a run that can't test anything is still
visible), runs each feasible app's nightly-critical journeys, then uploads. On
success it writes the ET day-key marker so the next wake knows a run already
happened today.

## Scheduling (Windows Task Scheduler)

Create a task that runs `node <path>\tools\eva-edge-runner\bin\eva-runner.mjs`
nightly (before Anya's 09:00 ET email — e.g. 04:00 ET), with **"Run task as soon as
possible after a scheduled start is missed"** enabled so a sleeping PC catches up on
wake. Example (PowerShell, run once to register):

```powershell
$action  = New-ScheduledTaskAction -Execute "node" -Argument "$HOME\GrantFlow\tools\eva-edge-runner\bin\eva-runner.mjs"
$trigger = New-ScheduledTaskTrigger -Daily -At 4:00AM
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd
Register-ScheduledTask -TaskName "EVA Portfolio QA" -Action $action -Trigger $trigger -Settings $settings
```

Set the environment variables above at machine or user scope (e.g. `setx
EVA_RUNNER_SECRET "…"` — but prefer a secret store; `setx` persists to the
registry).

## Uninstall

```powershell
Unregister-ScheduledTask -TaskName "EVA Portfolio QA" -Confirm:$false
Remove-Item Env:\EVA_RUNNER_SECRET -ErrorAction SilentlyContinue
# and clear any setx-persisted vars:
[Environment]::SetEnvironmentVariable("EVA_RUNNER_SECRET", $null, "User")
Remove-Item -Recurse -Force $env:TEMP\eva-edge-runner -ErrorAction SilentlyContinue
```

Then remove the runner secret from the coordinator's `EVA_RUNNER_SECRETS` so that
runner id can no longer upload. Because ingest is default-off, forgetting to
uninstall is harmless — with no secret configured the endpoints simply 503.

## Safety model

Every app's manifest (`qa/manifests/<app_id>.json`) declares `prohibited_actions`
and an allowlist of hosts/ports/routes/file-roots/processes. The runner uses only
synthetic fixture data. It never posts to social media, submits to app stores,
registers ISBNs, scans/deletes real directories, enters real credentials/PII/PHI,
alters real financial or clinical records, submits grant applications, or sends
real email — those are prohibited per-app and the runner has no code path that
performs them.
