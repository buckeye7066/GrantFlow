import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapAutomationEvent } from '../../backend/routes/grants.js'

/**
 * Regression tests for backend/routes/grants.js#mapAutomationEvent.
 *
 * The `recommended_actions` column is a JSON blob the pipeline_automation
 * worker writes. Historically callers passed in either:
 *
 *   - a plain array of action strings (legacy shape), OR
 *   - an object like { actions: [...], application_steps: "...", ... }
 *     (current worker shape)
 *
 * Previously the mapper returned the raw parsed value as
 * `recommended_actions`, which forced the frontend handoff panel to
 * introspect the union shape itself. After the fix in 12f0ee4 / this
 * commit, the mapper always returns:
 *
 *   recommended_actions: string[]   // normalised
 *   application_steps:  string|null // extracted from the object form
 *
 * These tests lock in that contract.
 */

function makeRow(over = {}) {
  return {
    id: 'evt-1',
    created_at: '2026-05-16T18:00:00Z',
    grant_id: 'grant-1',
    job_id: 'job-1',
    previous_status: 'drafting',
    suggested_status: 'portal',
    applied_status: 'portal',
    confidence: 0.91,
    handoff_required: 1,
    handoff_reason: 'Portal submission required',
    recommended_actions: null,
    ai_summary: 'Move to portal.',
    ...over,
  }
}

test('mapAutomationEvent: null row returns null', () => {
  assert.equal(mapAutomationEvent(null), null)
  assert.equal(mapAutomationEvent(undefined), null)
})

test('mapAutomationEvent: legacy array shape → recommended_actions array, application_steps null', () => {
  const out = mapAutomationEvent(
    makeRow({
      recommended_actions: JSON.stringify(['Visit portal', 'Upload tax forms', 'Submit']),
    }),
  )
  assert.deepEqual(out.recommended_actions, ['Visit portal', 'Upload tax forms', 'Submit'])
  assert.equal(out.application_steps, null)
})

test('mapAutomationEvent: object shape with actions + application_steps → both surfaced', () => {
  const out = mapAutomationEvent(
    makeRow({
      recommended_actions: JSON.stringify({
        actions: ['Visit portal', 'Upload tax forms'],
        application_steps:
          '1. Log into the funder portal\n2. Create an account\n3. Upload EIN + budget\n4. Submit',
      }),
    }),
  )
  assert.deepEqual(out.recommended_actions, ['Visit portal', 'Upload tax forms'])
  assert.equal(
    out.application_steps,
    '1. Log into the funder portal\n2. Create an account\n3. Upload EIN + budget\n4. Submit',
  )
})

test('mapAutomationEvent: object shape with EMPTY application_steps → null (not empty string)', () => {
  const out = mapAutomationEvent(
    makeRow({
      recommended_actions: JSON.stringify({
        actions: ['Visit portal'],
        application_steps: '   ',
      }),
    }),
  )
  assert.equal(
    out.application_steps,
    null,
    'whitespace-only application_steps must normalise to null so the UI can hide the section',
  )
})

test('mapAutomationEvent: object shape with no actions key → recommended_actions empty array', () => {
  const out = mapAutomationEvent(
    makeRow({
      recommended_actions: JSON.stringify({ application_steps: 'Do the thing.' }),
    }),
  )
  assert.deepEqual(out.recommended_actions, [])
  assert.equal(out.application_steps, 'Do the thing.')
})

test('mapAutomationEvent: malformed JSON → defaults (empty actions, null application_steps)', () => {
  const out = mapAutomationEvent(
    makeRow({ recommended_actions: '{not json' }),
  )
  assert.deepEqual(out.recommended_actions, [])
  assert.equal(out.application_steps, null)
})

test('mapAutomationEvent: previous_status mirrors row.previous_status (not row.suggested_status)', () => {
  const out = mapAutomationEvent(
    makeRow({ previous_status: 'drafting', suggested_status: 'portal' }),
  )
  assert.equal(out.previous_status, 'drafting')
  assert.equal(out.suggested_status, 'portal')
})

test('mapAutomationEvent: handoff_required coerces truthy db values to boolean', () => {
  // SQLite booleans come back as 0/1. Postgres bool come back as true/false.
  assert.equal(mapAutomationEvent(makeRow({ handoff_required: 1 })).handoff_required, true)
  assert.equal(mapAutomationEvent(makeRow({ handoff_required: 0 })).handoff_required, false)
  assert.equal(mapAutomationEvent(makeRow({ handoff_required: true })).handoff_required, true)
  assert.equal(mapAutomationEvent(makeRow({ handoff_required: false })).handoff_required, false)
  assert.equal(mapAutomationEvent(makeRow({ handoff_required: null })).handoff_required, false)
})

test('mapAutomationEvent: returns the full expected shape', () => {
  const out = mapAutomationEvent(
    makeRow({
      recommended_actions: JSON.stringify({
        actions: ['x'],
        application_steps: 'Step 1.',
      }),
    }),
  )
  assert.deepEqual(Object.keys(out).sort(), [
    'ai_summary',
    'application_steps',
    'applied_status',
    'confidence',
    'created_at',
    'grant_id',
    'handoff_reason',
    'handoff_required',
    'id',
    'job_id',
    'previous_status',
    'recommended_actions',
    'suggested_status',
  ])
})
