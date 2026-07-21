/**
 * Agent Mission Control — shared types and constants.
 *
 * Pure-data module — no I/O, no env reads. Safe to import from anywhere.
 *
 * Seven canonical agent names map onto seven concerns:
 *   - anya     user/admin assistant + workflow helper
 *   - sam      production readiness / code health
 *   - robert   funding discovery + recommendation
 *   - yana     client discovery / lead intelligence  (NOT autopilot)
 *   - hamilton application autopilot / funding completion (separate
 *              agent — do NOT confuse with Yana lead discovery)
 *   - john     outreach drafting (Outlook drafts)
 *   - amy      synthetic crawler training + fleet gap learning (unified
 *              events only — Amy has no per-agent dashboard panel; her gap
 *              scoreboard / wishlist events flow to Sam's checks and Anya's
 *              morning report per the Agent Observability Rule)
 *
 * The dashboard never assumes per-agent tables exist. The unified
 * `agent_activity_events` table is always queried first, agent-specific
 * tables are read only when a `tableExists` check returns true.
 */

export const AGENT_NAMES = Object.freeze(['anya', 'sam', 'robert', 'yana', 'hamilton', 'john', 'amy', 'eva'])

export const AGENT_LABELS = Object.freeze({
  anya: 'Anya',
  sam: 'Sam',
  robert: 'Robert',
  yana: 'Yana',
  hamilton: 'Hamilton',
  john: 'John',
  amy: 'Amy',
  eva: 'EVA',
})

export const AGENT_TAGLINES = Object.freeze({
  anya: 'User Assistance',
  sam: 'Production Readiness',
  robert: 'Funding Discovery',
  yana: 'Client Discovery',
  hamilton: 'Application Autopilot / Funding Completion',
  john: 'Outreach Drafts',
  amy: 'Crawler Training / Fleet Gap Learning',
  eva: 'End-user Validation / Portfolio User-Journey QA',
})

export const RANGE_KEYS = Object.freeze(['24h', '7d', '30d', 'custom'])

export const STATUS_VALUES = Object.freeze([
  'queued',
  'running',
  'succeeded',
  'failed',
  'blocked',
  'warning',
  'info',
])

export const SEVERITY_VALUES = Object.freeze([
  'critical',
  'high',
  'medium',
  'low',
  'info',
])

/**
 * High-level event_type values produced by the dashboard for events the
 * aggregator synthesises from agent-specific tables (so the timeline can
 * render even when the agent has not migrated to emitting unified
 * `agent_activity_events` rows yet).
 */
export const SYNTHETIC_EVENT_TYPES = Object.freeze({
  RUN_COMPLETED: 'run_completed',
  RUN_FAILED: 'run_failed',
  DRAFT_CREATED: 'draft_created',
  DRAFT_BLOCKED: 'draft_blocked',
  LEAD_QUALIFIED: 'lead_qualified',
  OPPORTUNITY_INGESTED: 'opportunity_ingested',
  OPPORTUNITY_VERIFIED: 'opportunity_verified',
  ERROR_FOUND: 'error_found',
  ERROR_RESOLVED: 'error_resolved',
  SESSION_STARTED: 'session_started',
  TOOL_INVOKED: 'tool_invoked',
})

/**
 * Stable health states used in the overview cards and the
 * `/health` endpoint.
 *
 * RAN_NO_OUTPUT is the honest middle state between IDLE (never ran) and
 * HEALTHY (ran AND produced work): the agent completed its run without error
 * but persisted zero output for the window (e.g. Yana fetched 0 pages / found
 * 0 leads). It must NOT read as plain "healthy" — that hid silently-idle
 * agents behind a green badge. It is NOT an error either (nothing failed), so
 * it never drives a red System Status.
 */
export const AGENT_HEALTH = Object.freeze({
  HEALTHY: 'healthy',
  RAN_NO_OUTPUT: 'ran_no_output',
  WARNING: 'warning',
  ERROR: 'error',
  IDLE: 'idle',
  NOT_INSTALLED: 'not_installed',
})

/**
 * Human-readable label for each health state (used by overview cards / tabs).
 */
export const AGENT_HEALTH_LABELS = Object.freeze({
  [AGENT_HEALTH.HEALTHY]: 'Healthy',
  [AGENT_HEALTH.RAN_NO_OUTPUT]: 'Ran, no output',
  [AGENT_HEALTH.WARNING]: 'Warning',
  [AGENT_HEALTH.ERROR]: 'Error',
  [AGENT_HEALTH.IDLE]: 'Idle',
  [AGENT_HEALTH.NOT_INSTALLED]: 'Not installed',
})

/**
 * Convert a free-form range key (24h/7d/30d/custom) and optional
 * start/end ISO strings into a concrete window. Returns:
 *   { startIso, endIso, windowLabel }
 */
export function resolveRange({ range, start, end } = {}) {
  const now = new Date()
  const endIso = end || now.toISOString()
  if (range === 'custom' && start) {
    return { startIso: new Date(start).toISOString(), endIso, windowLabel: 'custom' }
  }
  const ms = (() => {
    if (range === '7d') return 7 * 24 * 60 * 60 * 1000
    if (range === '30d') return 30 * 24 * 60 * 60 * 1000
    return 24 * 60 * 60 * 1000 // default 24h
  })()
  const startIso = new Date(now.getTime() - ms).toISOString()
  return { startIso, endIso, windowLabel: range || '24h' }
}

/**
 * Default empty agent summary returned when a per-agent set of tables
 * is missing entirely. Keeps every dashboard panel stable in shape.
 */
export function makeEmptyAgentSummary(agent_name) {
  return {
    agent_name,
    label: AGENT_LABELS[agent_name] || agent_name,
    tagline: AGENT_TAGLINES[agent_name] || '',
    enabled: false,
    installed: false,
    health: AGENT_HEALTH.NOT_INSTALLED,
    last_run_at: null,
    last_success_at: null,
    last_failure_at: null,
    queue_depth: 0,
    success_rate: null,
    error_count: 0,
    actions_in_window: 0,
    primary_metrics: {},
    notes: ['No telemetry tables found for this agent.'],
  }
}
