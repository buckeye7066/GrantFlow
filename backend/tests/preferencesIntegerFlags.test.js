// Live incident 2026-09-11: PUT /api/preferences answered 500 for EVERY save,
// including the minimal UI body {sidebar_collapsed:false}. Production Postgres
// stores the preference flags (sidebar_collapsed, high_contrast,
// email_notifications, weekly_digest, browser_notifications, reduce_motion,
// screen_reader_optimized) as INTEGER, and the route bound JS booleans, which
// node-pg sends as the text 'false' -> "invalid input syntax for type integer".
// SQLite is untyped, so the bound VALUES are the only thing a test can check:
// 1/0 is valid input for INTEGER, BOOLEAN and SQLite columns alike.
import { beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { getAppAndDb, TEST_ADMIN_AUTH_HEADER } from './testServer.js'

let app
let db
const bound = []

beforeAll(async () => {
  const loaded = await getAppAndDb()
  app = loaded.app
  db = loaded.db
  const originalPrepare = db.prepare.bind(db)
  db.prepare = (sql) => {
    const stmt = originalPrepare(sql)
    if (!/user_preferences/i.test(String(sql)) || !/\b(UPDATE|INSERT)\b/i.test(String(sql))) return stmt
    const originalRun = stmt.run.bind(stmt)
    return new Proxy(stmt, {
      get(target, prop) {
        if (prop === 'run') return (...args) => { bound.push({ sql: String(sql), args }); return originalRun(...args) }
        const value = target[prop]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
})

describe('PUT /api/preferences binds integer-compatible flag values', () => {
  it('never binds a JS boolean and round-trips the saved flags', async () => {
    bound.length = 0
    const res = await request(app)
      .put('/api/preferences')
      .set(TEST_ADMIN_AUTH_HEADER)
      .send({ sidebar_collapsed: true, weekly_digest: false, theme: 'dark' })
    expect(res.status).toBe(200)
    const updates = bound.filter((b) => /UPDATE user_preferences/i.test(b.sql))
    expect(updates.length).toBeGreaterThan(0)
    for (const { args } of updates) {
      expect(args.filter((value) => typeof value === 'boolean')).toEqual([])
    }
    const read = await request(app).get('/api/preferences').set(TEST_ADMIN_AUTH_HEADER)
    expect(read.status).toBe(200)
    expect(read.body.sidebar_collapsed).toBe(true)
    expect(read.body.weekly_digest).toBe(false)
    expect(read.body.theme).toBe('dark')
  })
})
