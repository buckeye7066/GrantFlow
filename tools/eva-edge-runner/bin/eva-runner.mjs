#!/usr/bin/env node
// EVA Windows edge runner — CLI entry.
//
//   eva-runner --selftest     run the fixture-only selftest (no real apps, no upload)
//   eva-runner --dry-run      resolve apps + build the payload but DO NOT launch apps or upload
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
  const dryRun = args.has('--dry-run')
  const forceCatchup = args.has('--catchup')

  if (!dryRun && !cfg.secret) {
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
  if (!dryRun) {
    await sendHeartbeat({ cfg, status: 'testing', note: isCatchup ? 'catch-up run' : 'scheduled run' }).catch(() => {})
  }

  const registry = loadRegistry()
  const feasible = (registry.apps || []).filter(
    (a) => (a.runtime_status === 'available' || a.runtime_status === 'blocked_by_external_service') && (cfg.onlyApps.length === 0 || cfg.onlyApps.includes(a.app_id)),
  )

  const startedAt = new Date().toISOString()
  const appResults = []
  for (const app of feasible) {
    const manifest = loadManifest(app.local_path, app.app_id)
    if (!manifest) {
      appResults.push({ app_id: app.app_id, display_name: app.display_name, app_status: 'manual_required', blocker_reason: 'no qa/user-journeys.json manifest found', duration_ms: 0, journeys: [] })
      continue
    }
    if (app.runtime_status === 'blocked_by_external_service') {
      appResults.push({ app_id: app.app_id, display_name: app.display_name, app_status: 'blocked', blocker_reason: app.blocker || 'external service unavailable', duration_ms: 0, journeys: [] })
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
    let launch = null
    try {
      let baseUrl = app.base_url || manifest.base_url || null
      if (!dryRun && isWeb) {
        launch = await launchWebApp({ app, manifest, log: (m) => console.log(m) })
        baseUrl = launch.baseUrl || baseUrl
        if (launch.launched && !launch.ready) {
          appResults.push({
            app_id: app.app_id,
            display_name: app.display_name,
            repo: app.repo,
            app_status: 'startup_failed',
            blocker_reason: `app did not become ready at ${baseUrl || 'its declared base_url'} within the readiness timeout (start_command: ${manifest.start_command})`,
            duration_ms: Date.now() - started,
            journeys: [],
          })
          continue
        }
      }
      const journeys = await runAppJourneys({ app, manifest, baseUrl, dryRun })
      appResults.push({
        app_id: app.app_id,
        display_name: app.display_name,
        repo: app.repo,
        app_status: dryRun ? 'not_run' : 'tested',
        duration_ms: Date.now() - started,
        feature_coverage: manifest.feature_coverage || undefined,
        journeys,
      })
    } catch (err) {
      appResults.push({ app_id: app.app_id, display_name: app.display_name, app_status: 'startup_failed', blocker_reason: String(err?.message || err).slice(0, 300), duration_ms: Date.now() - started, journeys: [] })
    } finally {
      if (launch && launch.launched) {
        try {
          await launch.stop()
        } catch {
          /* best-effort teardown */
        }
      }
    }
  }

  const payload = buildPayload({
    runnerId: cfg.runnerId,
    environment: dryRun ? 'fixture' : cfg.environment,
    runId: `${cfg.runnerId}-${today}-${Date.now()}`,
    startedAt,
    completedAt: new Date().toISOString(),
    appResults,
    catchup: !!isCatchup,
  })

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2))
    console.log(`\n[eva-runner] DRY RUN — resolved ${appResults.length} app(s); nothing launched or uploaded.`)
    process.exit(0)
  }

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
