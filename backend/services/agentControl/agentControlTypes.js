/**
 * agentControlTypes.js
 *
 * Shared constants for the Admin Agent Control Center. Pure data — no
 * I/O, no env reads. Safe to import from anywhere (frontend, backend,
 * tests, scripts).
 *
 * The server resolves the operator from environment configuration. This
 * source-safe default exists only for local/test attribution.
 */

export const CANONICAL_ADMIN_EMAIL_DEFAULT = 'admin@grantflow.local'

/**
 * The five canonical agents the Control Center coordinates. Yana =
 * Client Discovery (lead intelligence). Hamilton = Application Autopilot
 * (funding completion). The two are SEPARATE agents and must not be
 * confused.
 */
export const ALL_AGENTS = Object.freeze(['sam', 'robert', 'yana', 'john', 'hamilton'])

// Agents surfaced in the Control-Center STATUS view. Anya is included for
// observability (agent-observability rule) but is NOT in ALL_AGENTS because she
// is interactive/on-demand — she is never started/stopped or run in the
// automated full-cycle. start/stop validate against ALL_AGENTS; status reads
// STATUS_AGENTS.
export const STATUS_AGENTS = Object.freeze([...ALL_AGENTS, 'anya'])

export const AGENT_LABELS = Object.freeze({
  sam: 'Sam',
  robert: 'Robert',
  yana: 'Yana',
  john: 'John',
  hamilton: 'Hamilton',
})

export const AGENT_TAGLINES = Object.freeze({
  sam: 'Production Readiness / Audit',
  robert: 'Funding Discovery',
  yana: 'Client Discovery (lead intelligence)',
  john: 'Outreach Drafts (Outlook)',
  hamilton: 'Application Autopilot / Funding Completion',
})

/**
 * Default order for full_cycle. Sam runs first (preflight) and last
 * (postflight) wrapping the rest. The orchestrator builds steps from
 * this list, plus an optional final 'sam_postflight' step.
 */
export const FULL_CYCLE_ORDER = Object.freeze(['sam', 'robert', 'yana', 'john', 'hamilton'])

export const RUN_TYPES = Object.freeze([
  'full_cycle',
  'selected_agents',
  'sam_only',
  'robert_only',
  'yana_only',
  'john_only',
  'hamilton_only',
  'scheduled_cycle',
])

export const RUN_STATUSES = Object.freeze([
  'queued',
  'running',
  'pausing',
  'paused',
  'stopping',
  'stopped',
  'completed',
  // Run executed cleanly but no agent persisted any real work — reported
  // honestly instead of a hollow "completed".
  'completed_noop',
  'failed',
  'cancelled',
  'partial_stop',
  'stop_failed',
])

export const STEP_STATUSES = Object.freeze([
  'queued',
  'running',
  'paused',
  'stopping',
  'stopped',
  'completed',
  'failed',
  'skipped',
  'blocked',
])

export const STOP_REQUEST_TYPES = Object.freeze([
  'pause',
  'resume',
  'graceful_stop',
  'emergency_stop',
  'cancel',
])

/**
 * Notification types. Every lifecycle transition emits one of these so
 * the canonical admin sees what is happening, and so the audit timeline
 * can render the same events.
 */
export const CONTROL_NOTIFICATION_TYPES = Object.freeze([
  'agent_control_started',
  'agent_control_completed',
  'agent_control_failed',
  'agent_control_paused',
  'agent_control_resumed',
  'agent_control_stopped',
  'agent_control_emergency_stopped',
  'agent_control_agent_failed',
  'agent_control_agent_blocked',
  'agent_control_sam_critical',
])

/**
 * Default options shape for a Start Control Run request body. Keep this
 * permissive — agents fall back to safe defaults when an option is
 * missing — but the explicit keys make the API surface discoverable.
 */
export const DEFAULT_RUN_OPTIONS = Object.freeze({
  dry_run: false,
  run_sam_preflight: true,
  run_sam_postflight: true,
  allow_john_drafts: true,
  allow_john_send: false,
  allow_robert_ingest: true,
  allow_yana_leads: true,
  allow_hamilton_autopilot: true,
  max_runtime_minutes: 60,
  stop_on_critical_sam_finding: true,
  stop_on_agent_failure: false,
})

/**
 * Lock names. Single full_cycle: 'agent_control:full_cycle'. Per-agent
 * single-flight: 'agent_control:agent:<name>'.
 */
export const FULL_CYCLE_LOCK = 'agent_control:full_cycle'
export const agentLockName = (name) => `agent_control:agent:${String(name || '').toLowerCase()}`

/**
 * Map run_type to the resolved agent list. The orchestrator uses this to
 * derive which steps to create for any given run shape.
 */
export function resolveAgentsForRun(runType, requestedAgents = []) {
  switch (runType) {
    case 'full_cycle':
    case 'scheduled_cycle':
      return [...FULL_CYCLE_ORDER]
    case 'selected_agents': {
      const set = new Set(
        (Array.isArray(requestedAgents) ? requestedAgents : [])
          .map((a) => String(a || '').toLowerCase())
          .filter((a) => ALL_AGENTS.includes(a)),
      )
      return FULL_CYCLE_ORDER.filter((a) => set.has(a))
    }
    case 'sam_only': return ['sam']
    case 'robert_only': return ['robert']
    case 'yana_only': return ['yana']
    case 'john_only': return ['john']
    case 'hamilton_only': return ['hamilton']
    default: return []
  }
}
