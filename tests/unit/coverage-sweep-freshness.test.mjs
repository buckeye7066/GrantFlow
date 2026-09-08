import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isCoverageSweepDue } from '../../backend/services/coverageAudit/coverageSweepFreshness.js'

const nowMs = Date.parse('2026-09-06T15:00:00Z')
const recent = '2026-09-06T14:00:00Z'
test('only successful completed coverage receives a freshness window', () => {
  assert.equal(isCoverageSweepDue({ ok: true, status: 'completed', recorded_at: recent }, { nowMs }), false)
  for (const status of ['running', 'failed', 'interrupted', undefined]) {
    assert.equal(isCoverageSweepDue({ ok: true, status, recorded_at: recent }, { nowMs }), true)
  }
  assert.equal(isCoverageSweepDue({ ok: false, status: 'completed', recorded_at: recent }, { nowMs }), true)
})
test('missing, stale, malformed and future completion records trigger a fresh sweep', () => {
  for (const last of [null, {}, { ok: true, status: 'completed', recorded_at: 'invalid' }, { ok: true, status: 'completed', recorded_at: '2026-09-05T19:00:00Z' }, { ok: true, status: 'completed', recorded_at: '2026-09-07T00:00:00Z' }]) {
    assert.equal(isCoverageSweepDue(last, { nowMs }), true)
  }
})
test('the scheduled consumer reads terminal state inside the existing renewable lock', () => {
  const server = readFileSync(new URL('../../backend/server.js', import.meta.url), 'utf8')
  const start = server.indexOf('function scheduleProfileCoverageSweep(')
  const scheduler = server.slice(start, server.indexOf('\n  function ', start + 1))
  assert.match(scheduler, /getLastCoverageSweep\(dbInstance\)/)
  assert.match(scheduler, /isCoverageSweepDue\(last, \{ dueMs \}\)/)
  assert.match(scheduler, /lockName: 'coverage-sweep'/)
  assert.match(scheduler, /heartbeat: true/)
  assert.doesNotMatch(scheduler, /kvUpdatedAtMs/)
})
