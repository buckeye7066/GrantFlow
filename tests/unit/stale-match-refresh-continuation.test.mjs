import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStaleMatchRefreshRunner } from '../../backend/services/matching/staleMatchRefreshContinuation.js'

function fixture(results, options = {}) {
  const timers = new Map(), receipts = [], calls = []
  const env = { NODE_ENV: 'production' }
  let nextId = 0
  const runBatch = async (db, opts) => {
    calls.push({ db, opts })
    const next = results.shift()
    if (next instanceof Error) throw next
    if (typeof next === 'function') return next()
    return next
  }
  const run = createStaleMatchRefreshRunner(runBatch, {
    environment: () => env,
    schedule: (callback, delay) => {
      assert.equal(delay, 30000)
      const timer = { id: ++nextId, unref() { this.unreferenced = true } }
      timers.set(timer, callback)
      return timer
    },
    cancel: timer => timers.delete(timer),
    report: receipt => receipts.push(receipt),
    ...options,
  })
  const advance = async () => {
    const [timer, callback] = timers.entries().next().value
    timers.delete(timer)
    await callback()
  }
  return { run, timers, receipts, calls, env, advance }
}
const batch = (before, after, overrides = {}) => ({
  ok: true, write_enabled: true, stale_before: before, remaining_stale: after,
  complete: after === 0, scanned: Math.min(before, 800), refreshed: before - after,
  convergence_errors: 0, ...overrides,
})

test('the existing batch resumes until its measured stale count reaches zero', async () => {
  const f = fixture([batch(1601, 801), batch(801, 1), batch(1, 0)])
  const db = {}
  const first = await f.run(db)
  assert.equal(first.continuation_status, 'scheduled')
  assert.equal(first.complete, false)
  assert.equal(f.timers.size, 1)
  assert.equal([...f.timers.keys()][0].unreferenced, true)
  await f.advance()
  await f.advance()
  assert.equal(f.calls.length, 3)
  assert.equal(f.timers.size, 0)
  assert.equal(f.receipts.at(-1).complete, true)
  assert.equal(f.receipts.at(-1).continuation_status, 'complete')
})

test('a no-progress batch stops instead of looping forever', async () => {
  const f = fixture([batch(801, 1), batch(1, 1, { refreshed: 0, unscorable: 1 })])
  await f.run({})
  await f.advance()
  assert.equal(f.timers.size, 0)
  assert.equal(f.receipts.at(-1).complete, false)
  assert.equal(f.receipts.at(-1).continuation_status, 'blocked_no_progress')
})

test('a persistence or recount failure never schedules another batch', async () => {
  const f = fixture([batch(801, null, { ok: false, complete: false, convergence_errors: 1 })])
  const result = await f.run({})
  assert.equal(f.timers.size, 0)
  assert.equal(result.continuation_status, 'failed')
})

test('the automatic chain is bounded and a later explicit call can restart it', async () => {
  const f = fixture([batch(6, 4), batch(4, 2), batch(2, 0)], { maxPasses: 2 })
  const db = {}
  await f.run(db)
  await f.advance()
  assert.equal(f.timers.size, 0)
  assert.equal(f.receipts.at(-1).continuation_status, 'pass_limit')
  assert.equal((await f.run(db)).complete, true)
})

test('count-only and explicit opt-out never schedule follow-up writes', async () => {
  for (const opts of [{ writeEnabled: false }, { autoContinue: false }]) {
    const f = fixture([batch(900, 100, { write_enabled: opts.writeEnabled !== false })])
    await f.run({}, opts)
    assert.equal(f.timers.size, 0)
  }
})

test('the environment kill switch cancels a pending continuation before execution', async () => {
  const f = fixture([batch(900, 100)])
  await f.run({})
  f.env.ENFORCE_STALE_MATCH_EXPLAIN = '0'
  await f.advance()
  assert.equal(f.calls.length, 1)
  assert.equal(f.timers.size, 0)
  assert.equal(f.receipts.at(-1).continuation_status, 'disabled')
})

test('non-production callers get no implicit continuation', async () => {
  const f = fixture([batch(900, 100)])
  f.env.NODE_ENV = 'test'
  await f.run({})
  assert.equal(f.timers.size, 0)
})

test('overlapping write calls share one batch and one continuation', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const f = fixture([() => pending])
  const db = {}
  const first = f.run(db)
  const second = f.run(db)
  await Promise.resolve()
  assert.equal(f.calls.length, 1)
  release(batch(900, 100))
  assert.equal(await first, await second)
  assert.equal(f.timers.size, 1)
})

test('an explicit call replaces a queued timer rather than creating another chain', async () => {
  const f = fixture([batch(900, 100), batch(100, 0)])
  const db = {}
  await f.run(db)
  await f.run(db)
  assert.equal(f.timers.size, 0)
  assert.equal(f.calls.length, 2)
})

test('a thrown continuation error is caught and reported without an unhandled rejection', async () => {
  const f = fixture([batch(900, 100), new Error('fixture failure')])
  await f.run({})
  await f.advance()
  assert.equal(f.timers.size, 0)
  assert.equal(f.receipts.at(-1).continuation_status, 'failed')
})

test('default timers use the active runtime scheduler at execution time', async () => {
  const run = createStaleMatchRefreshRunner(async () => batch(2, 1), {
    environment: () => ({ NODE_ENV: 'production' }),
  })
  const originalSchedule = globalThis.setTimeout
  let calls = 0
  globalThis.setTimeout = () => { calls += 1; return { unref() {} } }
  try {
    const result = await run({})
    assert.equal(result.continuation_status, 'scheduled')
    assert.equal(calls, 1)
  } finally {
    globalThis.setTimeout = originalSchedule
  }
})
