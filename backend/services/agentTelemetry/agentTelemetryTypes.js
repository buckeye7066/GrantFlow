/**
 * Agent Mission Control — shared types and constants.
 *
 * Pure-data module — no I/O, no env reads. Safe to import from anywhere.
 *
 * Five canonical agent names map onto five concerns:
 *   - anya   user/admin assistant + workflow helper
 *   - sam    production readiness / code health
 *   - robert funding discovery + recommendation
 *   - yana   client discovery / lead intelligence
 *   - john   outreach drafting (Outlook drafts)
 *
 * The dashboard never assumes per-agent tables exist. The unified
 * `agent_activity_events` table is always queried first, agent-specific
 * tables are read only when a `tableExists` check returns true.
 */

export const AGENT_NAMES = Object.freeze(['anya', 'sam', 'robert', 'yana', 'john'])

export const AGENT_LABELS = Object.freeze({
  anya: 'Anya',
  sam: 'Sam',
  robert: 'Robert',
  yana: 'Yana',
  john: 'John',
})

export const AGENT_TAGLINES = Object.freeze({
  anya: 'User Assistance',
  sam: 'Production Readiness',
  robert: 'Funding Discovery',
  yana: 'Client Discovery',
  john: 'Outreach Drafts',
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
 */
export const AGENT_HEALTH = Object.freeze({
  HEALTHY: 'healthy',
  WARNING: 'warning',
  ERROR: 'error',
  IDLE: 'idle',
  NOT_INSTALLED: 'not_installed',
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
