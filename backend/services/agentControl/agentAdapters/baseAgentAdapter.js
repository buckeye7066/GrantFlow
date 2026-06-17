/**
 * baseAgentAdapter.js
 *
 * Abstract contract every Agent Control Center adapter implements. Each
 * concrete adapter (sam, robert, yana, john, hamilton) wraps the
 * agent's existing service entry points and exposes a stable surface
 * the orchestrator can call.
 *
 * Required methods (each adapter overrides):
 *
 *   getStatus({ db })                — quick health snapshot, never throws
 *   start({ db, controlRunId, stepId, options, signal }) — run one cycle
 *   pause({ db, controlRunId })      — request pause (cooperative)
 *   stop({ db, controlRunId, emergency }) — request stop (cooperative or hard)
 *   resume({ db, controlRunId })     — clear pause flag
 *   health({ db })                   — same shape as getStatus, used by Sam postflight
 *
 * The orchestrator always supplies a `signal` object to `start`:
 *   signal.shouldStop()              → boolean (graceful stop requested)
 *   signal.shouldPause()             → boolean (pause requested)
 *   signal.heartbeat(progress)       → write heartbeat row + progress
 *   signal.recordEvent(args)         → write an agent_control_events row
 *   signal.isEmergency()             → boolean (emergency_stop)
 *   signal.runId                     → control_run_id
 *   signal.stepId                    → agent_control_steps.id
 *
 * Adapters MUST poll signal.shouldStop() / shouldPause() between every
 * atomic operation. Long-running loops MUST emit heartbeats at least
 * every 30 seconds so the UI can show "running" with progress.
 */

export class BaseAgentAdapter {
  constructor({ name, label, tagline } = {}) {
    if (!name) throw new Error('BaseAgentAdapter: name required')
    this.name = String(name).toLowerCase()
    this.label = label || name
    this.tagline = tagline || ''
  }

  async getStatus(_args) {
    return {
      agent_name: this.name,
      label: this.label,
      tagline: this.tagline,
      installed: true,
      enabled: true,
      running: false,
      last_run_at: null,
      last_status: null,
      queue_depth: 0,
      health: 'idle',
      notes: [],
    }
  }

  /**
   * Concrete adapters MUST override this. Returns a result envelope:
   *
   *   {
   *     ok: boolean,
   *     status: 'completed'|'failed'|'stopped'|'paused'|'blocked'|'skipped',
   *     summary: object,
   *     error?: string,
   *     blocked_reason?: string,
   *   }
   */
  async start({ controlRunId } = {}) {
    return {
      ok: false,
      status: 'failed',
      summary: { agent: this.name, control_run_id: controlRunId, reason: 'adapter_not_implemented' },
      error: `Adapter ${this.name} did not override start()`,
    }
  }

  /**
   * Cooperative pause. Default returns ok — concrete adapters override
   * if they need to flush in-flight browser sessions etc. The
   * orchestrator already writes the durable stop_request row before
   * calling this method.
   */
  async pause(_args) { return { ok: true } }

  async resume(_args) { return { ok: true } }

  /**
   * Cooperative stop. Concrete adapters may close browser sessions,
   * cancel queued jobs, or release adapters. Returns:
   *   { ok, partial, notes: [...] }
   */
  async stop(_args) { return { ok: true, partial: false, notes: [] } }

  async health(args) { return this.getStatus(args) }
}

/**
 * Lightweight signal factory the orchestrator uses to pass a stop/pause
 * polling surface plus heartbeat / event helpers down to adapters.
 */
export function makeSignal({
  runId,
  stepId,
  agentName,
  shouldStop = () => false,
  shouldPause = () => false,
  isEmergency = () => false,
  heartbeat = async () => {},
  recordEvent = async () => {},
} = {}) {
  return {
    runId,
    stepId,
    agentName,
    shouldStop,
    shouldPause,
    isEmergency,
    heartbeat: async (progress) => heartbeat(progress),
    recordEvent: async (args) => recordEvent(args),
  }
}
