/**
 * Regression tests for startHealthService() singleton behaviour.
 *
 * Verifies that calling startHealthService() more than once does NOT create
 * duplicate intervals.  A regression here would silently saturate the DB with
 * redundant health-check queries every 30 minutes.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { startHealthService, stopHealthService } from '../../backend/services/anyaHealthService.js'

// Use a very long interval so the background tick never fires during the tests.
process.env.ANYA_HEALTH_INTERVAL_MS = '9999999'

test('startHealthService returns an object with a stop function', () => {
  const handle = startHealthService(null)
  assert.ok(handle && typeof handle === 'object', 'should return an object')
  assert.strictEqual(typeof handle.stop, 'function', 'returned handle should have a stop function')
  stopHealthService()
})

test('startHealthService called twice does not create a duplicate interval', () => {
  const handle1 = startHealthService(null)
  const handle2 = startHealthService(null)

  // Both calls must succeed and return a usable handle.
  assert.strictEqual(typeof handle1.stop, 'function')
  assert.strictEqual(typeof handle2.stop, 'function')

  // The singleton guard means both handles share the same stop function reference.
  assert.strictEqual(
    handle1.stop,
    handle2.stop,
    'second call should return the same stop function (singleton guard)',
  )

  stopHealthService()
})

test('startHealthService can be restarted cleanly after stopping', () => {
  startHealthService(null)
  stopHealthService()

  // After stopping, a fresh start must succeed without throwing.
  let handle
  assert.doesNotThrow(() => {
    handle = startHealthService(null)
  }, 'startHealthService should not throw after a previous stop')

  assert.ok(typeof handle?.stop === 'function', 'restarted handle should have a stop function')
  stopHealthService()
})

test('stopHealthService is safe to call multiple times without throwing', () => {
  startHealthService(null)
  stopHealthService()

  // Second stop on an already-stopped service must be a no-op.
  assert.doesNotThrow(
    () => stopHealthService(),
    'stopHealthService should be idempotent',
  )
})
