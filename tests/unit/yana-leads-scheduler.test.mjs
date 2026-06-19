/**
 * Yana — Lead Pipeline scheduler: env-gated, no-op when disabled, cron parser.
 *
 * Internal symbol names (`startLarryScheduler`, `stopLarryScheduler`,
 * `LARRY_ENABLED`) are the legacy spellings of the Yana lead pipeline.
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
// Conflict guard: legacy Yana lead pipeline vs canonical Yana adapter.
//
// Two implementations of "Yana" exist: the canonical client-discovery
// adapter wired to the Admin Agent Control Center
// (agentControlTypes.ALL_AGENTS includes 'yana') and this older lead
// pipeline (formerly codenamed "Larry"). If both schedulers came up,
// they'd double-discover the same prospects into different tables
// (yana_lead_candidates vs larry_*) and the legacy pipeline runs
// outside Mission Control. The guard refuses to start the legacy
// pipeline when YANA_ENABLED=true so operators consolidate on the
// canonical adapter.
// ---------------------------------------------------------------------------

test('REGRESSION: legacy Yana lead pipeline refuses to start when canonical Yana adapter is enabled', () => {
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
    // Operator must see a clear log line explaining the conflict.
    assert.ok(
      warnings.some((m) => /refusing to start.*YANA_ENABLED=true/.test(String(m))),
      `expected conflict warning, got: ${warnings.join(' | ')}`,
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
      assert.equal(result.started, false, `YANA_ENABLED=${token} must block the legacy pipeline`)
      assert.equal(result.reason, 'deprecated_superseded_by_yana')
      stopLarryScheduler()
    }
  } finally {
    Object.assign(process.env, saved)
    stopLarryScheduler()
  }
})

test('standalone legacy-pipeline boot still emits a notice (operator visibility)', () => {
  const saved = { ...process.env }
  process.env.LARRY_ENABLED = 'true'
  // No schedule/startup flag → scheduler returns early on the second
  // check, but the operator notice must still have been logged.
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
      warnings.some((m) => /\[Yana\/leads\] notice: running the legacy lead pipeline/.test(String(m))),
      `expected legacy-pipeline notice on standalone boot, got: ${warnings.join(' | ')}`,
    )
  } finally {
    Object.assign(process.env, saved)
    stopLarryScheduler()
  }
})

test('canonical YANA_LEADS_ENABLED env-var alias also enables the scheduler (precedence over LARRY_ENABLED)', () => {
  const saved = { ...process.env }
  delete process.env.LARRY_ENABLED
  delete process.env.LARRY_RUN_ON_SCHEDULE
  delete process.env.LARRY_RUN_ON_STARTUP
  process.env.YANA_LEADS_ENABLED = 'true'
  process.env.YANA_LEADS_RUN_ON_SCHEDULE = 'false'
  process.env.YANA_LEADS_RUN_ON_STARTUP = 'false'
  try {
    // YANA_ENABLED is not set, so the conflict guard does not fire.
    // Both run-on flags are false, so the scheduler returns early
    // *after* honouring the YANA_LEADS_ENABLED master switch — exactly
    // the same behaviour as if LARRY_ENABLED=true had been set with
    // both run flags off.
    const result = startLarryScheduler({
      db: null,
      logger: { warn() {}, info() {} },
      env: {},
    })
    assert.equal(result.started, false)
    assert.match(
      result.reason,
      /LARRY_RUN_ON_SCHEDULE=false and LARRY_RUN_ON_STARTUP=false/,
      `expected the run-flag-off path (proves YANA_LEADS_ENABLED was honoured), got reason=${result.reason}`,
    )
  } finally {
    Object.assign(process.env, saved)
    delete process.env.YANA_LEADS_ENABLED
    delete process.env.YANA_LEADS_RUN_ON_SCHEDULE
    delete process.env.YANA_LEADS_RUN_ON_STARTUP
    stopLarryScheduler()
  }
})

test('Yana NOT enabled (or unset) does NOT trigger the guard — legacy pipeline still works standalone', () => {
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
