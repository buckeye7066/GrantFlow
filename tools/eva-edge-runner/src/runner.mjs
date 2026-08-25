// Edge-runner orchestrator. Builds a v1 result payload by running each app's
// declared journeys through the right adapter. Sequential across apps that share
// a concurrency class / scarce resource; bounded per-app runtime. Failure
// confirmation (preserve first evidence, reset, retry <=2, classify) is applied
// per journey.
import { runCliJourney } from './adapters/cli.mjs'
import { runWebJourney } from './adapters/web.mjs'
import { RUNNER_SEMVER } from './config.mjs'
import { redactDiagnosticValue } from './redact.mjs'

const EVA_SCHEMA_VERSION = 1
const BLOCKER_REASON_CAP = 500

function schemaSafeRunnerVersion(value) {
  const candidate = typeof value === 'string' ? value.trim() : ''
  if (candidate.length <= 32 && /^[0-9]+[.][0-9]+[.][0-9]+(?:-[0-9A-Za-z.-]+)?(?:[+][0-9A-Za-z.-]+)?$/.test(candidate)) {
    return candidate
  }
  return RUNNER_SEMVER
}

function schemaSafeAppResult(app, redactionValues = []) {
  if (!app || typeof app !== 'object') return app
  // JSON Schema optional fields are optional, not nullable. Builders from
  // rolling runner versions have emitted null for absent diagnostics; remove
  // null/undefined recursively at the final transport choke point.
  const pruneAbsent = (value) => {
    if (Array.isArray(value)) return value.filter((item) => item != null).map(pruneAbsent)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child != null)
        .map(([key, child]) => [key, pruneAbsent(child)]),
    )
  }
  // Redaction is intentionally at the same final choke point as schema
  // cleanup. Startup logs, browser failures, adapter exceptions, and future
  // outcome builders therefore cannot bypass it.
  const safe = pruneAbsent(redactDiagnosticValue(app, { sensitiveValues: redactionValues }))
  delete safe.git_state
  delete safe.stale_tree
  if (typeof safe.blocker_reason === 'string') {
    safe.blocker_reason = safe.blocker_reason.slice(0, BLOCKER_REASON_CAP)
  }
  if (Array.isArray(safe.journeys)) {
    safe.journeys = safe.journeys.map((journey) => {
      if (!journey || typeof journey !== 'object') return journey
      const safeJourney = { ...journey }
      delete safeJourney.stale_tree
      return safeJourney
    })
  }
  return safe
}

// Run a single journey with failure confirmation: on failure, retry up to twice,
// then classify reproducible vs intermittent. Never turns an intermittent
// failure into a clean pass.
async function runJourneyWithConfirmation(runOne, journey) {
  const first = await runOne()
  if (first.status !== 'failed') return first

  const retries = []
  for (let i = 0; i < 2; i++) {
    // eslint-disable-next-line no-await-in-loop
    const again = await runOne()
    retries.push(again.status)
    if (again.status === 'failed') continue
    // It passed on retry -> INTERMITTENT, not a clean pass. Keep the first
    // failure's evidence and report it as intermittent.
    return { ...first, retry_classification: 'intermittent' }
  }
  // Failed all attempts -> reproducible.
  return { ...first, retry_classification: 'reproducible' }
}

// Run every journey for one app via its runtime adapter.
export async function runAppJourneys({ app, manifest, baseUrl = null, captureDir = null, launchEnv = {} }) {
  const journeys = []
  const critical = manifest?.nightly_critical_journeys || []
  const journeyDefs = (manifest?.journeys || []).filter((j) => critical.length === 0 || critical.includes(j.id))

  const CLI_RUNTIMES = new Set(['cli', 'python-cli', 'powershell'])
  const WEB_RUNTIMES = new Set(['web', 'mobile-web'])

  for (const jd of journeyDefs) {
    let runOne
    if (WEB_RUNTIMES.has(manifest.runtime_type)) {
      runOne = () => runWebJourney({ baseUrl, journey: jd, captureDir })
    } else if (CLI_RUNTIMES.has(manifest.runtime_type) && jd.command) {
      runOne = () => runCliJourney({ manifest, journey: jd, launchEnv })
    } else {
      // No adapter yet for this runtime (electron/api/windows-ui) or a journey
      // with no runnable command. Report BLOCKED with the reason — never a
      // fabricated pass, never a crash.
      journeys.push({
        journey_id: jd.id,
        name: jd.name,
        status: 'blocked',
        route_or_control: jd.id,
        observed_behavior: `no runner adapter for runtime_type "${manifest.runtime_type}" (adapter harness pending)`,
        duration_ms: 0,
      })
      continue
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await runJourneyWithConfirmation(runOne, jd)
    journeys.push(result)
  }
  return journeys
}

// Assemble a full v1 payload from a list of app-run fragments.
export function buildPayload({
  runnerId,
  runnerVersion = RUNNER_SEMVER,
  environment,
  appResults,
  startedAt,
  completedAt,
  runId,
  catchup = false,
  redactionValues = [],
}) {
  return {
    schema_version: EVA_SCHEMA_VERSION,
    run_id: runId,
    runner_id: runnerId,
    runner_version: schemaSafeRunnerVersion(runnerVersion),
    environment,
    catchup,
    started_at: startedAt,
    completed_at: completedAt,
    // Defense in depth for rolling upgrades: old git-truth code emitted these
    // non-schema fields. Strip them at the final payload choke point even when
    // an app result bypasses the normal provenance annotator.
    apps: (appResults || []).map((app) => schemaSafeAppResult(app, redactionValues)),
  }
}
