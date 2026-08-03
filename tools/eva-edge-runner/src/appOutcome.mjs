// Pure builders for the two honest "this app was not tested" outcomes.
//
// The distinction they encode is the whole point of the module:
//
//   BLOCKED        — the app cannot run on this machine until a NAMED
//                    prerequisite exists (Docker daemon, a DATABASE_URL). This
//                    is not a defect in the app and must never be rendered as a
//                    critical, never-passing user-journey failure. It carries a
//                    `blocked` startup journey so no new finding is minted each
//                    night and any pre-existing one ages out to `stale`.
//
//   STARTUP_FAILED — the app SHOULD start here and did not. That is a real
//                    defect, keeps its critical `failed` startup journey, and
//                    now quotes the process's own output so the owner sees WHY.
import { describeUnmet } from './prereq.mjs'

const STARTUP_JOURNEY_ID = 'app-startup'
const STARTUP_JOURNEY_NAME = 'App process starts and answers its readiness probe'

/** An app whose declared prerequisites are not met on this machine. */
export function blockedAppResult({ app, manifest, unmet, durationMs = 0 }) {
  const summary = describeUnmet(unmet)
  const reason = `prerequisite not available on this runner: ${summary}`
  return {
    app_id: app.app_id,
    display_name: app.display_name,
    repo: app.repo,
    app_status: 'blocked',
    blocker_reason: reason.slice(0, 600),
    duration_ms: durationMs,
    journeys: [
      {
        journey_id: STARTUP_JOURNEY_ID,
        name: STARTUP_JOURNEY_NAME,
        status: 'blocked',
        route_or_control: manifest?.start_command || STARTUP_JOURNEY_ID,
        observed_behavior: reason.slice(0, 600),
        duration_ms: durationMs,
      },
    ],
  }
}

/** An app that should have started here but did not. */
export function startupFailedAppResult({ app, manifest, launch = {}, baseUrl = null, durationMs = 0 }) {
  const probeUrl = launch.failedProbeUrl || baseUrl || manifest?.base_url || 'its declared base_url'
  const tail = typeof launch.outputTail === 'function' ? launch.outputTail() : ''
  const exited = Array.isArray(launch.exitInfos) && launch.exitInfos.every(Boolean)
  // Two causes the raw output tail cannot state for itself, both fixable in one
  // line once NAMED: the manifest probes a port the app does not bind (port
  // drift), and a port EVA refused to clear because shared infrastructure owns
  // it. Without these an owner reads "not ready at http://localhost:3001/healthz"
  // every night and has to re-derive the cause each time.
  const drift = Array.isArray(launch.portDrift) ? launch.portDrift : []
  const blocked = Array.isArray(launch.blockedPorts) ? launch.blockedPorts : []
  const reason = [
    `app did not answer its readiness probe at ${probeUrl} within the readiness timeout`,
    `(start_command: ${manifest?.start_command})`,
    exited ? '— the start_command exited' : '',
    drift.length
      ? `— MANIFEST PORT DRIFT: the app announced port(s) ${drift.join(', ')} but the manifest declares ${(launch.declaredPorts || []).join(', ') || 'none'}; fix readiness_probe.port/base_url (and pin the port in launch_env)`
      : '',
    blocked.length
      ? `— PORT HELD BY A PROTECTED PROCESS: ${blocked
          .map((b) => `${b.port} (${b.blockedBy.map((p) => p.name).filter(Boolean).join(', ') || 'unknown'})`)
          .join('; ')}; EVA does not kill shared infrastructure it did not start — move this app to a free port`
      : '',
    tail ? `— last output: ${tail}` : '— the process printed nothing',
  ]
    .filter(Boolean)
    .join(' ')
  return {
    app_id: app.app_id,
    display_name: app.display_name,
    repo: app.repo,
    app_status: 'startup_failed',
    blocker_reason: reason.slice(0, 600),
    duration_ms: durationMs,
    journeys: [
      {
        journey_id: STARTUP_JOURNEY_ID,
        name: STARTUP_JOURNEY_NAME,
        status: 'failed',
        severity: 'critical',
        retry_classification: 'reproducible',
        failure_class: 'startup-failed',
        route_or_control: probeUrl,
        error_signature: (tail || reason).slice(0, 200),
        expected_behavior: 'the declared start_command brings the app up within the readiness timeout',
        observed_behavior: reason.slice(0, 500),
        user_impact: 'no journey can run while the app cannot start',
        repro_steps: [`run: ${String(manifest?.start_command).slice(0, 120)}`, `poll ${probeUrl} until the timeout`],
        diagnostic_confidence: tail ? 0.9 : 0.7,
        missing_evidence: tail ? null : 'the start_command produced no output — inspect it interactively in the app repo',
        duration_ms: durationMs,
      },
    ],
  }
}
