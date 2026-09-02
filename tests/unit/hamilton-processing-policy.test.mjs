import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HAMILTON_PROTECTED_PIPELINE_STATUSES,
  hamiltonProcessingBlockReason,
  isHamiltonProcessableStage,
  isHamiltonProtectedPipelineStage,
} from '../../shared/hamiltonProcessingPolicy.js'

test('Hamilton accepts every pre-submission canonical stage', () => {
  for (const stage of [
    'discovered',
    'saved',
    'interested',
    'gathering_documents',
    'drafting',
    'ready_to_submit',
  ]) {
    assert.equal(isHamiltonProcessableStage(stage), true, stage)
    assert.equal(hamiltonProcessingBlockReason(stage), null, stage)
  }
})

test('Hamilton protects submitted and every post-submission canonical stage', () => {
  for (const stage of ['submitted', 'follow_up', 'awarded', 'declined', 'archived']) {
    assert.equal(isHamiltonProtectedPipelineStage(stage), true, stage)
    assert.equal(isHamiltonProcessableStage(stage), false, stage)
    assert.ok(hamiltonProcessingBlockReason(stage), stage)
  }
})

test('legacy post-submission aliases and evidence holds are protected', () => {
  for (const stage of [
    'auto_applied',
    'pending_review',
    'under_review',
    'report',
    'rejected',
    'declined_no_review',
    'closed',
    'deadline_passed',
    'submit_attempt_started',
    'submit_evidence_pending',
    'submission_verification_required',
    'completed',
  ]) {
    assert.ok(HAMILTON_PROTECTED_PIPELINE_STATUSES.includes(stage), stage)
    assert.equal(isHamiltonProtectedPipelineStage(stage), true, stage)
  }
})

test('unknown non-submission values do not become submission proof', () => {
  assert.equal(isHamiltonProcessableStage('ready_to_start'), true)
  assert.equal(isHamiltonProcessableStage('legacy_custom_stage'), true)
  assert.equal(isHamiltonProcessableStage(null), true)
})
