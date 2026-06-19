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

// ---------------------------------------------------------------------------
// Deprecation guard: Larry vs Yana
//
// Larry and Yana fill the same role (Client/Lead Discovery + outreach
// pipeline). Yana is the canonical agent in agentControlTypes.ALL_AGENTS;
// Larry is a deprecated predecessor kept only for backward compatibility.
// If both schedulers came up, they'd double-discover the same prospects
// into different tables (yana_lead_candidates vs larry_*) and Larry runs
// outside Mission Control. The guard refuses to start Larry when Yana is
// also enabled.
// ---------------------------------------------------------------------------

test('REGRESSION: Larry refuses to start when Yana is also enabled', () => {
  const saved = { ...process.env }
  process.env.LARRY_ENABLED = 'true'
  process.env.LARRY_RUN_ON_SCHEDULE = 'true'
  process.env.LARRY_RUN_ON_STARTUP = 'true'
  try {
    const warnings = []
    const log = { warn: (m) => warnings.push(m), info: (m) => warnings.push(m) }
    // Inject env explicitly so the test doesn't depend on
    // process.env.YANA_ENABLED leaking from another test.
    const result = startLarryScheduler({
      db: null,
      logger: log,
      env: { YANA_ENABLED: 'true' },
    })
    assert.equal(result.started, false)
    assert.equal(result.reason, 'deprecated_superseded_by_yana')
    assert.match(result.detail, /YANA_ENABLED/)
    // Operator must see a clear deprecation log line.
    assert.ok(
      warnings.some((m) => /DEPRECATED.*YANA_ENABLED=true/.test(String(m))),
      `expected deprecation warning, got: ${warnings.join(' | ')}`,
    )
  } finally {
    Object.assign(process.env, saved)
    stopLarryScheduler()
  }
})

test('Yana opt-in tokens (1 / true / yes / on) all trigger the guard', () => {
  const saved = { ...process.env }
  process.env.LARRY_ENABLED = 'true'
  process.env.LARRY_RUN_ON_STARTUP = 'true'
  try {
    for (const token of ['1', 'true', 'TRUE', 'yes', 'YES', 'on', 'ON']) {
      const result = startLarryScheduler({
        db: null,
        logger: { warn() {}, info() {} },
        env: { YANA_ENABLED: token },
      })
      assert.equal(result.started, false, `YANA_ENABLED=${token} must block Larry`)
      assert.equal(result.reason, 'deprecated_superseded_by_yana')
      stopLarryScheduler()
    }
  } finally {
    Object.assign(process.env, saved)
    stopLarryScheduler()
  }
})

test('standalone Larry boot still emits a deprecation notice (operator visibility)', () => {
  const saved = { ...process.env }
  process.env.LARRY_ENABLED = 'true'
  // No schedule/startup flag → scheduler returns early on the second
  // check, but the deprecation notice must still have been logged.
  delete process.env.LARRY_RUN_ON_SCHEDULE
  delete process.env.LARRY_RUN_ON_STARTUP
  try {
    const warnings = []
    startLarryScheduler({
      db: null,
      logger: { warn: (m) => warnings.push(m), info: (m) => warnings.push(m) },
      env: { YANA_ENABLED: 'false' },
    })
    assert.ok(
      warnings.some((m) => /DEPRECATION NOTICE/.test(String(m))),
      `expected deprecation notice on standalone Larry boot, got: ${warnings.join(' | ')}`,
    )
  } finally {
    Object.assign(process.env, saved)
    stopLarryScheduler()
  }
})

test('Yana NOT enabled (or unset) does NOT trigger the guard — Larry still works standalone', () => {
  const saved = { ...process.env }
  process.env.LARRY_ENABLED = 'true'
  process.env.LARRY_RUN_ON_STARTUP = 'true'
  try {
    for (const token of [undefined, '', '0', 'false', 'no', 'off', 'maybe']) {
      const env = token === undefined ? {} : { YANA_ENABLED: token }
      const result = startLarryScheduler({
        db: null,
        logger: { warn() {}, info() {} },
        env,
      })
      // Either started OK (with deprecation notice) or stopped on
      // a different gate — but NOT blocked by the Yana guard.
      assert.notEqual(
        result.reason, 'deprecated_superseded_by_yana',
        `YANA_ENABLED=${JSON.stringify(token)} must NOT trigger the Yana guard`,
      )
      stopLarryScheduler()
    }
  } finally {
    Object.assign(process.env, saved)
    stopLarryScheduler()
  }
})
