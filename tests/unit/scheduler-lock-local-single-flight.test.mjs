import test from 'node:test'
import assert from 'node:assert/strict'

import { runWithSchedulerLock } from '../../backend/services/schedulerLock.js'

test('scheduler lock blocks a second local run until the first callback settles', async () => {
  let releaseFirst
  let starts = 0
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })

  const first = runWithSchedulerLock(null, { lockName: 'single-flight-test' }, async () => {
    starts += 1
    await firstGate
    return 'first-complete'
  })

  await Promise.resolve()
  const second = await runWithSchedulerLock(null, { lockName: 'single-flight-test' }, async () => {
    starts += 1
    return 'should-not-run'
  })

  assert.deepEqual(second, {
    skipped: true,
    reason: 'already_running',
    lockName: 'single-flight-test',
  })
  assert.equal(starts, 1)

  releaseFirst()
  assert.equal(await first, 'first-complete')

  const third = await runWithSchedulerLock(null, { lockName: 'single-flight-test' }, async () => {
    starts += 1
    return 'third-complete'
  })
  assert.equal(third, 'third-complete')
  assert.equal(starts, 2)
})

test('different scheduler lock names remain independent', async () => {
  let releaseA
  const gateA = new Promise((resolve) => { releaseA = resolve })

  const a = runWithSchedulerLock(null, { lockName: 'lock-a' }, async () => {
    await gateA
    return 'a'
  })
  await Promise.resolve()

  const b = await runWithSchedulerLock(null, { lockName: 'lock-b' }, async () => 'b')
  assert.equal(b, 'b')

  releaseA()
  assert.equal(await a, 'a')
})
