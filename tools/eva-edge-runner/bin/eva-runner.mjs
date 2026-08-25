#!/usr/bin/env node
// EVA Windows edge runner — CLI entry.
//
//   eva-runner --selftest     run the fixture-only selftest (no real apps, no upload)
//   eva-runner                a real run: launch feasible apps, run journeys, upload signed results
//   eva-runner --catchup      force the wake-from-sleep catch-up path
//
// The runner exposes NO general remote-command capability: it only reads
// manifests, launches declared apps, and POSTs signed results/heartbeats to two
// fixed coordinator endpoints. The HMAC secret is read from EVA_RUNNER_SECRET
// (env only) and never logged.
import { runSelftest } from '../src/selftest.mjs'
import { loadRunnerConfig, ensureDataDir, readMarker, writeMarker, loadRegistry, loadManifest, etDayKey } from '../src/config.mjs'
import { runAppJourneys, buildPayload } from '../src/runner.mjs'
import { launchWebApp } from '../src/launcher.mjs'
import { resolveLaunchEnv, checkPrerequisites } from '../src/prereq.mjs'
import { blockedAppResult, startupFailedAppResult, orchestrationFailedAppResult } from '../src/appOutcome.mjs'
import { prepareTestWorkspace, annotateAppResultWithGitState, describeGitState } from '../src/gitState.mjs'
import { uploadResult, sendHeartbeat } from '../src/uploader.mjs'

const WEB_RUNTIMES = new Set(['web', 'mobile-web'])

const args = new Set(process.argv.slice(2))

async function main() {
  if (args.has('--selftest')) {
    const res = await runSelftest({ verbose: true })
    console.log(`\n[selftest] ${res.ok ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} (${res.checks.filter((c) => c.ok).length}/${res.checks.length})`)
    process.exit(res.ok ? 0 : 1)
  }

  const cfg = loadRunnerConfig()
  ensureDataDir(cfg)
  // NO DRY RUNS (owner order 2026-08-13, permanent): every run of this tool does
  // REAL work. The flag is removed OUTRIGHT rather than ignored — an invocation
  // naming it FAILS loudly, so a scheduled task or launcher still passing it is
  // surfaced instead of silently doing a real run the caller did not expect.
  if (args.has('--dry-run') || args.has('--dryrun') || args.has('--report-only')) {
    console.error('[eva-runner] --dry-run was REMOVED: every run does real work. Re-invoke without it.')
    process.exit(2)
  }
  const forceCatchup = args.has('--catchup')

  if (!cfg.secret) {
    console.error('[eva-runner] EVA_RUNNER_SECRET is not set — cannot sign uploads. Set it in the environment (never in source).')
    // Still send a heartbeat is impossible without the secret; exit non-zero.
    process.exit(2)
  }

  // Catch-up decision: if the last successful run was for an earlier ET day and
  // the machine just woke, this run counts as a catch-up.
  const marker = readMarker(cfg)
  const today = etDayKey()
  const isCatchup = forceCatchup || (marker && marker.day && marker.day !== today)

  // Always send a heartbeat first, so even a run that ultimately can't test
  // anything is visible at the coordinator.
  {
    await sendHeartbeat({ cfg, status: 'testing', note: isCatchup ? 'catch-up run' : 'scheduled run' }).catch(() => {})
  }

  const registry = loadRegistry()
  const feasible = (registry.apps || []).filter(
    (a) => (a.runtime_status === 'available' || a.runtime_status === 'blocked_by_external_service') && (cfg.onlyApps.length === 0 || cfg.onlyApps.includes(a.app_id)),
  )

  const startedAt = new Date().toISOString()
  const appResults = []
  // Exact generated/owner-supplied secrets are retained only in memory long
  // enough for buildPayload's global redaction choke point. They are never
  // attached to an app result or written to disk/logs.
  const redactionValues = new Set()
  for (const app of feasible) {
    const appStartedAt = Date.now()
    let outerGitState = null
    let outerGitSync = null
    try {
    // Test the SHIPPED commit, not whichever branch happens to be open on the
    // Windows desktop. prepareTestWorkspace creates/reuses an independent clean
    // clone at origin/main and installs dependencies from that revision's
    // lockfile, never mutating the developer checkout. If a git
    // repo is stale and the clean snapshot cannot be prepared, the run is
    // BLOCKED as runner infrastructure — its results are not filed as app bugs.
    const workspace = prepareTestWorkspace(app.local_path, app.app_id, { dataDir: cfg.dataDir, expectedRepo: app.repo })
    const gitState = {
      ...workspace.state,
      dependency_setup: workspace.dependency_setup,
    }
    const gitSync = workspace.sync
    outerGitState = gitState
    outerGitSync = gitSync
    console.log(`[git] ${app.app_id}: ${describeGitState(gitState)}`)
    const pushResult = (result) => appResults.push(annotateAppResultWithGitState(result, gitState, gitSync))

    if (!workspace.ok) {
      const reason = `clean authoritative test snapshot unavailable: ${workspace.reason}`
      pushResult({
        app_id: app.app_id,
        display_name: app.display_name,
        repo: app.repo,
        app_status: 'blocked',
        blocker_reason: reason.slice(0, 500),
        duration_ms: 0,
        journeys: [{
          journey_id: 'app-source-snapshot',
          name: 'Runner prepares the authoritative main revision',
          status: 'blocked',
          route_or_control: app.repo || app.local_path,
          observed_behavior: reason.slice(0, 500),
          duration_ms: 0,
        }],
      })
      continue
    }

    const testApp = { ...app, local_path: workspace.cwd }

    let manifest = loadManifest(workspace.cwd, app.app_id)
    if (!manifest) {
      const reason = 'canonical journey manifest is missing; execution failed closed'
      pushResult({
        app_id: app.app_id,
        display_name: app.display_name,
        repo: app.repo,
        app_status: 'manual_required',
        blocker_reason: reason,
        duration_ms: 0,
        journeys: [{
          journey_id: 'manifest-contract',
          name: 'Canonical journey manifest resolves',
          status: 'blocked',
          route_or_control: app.app_id,
          observed_behavior: reason,
          duration_ms: 0,
        }],
      })
      continue
    }
    // A manifest's committed local_path is portable source metadata. The
    // runner's resolved isolated workspace must win at execution time.
    manifest = { ...manifest, local_path: workspace.cwd, __eva_isolated_workspace: workspace.isolated }
    if (app.runtime_status === 'blocked_by_external_service') {
      const reason = app.blocker || 'external service unavailable'
      pushResult({
        app_id: app.app_id,
        display_name: app.display_name,
        repo: app.repo,
        app_status: 'blocked',
        blocker_reason: reason,
        duration_ms: 0,
        journeys: [{
          journey_id: 'external-service',
          name: 'Required external service is available',
          status: 'blocked',
          route_or_control: app.app_id,
          observed_behavior: reason,
          duration_ms: 0,
        }],
      })
      continue
    }
    // Launch real apps the way each manifest declares: for web apps, spawn the
    // start_command in the app's repo, wait for the readiness_probe to answer,
    // run the journeys against the live server, then stop the process tree. Web
    // journeys used to run against a base_url with nothing listening, so every
    // one failed with ERR_CONNECTION_REFUSED even for healthy apps. CLI apps run
    // their declared command directly via the cli adapter (no server to boot).
    const started = Date.now()
    const isWeb = WEB_RUNTIMES.has(manifest.runtime_type)

    // Prerequisites BEFORE launch. An app that cannot run on this machine
    // (Docker stopped, no DATABASE_URL) is BLOCKED with the missing thing
    // named — never a critical, never-passing user-journey failure. Supplying
    // the declared launch env is the other half: manifests always declared
    // `required_env` and the runner never provided any of it, so apps that
    // refuse to boot without a value looked broken when they were merely
    // unconfigured.
    const resolvedLaunch = resolveLaunchEnv({ app: testApp, manifest })
    const launchEnv = resolvedLaunch.env
    for (const value of resolvedLaunch.sensitiveValues || []) redactionValues.add(value)
    {
      const pre = await checkPrerequisites({ manifest, resolvedEnv: launchEnv })
      if (pre.unmet.length) {
        pushResult(blockedAppResult({ app: testApp, manifest, unmet: pre.unmet, durationMs: Date.now() - started }))
        continue
      }
    }

    let launch = null
    try {
      let baseUrl = app.base_url || manifest.base_url || null
      // Startup itself is reported as a synthetic journey ('app-startup',
      // failure_class 'startup-failed'). This gives startup failures the SAME
      // dedup + lifecycle as any other finding — and, crucially, a night where
      // the app boots records a PASS that resolves the open startup finding.
      // With `journeys: []` those findings could never resolve and re-rendered
      // in the owner's email forever ("recurring", last pass never).
      let startupJourney = null
      if (isWeb) {
        launch = await launchWebApp({ app: testApp, manifest, launchEnv, log: (m) => console.log(m) })
        baseUrl = launch.baseUrl || baseUrl
        if (launch.launched && !launch.ready) {
          pushResult(startupFailedAppResult({ app: testApp, manifest, launch, baseUrl, durationMs: Date.now() - started }))
          continue
        }
        if (launch.launched && launch.ready) {
          startupJourney = {
            journey_id: 'app-startup',
            name: 'App process starts and answers its readiness probe',
            status: 'passed',
            duration_ms: Date.now() - started,
          }
        }
      }
      const journeys = await runAppJourneys({ app: testApp, manifest, baseUrl, launchEnv })
      if (startupJourney) journeys.unshift(startupJourney)
      journeys.unshift({
        journey_id: 'runner-orchestration',
        name: 'Runner completes declared journey orchestration',
        status: 'passed',
        duration_ms: Date.now() - started,
      })
      pushResult({
        app_id: app.app_id,
        display_name: app.display_name,
        repo: app.repo,
        app_status: 'tested',
        duration_ms: Date.now() - started,
        feature_coverage: manifest.feature_coverage || undefined,
        journeys,
      })
    } catch (err) {
      pushResult(orchestrationFailedAppResult({ app: testApp, error: err, durationMs: Date.now() - started }))
    } finally {
      if (launch && launch.launched) {
        try {
          await launch.stop()
        } catch {
          /* best-effort teardown */
        }
      }
    }
    } catch (err) {
      // Preparation, manifest loading, environment resolution, and prerequisite
      // probes are all per-app work. One malformed app must yield a stable
      // schema-complete runner finding and never erase the rest of the fleet.
      const failure = orchestrationFailedAppResult({ app, error: err, durationMs: Date.now() - appStartedAt })
      appResults.push(outerGitState
        ? annotateAppResultWithGitState(failure, outerGitState, outerGitSync)
        : failure)
    }
  }

  const payload = buildPayload({
    runnerId: cfg.runnerId,
    runnerVersion: cfg.version,
    environment: cfg.environment,
    runId: `${cfg.runnerId}-${today}-${Date.now()}`,
    startedAt,
    completedAt: new Date().toISOString(),
    appResults,
    catchup: !!isCatchup,
    redactionValues: [...redactionValues],
  })

  const up = await uploadResult({ cfg, payload })
  if (up.ok) {
    writeMarker(cfg, { day: today, at: new Date().toISOString(), run_id: payload.run_id })
    await sendHeartbeat({ cfg, status: 'ok', note: `uploaded ${appResults.length} apps` }).catch(() => {})
    console.log(`[eva-runner] uploaded run ${payload.run_id} (${up.status}, ${up.attempts} attempt(s)).`)
    process.exit(0)
  }
  await sendHeartbeat({ cfg, status: 'blocked', note: `upload failed: ${up.error}` }).catch(() => {})
  console.error(`[eva-runner] upload failed: ${up.status} ${up.error}`)
  process.exit(1)
}

main().catch((err) => {
  console.error('[eva-runner] fatal:', err?.message || err)
  process.exit(1)
})
