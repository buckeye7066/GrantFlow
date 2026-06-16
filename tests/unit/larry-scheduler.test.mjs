/**
 * Larry — scheduler: env-gated, no-op when disabled, cron parser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseSchedule,
  isCronMinuteMatch,
  startLarryScheduler,
  stopLarryScheduler,
} from '../../backend/services/larry/larryScheduler.js'

test('scheduler is no-op when LARRY_ENABLED=false', () => {
  const saved = process.env.LARRY_ENABLED
  delete process.env.LARRY_ENABLED
  try {
    const result = startLarryScheduler({ db: null })
    assert.equal(result.started, false)
    assert.match(result.reason, /LARRY_ENABLED/)
  } finally {
    if (saved) process.env.LARRY_ENABLED = saved
    stopLarryScheduler()
  }
})

test('scheduler still no-op when enabled but neither schedule flag is set', () => {
  const saved = { ...process.env }
  process.env.LARRY_ENABLED = 'true'
  delete process.env.LARRY_RUN_ON_SCHEDULE
  delete process.env.LARRY_RUN_ON_STARTUP
  try {
    const result = startLarryScheduler({ db: null })
    assert.equal(result.started, false)
  } finally {
    Object.assign(process.env, saved)
    stopLarryScheduler()
  }
})

test('parseSchedule handles default + invalid values gracefully', () => {
  assert.deepEqual(parseSchedule(null), {
    minute: 0, hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*',
  })
  assert.deepEqual(parseSchedule('0 * * * *'), {
    minute: '0', hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*',
  })
})

test('isCronMinuteMatch matches "0 * * * *" only on minute=0', () => {
  const onTheHour = new Date(2026, 0, 1, 12, 0, 0)
  const offTheHour = new Date(2026, 0, 1, 12, 30, 0)
  assert.equal(isCronMinuteMatch('0 * * * *', onTheHour), true)
  assert.equal(isCronMinuteMatch('0 * * * *', offTheHour), false)
})
