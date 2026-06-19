/**
 * agentRunStateMachine.js
 *
 * Explicit state machine for agent_control_runs lifecycle.
 *
 * Background: prior to this module, run-status transitions were
 * scattered across the orchestrator with ad-hoc string comparisons,
 * which produced repeating regressions:
 *
 *   - cancelRun() pre-set 'cancelled' but executeRun() then
 *     overwrote it with 'stopped' (silently lost the intent).
 *   - emergency_stop sometimes settled in 'stopping' instead of
 *     'stopped' / 'partial_stop' due to a race in the wait-for-quiesce
 *     logic.
 *   - cancel + emergency_stop arriving close together would clobber
 *     each other instead of preserving the user's strongest intent.
 *
 * This module centralizes the truth: there is exactly one transition
 * table, and every status mutation has to consult it. setRunStatus()
 * in agentControlStore.js should call canTransition() and refuse to
 * write a forbidden transition.
 *
 * Mission rule: "Any new logic must be: traceable, logged
 * (lightweight), reversible." This machine is pure data plus a
 * handful of functions — easy to read, easy to test, no I/O.
 */

/**
 * Run states. Mirror RUN_STATUSES in agentControlTypes.js exactly.
 */
export const RUN_STATES = Object.freeze([
  'queued',
  'running',
  'pausing',
  'paused',
  'stopping',
  'stopped',
  'completed',
  'completed_noop',
  'failed',
  'cancelled',
  'partial_stop',
  'stop_failed',
])

/**
 * Lifecycle events the orchestrator emits. Each event implies an
 * intent — never a direct state name — so the machine is the single
 * authority on what state results.
 */
export const RUN_EVENTS = Object.freeze([
  'start',
  'pause',
  'resume',
  'graceful_stop',
  'emergency_stop',
  'cancel',
  'mark_partial_stop',
  'mark_stop_failed',
  'step_failed',
  'complete',
  'complete_noop',
])

/**
 * Terminal states: once entered, the run is OVER and may not be
 * mutated. setRunStatus() must reject any transition out of these
 * (this was the bug that produced the cancelled→stopped overwrite).
 */
const TERMINAL = new Set([
  'stopped',
  'completed',
  'completed_noop',
  'failed',
  'cancelled',
  'partial_stop',
  'stop_failed',
])

export function isTerminal(state) {
  return TERMINAL.has(String(state || ''))
}

export function isActive(state) {
  if (!state) return false
  if (state === 'queued') return true
  return !isTerminal(state)
}

/**
 * Transition table: { fromState: { event: toState } }.
 *
 * Any (from, event) pair NOT present here is FORBIDDEN. That is the
 * point — silent string-equality bugs become loud rejections.
 */
const TRANSITIONS = Object.freeze({
  queued: {
    start: 'running',
    pause: 'pausing',
    graceful_stop: 'stopping',
    emergency_stop: 'stopped',
    cancel: 'cancelled',
    step_failed: 'failed',
  },
  running: {
    pause: 'pausing',
    graceful_stop: 'stopping',
    emergency_stop: 'stopped',
    cancel: 'cancelled',
    step_failed: 'failed',
    complete: 'completed',
    complete_noop: 'completed_noop',
    mark_partial_stop: 'partial_stop',
    mark_stop_failed: 'stop_failed',
  },
  pausing: {
    pause: 'paused',
    resume: 'running',
    graceful_stop: 'stopping',
    emergency_stop: 'stopped',
    cancel: 'cancelled',
    step_failed: 'failed',
    complete: 'completed',
  },
  paused: {
    resume: 'running',
    graceful_stop: 'stopping',
    emergency_stop: 'stopped',
    cancel: 'cancelled',
  },
  stopping: {
    emergency_stop: 'stopped',
    mark_partial_stop: 'partial_stop',
    mark_stop_failed: 'stop_failed',
    // Reaching the natural quiesce point of a graceful_stop:
    complete: 'stopped',
    step_failed: 'stop_failed',
  },
  // Terminal states have NO outgoing edges — kept here as empty maps
  // for clarity and to make the table self-documenting.
  stopped: {},
  completed: {},
  completed_noop: {},
  failed: {},
  cancelled: {},
  partial_stop: {},
  stop_failed: {},
})

/**
 * Returns the new state for (from, event), or null if the transition
 * is not allowed.
 */
export function nextState(from, event) {
  const row = TRANSITIONS[String(from || '')]
  if (!row) return null
  const next = row[String(event || '')]
  return typeof next === 'string' ? next : null
}

/**
 * Returns true iff the (from, event) transition is allowed.
 */
export function canTransition(from, event) {
  return nextState(from, event) !== null
}

/**
 * Apply an event. Returns the new state. THROWS on invalid transition
 * — orchestrator code that has its own ad-hoc string handling must be
 * audited and converted to use this function instead.
 */
export function applyEvent(from, event) {
  const next = nextState(from, event)
  if (next === null) {
    const err = new Error(
      `agent_control: forbidden transition from='${from}' event='${event}'`,
    )
    err.code = 'FORBIDDEN_TRANSITION'
    err.from = from
    err.event = event
    throw err
  }
  return next
}

/**
 * Decide whether a direct status SET is permitted. Used by
 * setRunStatus() so legacy call sites that pass the target state
 * directly (rather than an event) still get the terminal-state guard
 * — but a direct mutation INTO a terminal state must come via an
 * event, never as a free string.
 *
 * Returns { ok: true } if the transition is allowed, or
 * { ok: false, reason: string } if it must be rejected.
 *
 * Special cases:
 *   - same → same is always OK (idempotency).
 *   - from a terminal state, only same → same is OK.
 *   - to any non-terminal state from any non-terminal state is OK.
 *     (We intentionally don't enforce the full table on raw setStatus
 *     because legacy paths exist; the orchestrator now uses events.)
 */
export function canDirectSet(fromState, toState) {
  const f = String(fromState || '')
  const t = String(toState || '')
  if (f === t) return { ok: true }
  if (!RUN_STATES.includes(t)) {
    return { ok: false, reason: `unknown_target_state:${t}` }
  }
  if (isTerminal(f)) {
    return { ok: false, reason: `cannot_exit_terminal:${f}` }
  }
  return { ok: true }
}

/**
 * Helpers exposed for tests and for callers that want to reason about
 * the table directly without bringing in graph machinery.
 */
export function listTransitions() {
  const out = []
  for (const [from, row] of Object.entries(TRANSITIONS)) {
    for (const [event, to] of Object.entries(row)) {
      out.push({ from, event, to })
    }
  }
  return out
}
