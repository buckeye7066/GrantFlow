/**
 * agent-run-state-machine.test.mjs
 *
 * Locks down the agent_control_runs lifecycle transition table so the
 * recurring regressions ('cancelled' overwritten by 'stopped',
 * emergency_stop settling in 'stopping', cancel + emergency_stop
 * clobbering each other) cannot return.
 *
 * Mission rule: "Any new logic must be: traceable, logged
 * (lightweight), reversible." This module is exactly that — pure data
 * + assertions, with the orchestrator's only real-world job being
 * "consult the table, never argue with it".
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RUN_STATES,
  RUN_EVENTS,
  isTerminal,
  isActive,
  canTransition,
  applyEvent,
  nextState,
  canDirectSet,
  listTransitions,
} from '../../backend/services/agentControl/agentRunStateMachine.js'

test('every RUN_STATES entry is in the canonical set', () => {
  const expected = new Set([
    'queued', 'running', 'pausing', 'paused',
    'stopping', 'stopped', 'completed', 'completed_noop',
    'failed', 'cancelled', 'partial_stop', 'stop_failed',
  ])
  assert.equal(RUN_STATES.length, expected.size)
  for (const s of RUN_STATES) assert.ok(expected.has(s), `unexpected state: ${s}`)
})

test('isTerminal recognises all 7 terminal states', () => {
  for (const t of ['stopped', 'completed', 'completed_noop', 'failed', 'cancelled', 'partial_stop', 'stop_failed']) {
    assert.equal(isTerminal(t), true, `${t} must be terminal`)
    assert.equal(isActive(t), false, `${t} must NOT be active`)
  }
})

test('isActive flags non-terminal states', () => {
  for (const a of ['queued', 'running', 'pausing', 'paused', 'stopping']) {
    assert.equal(isActive(a), true, `${a} must be active`)
  }
})

test('REGRESSION: terminal states have no outgoing transitions (cancelled→stopped is forbidden)', () => {
  // The exact bug: cancelRun() set 'cancelled', then executeRun() did
  // setRunStatus('stopped') and overwrote it. The state machine MUST
  // reject this on direct-set.
  for (const terminal of ['stopped', 'completed', 'completed_noop', 'failed', 'cancelled', 'partial_stop', 'stop_failed']) {
    for (const event of RUN_EVENTS) {
      assert.equal(
        canTransition(terminal, event),
        false,
        `terminal '${terminal}' must not transition on '${event}'`,
      )
    }
    // Direct-set also rejected for any non-equal target.
    for (const otherState of RUN_STATES) {
      if (otherState === terminal) continue
      const decision = canDirectSet(terminal, otherState)
      assert.equal(decision.ok, false, `canDirectSet(${terminal} -> ${otherState}) must be false`)
      assert.match(decision.reason, /cannot_exit_terminal/)
    }
    // Same → same is idempotent OK.
    assert.equal(canDirectSet(terminal, terminal).ok, true)
  }
})

test('happy path: queued → start → running → complete → completed', () => {
  let s = 'queued'
  s = applyEvent(s, 'start')
  assert.equal(s, 'running')
  s = applyEvent(s, 'complete')
  assert.equal(s, 'completed')
  assert.equal(isTerminal(s), true)
})

test('pause path: running → pausing → paused → resume → running → complete', () => {
  let s = 'running'
  s = applyEvent(s, 'pause')
  assert.equal(s, 'pausing')
  s = applyEvent(s, 'pause')
  assert.equal(s, 'paused')
  s = applyEvent(s, 'resume')
  assert.equal(s, 'running')
  s = applyEvent(s, 'complete')
  assert.equal(s, 'completed')
})

test('graceful stop path: running → graceful_stop → stopping → complete → stopped', () => {
  let s = 'running'
  s = applyEvent(s, 'graceful_stop')
  assert.equal(s, 'stopping')
  s = applyEvent(s, 'complete')
  assert.equal(s, 'stopped')
})

test('emergency stop path: running → emergency_stop → stopped (immediate)', () => {
  let s = 'running'
  s = applyEvent(s, 'emergency_stop')
  assert.equal(s, 'stopped')
  assert.equal(isTerminal(s), true)
})

test('cancel path: running → cancel → cancelled (terminal, NOT stopped)', () => {
  let s = 'running'
  s = applyEvent(s, 'cancel')
  assert.equal(s, 'cancelled')
  assert.equal(isTerminal(s), true)
  // The exact past bug: trying to follow up with graceful_stop must
  // be rejected and the state must STAY cancelled.
  assert.equal(canTransition('cancelled', 'graceful_stop'), false)
  assert.equal(canTransition('cancelled', 'emergency_stop'), false)
})

test('partial_stop is terminal and reachable from stopping', () => {
  const s = applyEvent('stopping', 'mark_partial_stop')
  assert.equal(s, 'partial_stop')
  assert.equal(isTerminal(s), true)
})

test('stop_failed is terminal and reachable from stopping', () => {
  const s = applyEvent('stopping', 'mark_stop_failed')
  assert.equal(s, 'stop_failed')
  assert.equal(isTerminal(s), true)
})

test('completed_noop reachable from running', () => {
  const s = applyEvent('running', 'complete_noop')
  assert.equal(s, 'completed_noop')
  assert.equal(isTerminal(s), true)
})

test('applyEvent throws with FORBIDDEN_TRANSITION on illegal input', () => {
  assert.throws(
    () => applyEvent('completed', 'pause'),
    (err) => err.code === 'FORBIDDEN_TRANSITION' && err.from === 'completed' && err.event === 'pause',
  )
  assert.throws(
    () => applyEvent('queued', 'resume'),
    (err) => err.code === 'FORBIDDEN_TRANSITION',
  )
})

test('nextState returns null for forbidden transitions instead of throwing', () => {
  assert.equal(nextState('completed', 'pause'), null)
  assert.equal(nextState('cancelled', 'resume'), null)
  assert.equal(nextState('queued', 'complete'), null)
})

test('canDirectSet allows non-terminal → non-terminal moves', () => {
  // Real world: orchestrator does setRunStatus('running') after a
  // resume, and the previous status was 'paused'. That must work.
  assert.equal(canDirectSet('paused', 'running').ok, true)
  assert.equal(canDirectSet('queued', 'running').ok, true)
  assert.equal(canDirectSet('running', 'pausing').ok, true)
  assert.equal(canDirectSet('pausing', 'paused').ok, true)
})

test('canDirectSet rejects unknown target states', () => {
  const decision = canDirectSet('running', 'totally_made_up')
  assert.equal(decision.ok, false)
  assert.match(decision.reason, /unknown_target_state/)
})

test('canDirectSet allows non-terminal → any terminal state (so genuine completions still work)', () => {
  for (const terminal of ['stopped', 'completed', 'completed_noop', 'failed', 'cancelled', 'partial_stop', 'stop_failed']) {
    assert.equal(canDirectSet('running', terminal).ok, true, `running -> ${terminal} must be allowed`)
  }
})

test('listTransitions exposes the full edge list (graph snapshot for dashboards)', () => {
  const edges = listTransitions()
  // Sanity: every edge has a valid from/to/event.
  for (const e of edges) {
    assert.ok(RUN_STATES.includes(e.from))
    assert.ok(RUN_STATES.includes(e.to))
    assert.ok(RUN_EVENTS.includes(e.event))
  }
  // The 'start' event must only originate from 'queued'.
  const startEdges = edges.filter((e) => e.event === 'start')
  assert.equal(startEdges.length, 1)
  assert.equal(startEdges[0].from, 'queued')
  assert.equal(startEdges[0].to, 'running')
})
