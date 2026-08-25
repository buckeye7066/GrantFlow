import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SCHEDULER_PATH = join(REPO_ROOT, 'backend', 'services', 'amy', 'amyScheduler.js')
const RUNNER_PATH = join(REPO_ROOT, 'backend', 'services', 'amy', 'amyRunner.js')
const LOCK_PATH = join(REPO_ROOT, 'backend', 'services', 'schedulerLock.js')

async function loadScheduler({ latest = null, launchAmyRun = () => ({ run_id: 'test-run' }) } = {}) {
  globalThis.__amySchedulerTestDeps = {
    launchAmyRun,
    readLatestAmyReport: async () => latest,
  }
  const source = readFileSync(SCHEDULER_PATH, 'utf8')
    .replace(
      "import { launchAmyRun } from './amyRunner.js'",
      'const { launchAmyRun } = globalThis.__amySchedulerTestDeps',
    )
    .replace(
      "import { readLatestAmyReport } from './amyReportStore.js'",
      'const { readLatestAmyReport } = globalThis.__amySchedulerTestDeps',
    )
  const nonce = `${Date.now()}-${Math.random()}`
  try {
    return await import(`data:text/javascript;base64,${Buffer.from(`${source}\n// ${nonce}`).toString('base64')}`)
  } finally {
    delete globalThis.__amySchedulerTestDeps
  }
}

async function loadSchedulerLock({ withLock, renewLock, captureException = () => {} }) {
  globalThis.__schedulerLockTestDeps = { withLock, renewLock, captureException }
  const source = readFileSync(LOCK_PATH, 'utf8')
    .replace(
      "import { withLock, renewLock } from './agentControl/agentControlStore.js'",
      'const { withLock, renewLock } = globalThis.__schedulerLockTestDeps',
    )
    .replace(
      "import { captureException } from '../utils/observability.js'",
      'const { captureException } = globalThis.__schedulerLockTestDeps',
    )
  const nonce = `${Date.now()}-${Math.random()}`
  try {
    return await import(`data:text/javascript;base64,${Buffer.from(`${source}\n// ${nonce}`).toString('base64')}`)
  } finally {
    delete globalThis.__schedulerLockTestDeps
  }
}

const quietLogger = { info() {}, warn() {}, error() {} }
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

test('Amy freshness is anchored to the latest durable completed report', async () => {
  const scheduler = await loadScheduler()
  const nowMs = Date.parse('2026-08-25T12:00:00.000Z')

  assert.equal(scheduler.isAmyReportDue(null, { intervalMs: DAY_MS, nowMs }), true)
  assert.equal(
    scheduler.isAmyReportDue({ completed_at: '2026-08-24T12:00:00.000Z' }, { intervalMs: DAY_MS, nowMs }),
    true,
    'the exact daily deadline is due',
  )
  assert.equal(
    scheduler.isAmyReportDue({ completed_at: '2026-08-24T13:00:00.000Z' }, { intervalMs: DAY_MS, nowMs }),
    false,
    'a 23-hour-old report is still fresh',
  )
  assert.equal(
    scheduler.isAmyReportDue({ completed_at: '2026-08-25T13:00:00.000Z' }, { intervalMs: DAY_MS, nowMs }),
    false,
    'clock skew into the future cannot trigger an early run',
  )
})

test('an hourly tick launches only when due, and a lock-held attempt retries on the next tick', async () => {
  let launches = 0
  const scheduler = await loadScheduler({
    latest: { completed_at: '2026-08-23T12:00:00.000Z' },
    launchAmyRun: () => {
      launches += 1
      return {
        run_id: `attempt-${launches}`,
        already_running: false,
        promise: Promise.resolve({ skipped: true, reason: 'lock_held' }),
      }
    },
  })

  const first = await scheduler.runAmyFreshnessCheck({
    db: {}, logger: quietLogger, intervalMs: DAY_MS, nowMs: Date.parse('2026-08-25T12:00:00.000Z'),
  })
  assert.equal(first.triggered, true)
  assert.equal((await first.launch.promise).reason, 'lock_held')

  // The skipped lock attempt created no completed report. The same durable
  // report is still overdue, so the next poll must try again rather than wait
  // another process-relative 24-hour interval.
  const second = await scheduler.runAmyFreshnessCheck({
    db: {}, logger: quietLogger, intervalMs: DAY_MS, nowMs: Date.parse('2026-08-25T13:00:00.000Z'),
  })
  assert.equal(second.triggered, true)
  assert.equal(launches, 2)

  let freshLaunches = 0
  const freshScheduler = await loadScheduler({
    latest: { completed_at: '2026-08-25T12:30:00.000Z' },
    launchAmyRun: () => { freshLaunches += 1 },
  })
  const fresh = await freshScheduler.runAmyFreshnessCheck({
    db: {}, logger: quietLogger, intervalMs: DAY_MS, nowMs: Date.parse('2026-08-25T13:00:00.000Z'),
  })
  assert.deepEqual(fresh, {
    triggered: false,
    reason: 'report_fresh',
    last_run_at: '2026-08-25T12:30:00.000Z',
  })
  assert.equal(freshLaunches, 0)
})

test('the default scheduler timer polls hourly instead of waiting a process-relative day', async () => {
  const envNames = ['AMY_ENABLED', 'AMY_RUN_ON_SCHEDULE', 'AMY_RUN_ON_STARTUP', 'AMY_INTERVAL_MS', 'AMY_FRESHNESS_POLL_MS']
  const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))
  for (const name of envNames) delete process.env[name]

  const realSetTimeout = globalThis.setTimeout
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const intervals = []
  globalThis.setTimeout = () => ({ unref() {} })
  globalThis.setInterval = (_fn, ms) => {
    intervals.push(ms)
    return { unref() {} }
  }
  globalThis.clearInterval = () => {}

  try {
    const scheduler = await loadScheduler()
    const started = scheduler.startAmyScheduler({ db: {}, logger: quietLogger })
    assert.equal(started.interval_ms, DAY_MS, '24h remains the durable freshness target')
    assert.equal(started.poll_interval_ms, HOUR_MS, 'the in-process timer only waits one hour before rechecking durability')
    assert.deepEqual(intervals, [HOUR_MS])
    scheduler.stopAmyScheduler()
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
    for (const name of envNames) {
      if (savedEnv[name] === undefined) delete process.env[name]
      else process.env[name] = savedEnv[name]
    }
  }
})

test('Amy keeps local+DB single-flight while using a short heartbeating lease', () => {
  const runner = readFileSync(RUNNER_PATH, 'utf8')
  const lock = readFileSync(LOCK_PATH, 'utf8')

  assert.match(runner, /if \(state\.running\)/, 'the in-process single-flight guard remains present')
  assert.match(runner, /const LOCK_TTL_MS = 15 \* 60 \* 1000/)
  assert.match(runner, /heartbeat:\s*true/)
  assert.match(runner, /runWithSchedulerLock\(/, 'cross-instance serialization remains present')
  assert.match(lock, /heartbeat\s*=\s*false/, 'the shared lock helper supports an opt-in heartbeat')
  assert.match(lock, /renewLock\(db,\s*\{ lockName: fullLockName, ownerToken: lease\.ownerToken, ttlMs \}\)/)
})

test('the shared scheduler lock heartbeat renews Amy ownership and stops with the run', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const renewals = []
  const cleared = []
  let heartbeat = null
  let heartbeatPeriod = null
  const handle = { unref() {} }

  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = (fn, ms) => {
    heartbeat = fn
    heartbeatPeriod = ms
    return handle
  }
  globalThis.clearInterval = (value) => { cleared.push(value) }

  try {
    const schedulerLock = await loadSchedulerLock({
      withLock: async (_db, _options, critical) => critical({ ownerToken: 'amy-owner-token' }),
      renewLock: async (_db, options) => { renewals.push(options); return true },
    })
    const ttlMs = 15 * 60 * 1000
    const running = schedulerLock.runWithSchedulerLock(
      {},
      { lockName: 'amy:training', ttlMs, heartbeat: true, logger: quietLogger },
      async () => { await gate; return 'complete' },
    )

    await Promise.resolve()
    assert.equal(heartbeatPeriod, 5 * 60 * 1000, '15m lease renews every TTL/3')
    assert.equal(typeof heartbeat, 'function')
    heartbeat()
    await Promise.resolve()
    assert.deepEqual(renewals, [{
      lockName: 'scheduler:amy:training',
      ownerToken: 'amy-owner-token',
      ttlMs,
    }])

    release()
    assert.equal(await running, 'complete')
    assert.deepEqual(cleared, [handle], 'the heartbeat cannot outlive the critical section')
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
})
