import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PIPELINE_STAGE_HELP,
  getStageHelp,
  isHumanReviewNeeded,
} from '../../src/components/pipeline/pipelineStageHelp.js'

/**
 * Regression tests for src/components/pipeline/pipelineStageHelp.js.
 *
 * The map keys MUST stay in sync with the `STATUSES` array in
 * `src/components/pipeline/KanbanBoard.jsx`. The `humanRequired`
 * subset (portal / follow_up / report) drives the "Human Review
 * Needed" badge on GrantCard and the handoff count in Pipeline header.
 */

test('every Kanban status has a help entry (no fallthroughs to DEFAULT)', () => {
  // Mirror of KanbanBoard.jsx STATUSES — kept as a literal here so this
  // test catches additions/removals in either direction.
  const KANBAN_STATUSES = [
    'discovery',
    'discovered',
    'interested',
    'auto_applied',
    'drafting',
    'application_prep',
    'revision',
    'portal',
    'submitted',
    'pending_review',
    'follow_up',
    'awarded',
    'report',
    'declined_no_review',
    'declined',
    'closed',
  ]
  for (const status of KANBAN_STATUSES) {
    const help = PIPELINE_STAGE_HELP[status]
    assert.ok(help, `missing pipelineStageHelp entry for status: ${status}`)
    assert.ok(help.label && typeof help.label === 'string', `${status}: label required`)
    assert.ok(
      help.plainEnglish && typeof help.plainEnglish === 'string',
      `${status}: plainEnglish required`,
    )
    assert.ok(help.nextStep && typeof help.nextStep === 'string', `${status}: nextStep required`)
  }
})

test('exactly portal / follow_up / report are humanRequired', () => {
  const humanRequired = Object.entries(PIPELINE_STAGE_HELP)
    .filter(([, v]) => v.humanRequired === true)
    .map(([k]) => k)
    .sort()
  assert.deepEqual(humanRequired, ['follow_up', 'portal', 'report'])
})

test('getStageHelp returns a non-null object even for unknown statuses', () => {
  const help = getStageHelp('completely-made-up-status')
  assert.ok(help)
  assert.ok(help.label)
  assert.ok(help.plainEnglish)
  assert.ok(help.nextStep)
  assert.equal(help.humanRequired, undefined, 'default help must not falsely flag humanRequired')
})

test('getStageHelp is case-insensitive and tolerates null/undefined', () => {
  assert.equal(getStageHelp('PORTAL').label, getStageHelp('portal').label)
  assert.equal(getStageHelp(null).label, getStageHelp('').label)
  assert.equal(getStageHelp(undefined).label, getStageHelp('').label)
})

test('app_prep alias maps to the same copy as application_prep', () => {
  const a = getStageHelp('app_prep')
  const b = getStageHelp('application_prep')
  assert.equal(a.label, b.label)
  assert.equal(a.plainEnglish, b.plainEnglish)
  assert.equal(a.nextStep, b.nextStep)
})

test('isHumanReviewNeeded: humanRequired stages trigger', () => {
  assert.equal(isHumanReviewNeeded('portal', null), true)
  assert.equal(isHumanReviewNeeded('follow_up', null), true)
  assert.equal(isHumanReviewNeeded('report', null), true)
})

test('isHumanReviewNeeded: non-human stages do not trigger without automation', () => {
  assert.equal(isHumanReviewNeeded('drafting', null), false)
  assert.equal(isHumanReviewNeeded('submitted', null), false)
  assert.equal(isHumanReviewNeeded('awarded', null), false)
})

test('isHumanReviewNeeded: automation.handoff_required overrides stage', () => {
  // Drafting normally not human-required, but if automation says so → yes.
  assert.equal(
    isHumanReviewNeeded('drafting', { handoff_required: true, handoff_reason: 'missing docs' }),
    true,
  )
  // Even portal stays true regardless of automation false.
  assert.equal(isHumanReviewNeeded('portal', { handoff_required: false }), true)
})

test('isHumanReviewNeeded: tolerates malformed automation arg', () => {
  assert.equal(isHumanReviewNeeded('drafting', 'oops'), false)
  assert.equal(isHumanReviewNeeded('drafting', 42), false)
  assert.equal(isHumanReviewNeeded('drafting', []), false)
})
