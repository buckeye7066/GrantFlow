# EVA Windows Edge Runner — Install, Selftest, Uninstall

The GrantFlow cloud server cannot open programs installed on your Windows PC, so a
small **edge runner** runs there: it launches each portfolio app, runs end-user
journeys, captures sanitized diagnostics, and uploads **signed** results to GrantFlow.

It lives at `tools/eva-edge-runner/`. It exposes **no general remote-command
capability** — it only reads manifests, launches declared apps, and POSTs to two
fixed coordinator endpoints (`/api/eva/ingest`, `/api/eva/heartbeat`).

## What it does (and refuses to do)

- Resolves shortcuts **without trusting their labels** — a `.lnk`/`.url` is only a
  pointer; app identity always comes from the manifest `app_id` + its repo
  (`src/resolve.mjs`).
- Fetches each repository and runs the exact clean `origin/main` commit in an
  independent EVA-owned clone. It never switches, resets, cleans, stashes,
  fetches, or writes Git metadata in a developer checkout.
- Uses disposable directories, databases, browser profiles, and app data. A
  declared `disposable_data_root` is emptied before each isolated run.
- Uses manifest-pinned ports and refuses to launch when any pre-existing process
  owns one. Teardown kills only process trees EVA launched; it never kills an
  unrelated process merely because its image is Node, Python, or Docker.
- Starts/stops apps through their declared lifecycle commands, bounds readiness
  and journey waits, and runs the portfolio sequentially.
- Adapters: **web** (Playwright), **cli/python/powershell** (subprocess with a
  strict argument allowlist), with electron/api/windows-ui hooks documented per
  manifest.
- Redacts startup and orchestration diagnostics before upload. Evidence fields
  are emitted only for artifacts an adapter actually captured; the runner does
  not claim nonexistent trace/screenshot/console/network files.
- Signs every upload (HMAC), sends a heartbeat **even when it can't test**, and
  retries uploads in a bounded, idempotent way.
- **Catches up** after the PC wakes from sleep and missed a scheduled window.

## Prerequisites

- Node.js ≥ 20 for the edge runner. Each app's exact `engines.node` contract is
  checked before launch; an app requiring a newer major version (currently
  GeneMap requires Node ≥ 24) is reported blocked with the required version.
- Git and Node.js must be available to the scheduled-task account.
- The installer runs `npm ci` in its dedicated checkout. For web journeys,
  Chromium must also be installed for Playwright; without it, web journeys
  report `blocked` rather than crashing.
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
| `EVA_RUNNER_DATA_DIR` | Where the run marker, independent app clones, lockfile-keyed dependency state, and disposable data live. The installer defaults this to `%LOCALAPPDATA%\GrantFlow\EVA\data`. |
| `EVA_REGISTRY_PATH` | Path to `qa/portfolio-registry.json`. |
| `EVA_MANIFEST_DIR` | Path to the canonical manifest bundle `qa/manifests/`. When configured, a missing or malformed canonical manifest fails closed; it never falls back to a stale repo-owned copy. |
| `EVA_RUNNER_ONLY` | Optional comma-separated `app_id`s to restrict the run. |
| `EVA_APP_ENV` | JSON `{"<app_id>": {"VAR": "value"}}` — per-app secrets the runner supplies at launch (e.g. a disposable `DATABASE_URL`). Highest precedence; never in source. |
| `EVA_APP_ENV_FILE` | Path to a JSON file of the same shape, for values too long or too secret for an env var. |

On the **coordinator** side, set `EVA_RUNNER_SECRETS` (JSON `{ "<runner-id>":
"<secret>" }`) or `EVA_RUNNER_SECRET` + `EVA_RUNNER_ID`.

## Startup: BLOCKED vs STARTUP-FAILED (these are different facts)

Manifests declare what an app needs to boot. The runner now honors that
declaration instead of launching blind:

| Manifest field | Effect |
| --- | --- |
| `launch_env` | Literal, non-secret env supplied at launch (`PROMO_ENABLED=false`, `PORT`, `DISABLE_AI=1`). |
| `launch_env_generated` | `{"ADMIN_TOKEN": "token"}` → a **fresh random value per run**. Never committed, never reused. |
| `prerequisites` | `[{id, type, name, remedy, …}]` checked BEFORE launch. Types: `env` (a var with no safe default), `docker` (daemon reachable), `tcp` (`{host, port}`), `executable` (`{command,args}`), and `node-engine` (`{range}`). Runtime executables are also inferred from declared start/journey commands, and `engines.node` is read from the exact isolated workspace. An **unknown type is treated as unmet** — an unverifiable claim is not a met prerequisite. |
| `disposable_data_root` | Created inside the app's own repo before launch (an escaping/absolute root is refused). |

Outcomes:

- **`blocked`** — a declared prerequisite is not available on this machine. The
  `blocker_reason` NAMES the missing thing and its remedy, and the synthetic
  `app-startup` journey is reported `blocked`, so no new critical finding is
  minted each night and any pre-existing one ages out to `stale`. This is the
  same honest state Factory Deck uses for "Anthropic credits empty".
- **`startup_failed`** — the app *should* start here and did not. Still a
  critical finding, but the reason now quotes **the process's own output** and
  the **probe URL that actually failed** (previously it always named `base_url`,
  even when the failing probe was the backend's health port).

Precedence for launch env, low → high: a minimal allowlist of OS/package-manager
variables → `launch_env` → `launch_env_generated` →
`EVA_APP_ENV[app_id]`. Runner credentials, production database URLs, and paid
API keys are not inherited by child apps. Every name in `required_env` is
checked before launch; secrets with no safe fixture value belong in
`EVA_APP_ENV` or `EVA_APP_ENV_FILE`.

Guard tests: `tests/unit/eva-runner-startup-outcomes.test.mjs` (run by
`npm run unit`; mutation-verified).

## Selftest (fixture apps only — no real apps, no upload)

```
cd tools/eva-edge-runner
node bin/eva-runner.mjs --selftest
```

Runs the adapters against tiny local fixture scripts (`fixtures/good-cli.mjs`,
`fixtures/bad-cli.mjs`), asserts the diagnostic bundle is produced on failure, that
a non-allowlisted process is **blocked** (not run), and that a signed payload is
accepted by the coordinator's verifier. Exit 0 = all checks passed.

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

Install the versioned bootstrap once from a clean GrantFlow `origin/main`
checkout. It creates an EVA-owned clone under `%LOCALAPPDATA%\GrantFlow\EVA`,
updates that clone to the exact `origin/main` on every run, installs dependencies
when the lockfile changes, repairs the Playwright Chromium installation on every
preparation, and registers the 04:00 task with wake catch-up. A new revision must
pass unit tests and the fixture selftest before it sees credentials. If a scheduled
candidate fails, the bootstrap checks out and re-tests the saved last-known-good
commit; installation with `-PrepareOnly` still fails closed rather than accepting a
rejected candidate:

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  "$HOME\GrantFlow\tools\eva-edge-runner\bin\install-eva-task.ps1"
```

Do not point Task Scheduler directly at `$HOME\GrantFlow`: that is a mutable
developer checkout and may be dirty, behind, or on a feature branch. The
bootstrap refuses to run if it cannot fetch and verify the exact clean
`origin/main` revision.

Set the environment variables above at machine or user scope (e.g. `setx
EVA_RUNNER_SECRET "…"` — but prefer a secret store; `setx` persists to the
registry).

## Uninstall

```powershell
Unregister-ScheduledTask -TaskName "EVA Portfolio QA" -Confirm:$false
Remove-Item Env:\EVA_RUNNER_SECRET -ErrorAction SilentlyContinue
# and clear any setx-persisted vars:
[Environment]::SetEnvironmentVariable("EVA_RUNNER_SECRET", $null, "User")
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\GrantFlow\EVA" -ErrorAction SilentlyContinue
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
