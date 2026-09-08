import assert from 'node:assert/strict'
import { test } from 'node:test'
import { weeklyDigestFailure } from '../../backend/services/hamilton/weeklyDigestFailure.js'

test('draft authorization failure names configuration without storing provider bodies or secrets', () => {
  const failure = weeklyDigestFailure('p-123', 'draft', {
    code: 'JOHN_OUTLOOK_DRAFT_FAILED', status: 403,
    message: 'Bearer secret person@private.test', detail: 'sensitive provider body',
  })
  assert.equal(failure.profile_id, 'p-123')
  assert.equal(failure.mode, 'draft')
  assert.equal(failure.status, 403)
  assert.match(failure.next_action, /Mail.ReadWrite/)
  assert.doesNotMatch(JSON.stringify(failure), /Bearer|person@|sensitive provider body/)
})

test('unknown failures and invalid statuses are bounded machine evidence, not arbitrary messages', () => {
  for (const status of [0, 200, 399, 600, Infinity, 'oops']) {
    const failure = weeklyDigestFailure('p'.repeat(200), 'invalid', { code: 'secret', status })
    assert.equal(failure.profile_id.length, 100)
    assert.equal(failure.code, 'DIGEST_DELIVERY_FAILED')
    assert.equal(failure.status, null)
    assert.equal(failure.mode, 'draft')
    assert.doesNotMatch(JSON.stringify(failure), /secret/)
  }
})

test('unverified drafts and partial sends remain actionable failures, never retry-all advice', () => {
  const draft = weeklyDigestFailure('p1', 'draft', { code: 'DIGEST_DRAFT_UNVERIFIED' })
  assert.match(draft.next_action, /not counted as a completed draft/)
  const partial = weeklyDigestFailure('p1', 'send', { code: 'DIGEST_PARTIAL_SEND' })
  assert.equal(partial.mode, 'send')
  assert.match(partial.next_action, /only the failed profile/)
  assert.match(weeklyDigestFailure('p1', 'draft', { status: 429 }).next_action, /rate limit/)
  assert.match(weeklyDigestFailure('p1', 'draft', { status: 503 }).next_action, /outage/)
})
