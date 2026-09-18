import { afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { beginStaleRefreshReceipt, finishStaleRefreshReceipt, STALE_REFRESH_RECEIPT_KEY } from '../services/matching/staleMatchRefreshReceipt.js'
import { getCheckById } from '../services/sam/samRegistry.js'

const opened = []
afterEach(() => { vi.useRealTimers(); for (const raw of opened.splice(0)) raw.close() })
const lockName = 'scheduler:link-verification'
const lease = ownerToken => ({ lockName, ownerToken })
function fixture(owner = 'first') {
  const raw = new Database(':memory:'); opened.push(raw)
  raw.exec(`CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE agent_control_locks (lock_name TEXT PRIMARY KEY, owner_token TEXT, expires_at TEXT);`)
  raw.prepare('INSERT INTO agent_control_locks VALUES (?, ?, ?)').run(lockName, owner, '2099-01-01T00:00:00Z')
  return { raw, db: { dialect: 'sqlite', prepare: sql => raw.prepare(sql) } }
}
const completion = { ok: true, complete: true, status: 'complete', remaining_candidates: 0,
  remaining_stale: 0, verification_failed: false, verification_truncated: false }
const stored = raw => raw.prepare('SELECT value FROM system_kv WHERE key = ?').get(STALE_REFRESH_RECEIPT_KEY)?.value

it.each(['same clock', 'older clock ahead'])('a delayed read cannot replace a newer lease result: %s', async mode => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-18T12:00:00Z'))
  const { raw, db } = fixture('first')
  let releaseRead, reachedRead
  const entered = new Promise(resolve => { reachedRead = resolve })
  const delayed = { dialect: 'sqlite', prepare(sql) {
    const statement = raw.prepare(sql)
    if (/^SELECT value/.test(sql)) return { get: async (...args) => {
      reachedRead(); await new Promise(resolve => { releaseRead = resolve }); return statement.get(...args)
    } }
    return statement
  } }
  const older = beginStaleRefreshReceipt(delayed, { lease: lease('first') }).catch(error => error)
  await entered
  raw.prepare('UPDATE agent_control_locks SET owner_token=? WHERE lock_name=?').run('second', lockName)
  if (mode === 'older clock ahead') vi.setSystemTime(new Date('2026-09-18T11:00:00Z'))
  const newer = await beginStaleRefreshReceipt(db, { lease: lease('second') })
  await finishStaleRefreshReceipt(db, newer, completion)
  const before = stored(raw)
  releaseRead()
  expect(await older).toBeInstanceOf(Error)
  expect(stored(raw)).toBe(before)
})
it('requires a real scheduler identity before starting receipt work', async () => {
  const { db, raw } = fixture()
  await expect(beginStaleRefreshReceipt(db)).rejects.toThrow(/scheduler lease/)
  expect(stored(raw)).toBeUndefined()
})
it.each(['wrong owner', 'expired'])('refuses a %s lease at the write boundary', async mode => {
  const { db, raw } = fixture()
  if (mode === 'expired') raw.prepare('UPDATE agent_control_locks SET expires_at=?').run('2000-01-01T00:00:00Z')
  await expect(beginStaleRefreshReceipt(db, { lease: lease(mode === 'wrong owner' ? 'not-owner' : 'first') })).rejects.toThrow()
  expect(stored(raw)).toBeUndefined()
})
it('does not publish a terminal result after lease ownership changed before the heartbeat noticed', async () => {
  const { db, raw } = fixture()
  const attempt = await beginStaleRefreshReceipt(db, { lease: lease('first') })
  const before = stored(raw)
  raw.prepare('UPDATE agent_control_locks SET owner_token=?').run('new-owner')
  await expect(finishStaleRefreshReceipt(db, attempt, completion)).rejects.toThrow()
  expect(stored(raw)).toBe(before)
})

function storeReceipt(raw, extra = {}) {
  const at = new Date().toISOString()
  raw.prepare('INSERT INTO system_kv VALUES (?, ?, ?)').run(STALE_REFRESH_RECEIPT_KEY,
    JSON.stringify({ ...completion, name: 'stale_match_explain_refresh', started_at: at, at, ...extra }), at)
}
it('reports missing boot evidence rather than certifying all sweeps from one completed batch', async () => {
  const { db, raw } = fixture(); storeReceipt(raw)
  const result = await getCheckById('pipeline.invariantSweepOutcomes').run({ db })
  expect(result.ok).toBe(false)
  expect(result.evidence.stale_match_refresh).toMatchObject({ status: 'complete', complete: true })
  expect(result.evidence.failed).toContainEqual(expect.objectContaining({ name: 'invariant_boot_evidence', status: 'unavailable' }))
})
it.each(['failed', 'running', 'complete'])('still reads %s recurring progress when boot JSON is malformed', async status => {
  const { db, raw } = fixture()
  raw.prepare('INSERT INTO system_kv VALUES (?, ?, ?)').run('enforce_invariants_last_run', '{broken', new Date().toISOString())
  storeReceipt(raw, { status, ok: status === 'complete', complete: status === 'complete' })
  const result = await getCheckById('pipeline.invariantSweepOutcomes').run({ db })
  expect(result.ok).toBe(false)
  expect(result.evidence.stale_match_refresh.status).toBe(status)
  expect(result.evidence.failed).toContainEqual(expect.objectContaining({ name: 'invariant_boot_evidence', status: 'unavailable' }))
  expect(raw.prepare('SELECT value FROM system_kv WHERE key=?').get('enforce_invariants_last_run').value).toBe('{broken')
})
