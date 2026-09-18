import assert from 'node:assert/strict'
import { it as test } from 'vitest'
import Database from 'better-sqlite3'
import { beginStaleRefreshReceipt, finishStaleRefreshReceipt, STALE_REFRESH_RECEIPT_KEY } from '../services/matching/staleMatchRefreshReceipt.js'

for (const existing of [false, true]) {
  test(`a delayed cancelled claim cannot replace a newer completed receipt (existing=${existing})`, async () => {
    const raw = new Database(':memory:')
    raw.exec('CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
    if (existing) raw.prepare('INSERT INTO system_kv VALUES (?, ?, ?)').run(STALE_REFRESH_RECEIPT_KEY, '{}', '2000-01-01T00:00:00Z')
    let release, writes = 0
    const db = { prepare(sql) {
      const statement = raw.prepare(sql)
      if (/^(INSERT INTO|UPDATE system_kv)/.test(sql)) return { run: async (...args) => {
        if (++writes === 1) await new Promise(resolve => { release = resolve })
        return statement.run(...args)
      } }
      return statement
    } }
    const cancelled = new AbortController()
    const older = beginStaleRefreshReceipt(db, { signal: cancelled.signal }).catch(error => error)
    try {
      await new Promise(resolve => setTimeout(resolve, 10))
      const newer = await beginStaleRefreshReceipt(db)
      await finishStaleRefreshReceipt(db, newer, { ok: true, complete: true, status: 'complete', remaining_candidates: 0, remaining_stale: 0, verification_failed: false, verification_truncated: false })
      const before = raw.prepare('SELECT value FROM system_kv WHERE key=?').get(STALE_REFRESH_RECEIPT_KEY).value
      cancelled.abort(new Error('older lease lost'))
      release()
      assert.ok((await older) instanceof Error)
      assert.equal(raw.prepare('SELECT value FROM system_kv WHERE key=?').get(STALE_REFRESH_RECEIPT_KEY).value, before)
    } finally { raw.close() }
  })
}

test('two legitimate claims in one clock millisecond still use distinct generations', async () => {
  const raw = new Database(':memory:')
  raw.exec('CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
  const db = { prepare: sql => raw.prepare(sql) }
  const OriginalDate = globalThis.Date
  globalThis.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : ['2026-09-18T01:00:00Z'])) } }
  try {
    const first = await beginStaleRefreshReceipt(db)
    const second = await beginStaleRefreshReceipt(db)
    assert.equal(first.receipt.at, second.receipt.at)
    assert.notEqual(first.receipt.run_id, second.receipt.run_id)
    await assert.rejects(() => finishStaleRefreshReceipt(db, first, { ok: true, complete: true, status: 'complete' }), /superseded/)
    assert.equal(JSON.parse(raw.prepare('SELECT value FROM system_kv WHERE key=?').get(STALE_REFRESH_RECEIPT_KEY).value).run_id, second.receipt.run_id)
  } finally { globalThis.Date = OriginalDate; raw.close() }
})

test('cancellation during the claim read prevents any pending write', async () => {
  const controller = new AbortController()
  let writes = 0
  const db = { prepare: () => ({
    get: async () => { controller.abort(new Error('lease lost')); return undefined },
    run: () => { writes += 1 },
  }) }
  await assert.rejects(() => beginStaleRefreshReceipt(db, { signal: controller.signal }), /lease lost/)
  assert.equal(writes, 0)
})
