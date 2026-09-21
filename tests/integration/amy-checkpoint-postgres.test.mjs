import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { readAmyRunCheckpoint, writeAmyRunCheckpoint, clearAmyRunCheckpoint } from '../../backend/services/amy/amyRunCheckpoint.js'

test('Amy checkpoint survives PostgreSQL reconnects and rejects concurrent stale updates', async () => {
  const raw = process.env.GRANTFLOW_AMY_TEST_DATABASE_URL
  assert.ok(raw, 'Set GRANTFLOW_AMY_TEST_DATABASE_URL to a disposable localhost PostgreSQL database')
  const url = new URL(raw)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  const schema = `grantflow_amy_${randomUUID().replaceAll('-', '')}`
  const control = new pg.Pool({ connectionString: raw })
  let db
  try {
    await control.query(`CREATE SCHEMA ${schema}`)
    url.searchParams.set('options', `-csearch_path=${schema}`)
    process.env.NODE_ENV = 'test'
    process.env.DB_PROVIDER = 'postgres'
    process.env.DATABASE_URL = url.href
    db = (await import('../../backend/db/index.js')).getDb()
    const value = { version: 1, run_id: 'synthetic-pg-run', started_at: new Date().toISOString(),
      options: { applyTuning: false }, plan: { scenarios: [{ scenario_id: 'one' }] },
      members: [{ scenario_id: 'one', profile_id: 'synthetic-one', evaluation: null }] }
    const initial = await writeAmyRunCheckpoint(db, null, value)
    const next = { ...value, members: [{ ...value.members[0], evaluation: { status: 'ok' } }] }
    const results = await Promise.allSettled([
      writeAmyRunCheckpoint(db, initial, next), writeAmyRunCheckpoint(db, initial, { ...next, stale: true }),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
    await assert.rejects(clearAmyRunCheckpoint(db, initial), /changed/)
    const saved = await readAmyRunCheckpoint(db)
    assert.equal(saved.value.members[0].evaluation.status, 'ok')
    const freshConnection = new pg.Pool({ connectionString: url.href })
    try {
      const row = await freshConnection.query('SELECT value FROM system_kv WHERE key = $1', ['amy_active_run_checkpoint'])
      assert.equal(JSON.parse(row.rows[0].value).run_id, value.run_id)
    } finally { await freshConnection.end() }
    await clearAmyRunCheckpoint(db, saved)
    assert.equal(await readAmyRunCheckpoint(db), null)
  } finally {
    if (db) await db.close()
    await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await control.end()
  }
})
