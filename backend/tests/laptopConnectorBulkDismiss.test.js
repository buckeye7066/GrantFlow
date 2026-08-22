/**
 * Bulk-erase the Laptop Inbox review queues: reject an explicit id set, a whole
 * candidate_type, or every pending item — mirroring the per-item dismiss
 * (only 'pending' rows flip, so accepted rows are never resurrected).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'a'.repeat(64)
const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')

let db
let router
const app = ({ isAdmin = true } = {}) => {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    req.db = db
    const uid = isAdmin ? 'u1' : 'u2'
    req.user = { userId: uid, role: isAdmin ? 'admin' : 'user' }
    req.ctx = { userId: uid, isAdmin, identityResolved: true }
    next()
  })
  a.use('/api/laptop-connector', router)
  return a
}

const seed = (id, type, status = 'pending') =>
  db
    .prepare(
      `INSERT INTO laptop_review_items (id, candidate_type, title, status) VALUES (?, ?, ?, ?)`,
    )
    .run(id, type, `${type}-${id}`, status)

const statusOf = async (id) =>
  (await db.prepare('SELECT status FROM laptop_review_items WHERE id = ?').get(id))?.status

beforeEach(async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, is_admin INTEGER DEFAULT 1);
    CREATE TABLE laptop_review_items (
      id TEXT PRIMARY KEY, run_id TEXT, document_id TEXT, candidate_type TEXT NOT NULL,
      target_profile_id TEXT, title TEXT NOT NULL, summary TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}', provenance_json TEXT NOT NULL DEFAULT '{}',
      confidence REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, acted_at DATETIME, action_result TEXT
    );
  `)
  db = wrapSqlite(sqlite)
  await db.prepare('INSERT INTO users (id, is_admin) VALUES (?, 1)').run('u1')
  await seed('pf1', 'profile_field')
  await seed('pf2', 'profile_field')
  await seed('lead1', 'lead')
  await seed('lead2', 'lead')
  await seed('fund1', 'funding')
  await seed('done1', 'profile_field', 'accepted') // already actioned — must not flip
  router = (await import('../routes/laptopConnector.js')).default
})

describe('POST /review/bulk-dismiss', () => {
  it('dismisses an explicit id set (and never touches an accepted row)', async () => {
    const res = await request(app())
      .post('/api/laptop-connector/review/bulk-dismiss')
      .send({ ids: ['pf1', 'pf2', 'done1'] })
    expect(res.status).toBe(200)
    expect(res.body.dismissed).toBe(2) // done1 is already accepted → skipped
    expect(await statusOf('pf1')).toBe('dismissed')
    expect(await statusOf('done1')).toBe('accepted')
    expect(await statusOf('lead1')).toBe('pending')
  })

  it('dismisses a whole candidate_type (en masse)', async () => {
    const res = await request(app())
      .post('/api/laptop-connector/review/bulk-dismiss')
      .send({ type: 'lead' })
    expect(res.status).toBe(200)
    expect(res.body.dismissed).toBe(2)
    expect(await statusOf('lead1')).toBe('dismissed')
    expect(await statusOf('lead2')).toBe('dismissed')
    expect(await statusOf('pf1')).toBe('pending')
  })

  it('dismisses every pending item with all:true', async () => {
    const res = await request(app())
      .post('/api/laptop-connector/review/bulk-dismiss')
      .send({ all: true })
    expect(res.status).toBe(200)
    expect(res.body.dismissed).toBe(5) // 5 pending; done1 excluded
    expect(await statusOf('done1')).toBe('accepted')
  })

  it('is idempotent — a second run dismisses 0', async () => {
    await request(app()).post('/api/laptop-connector/review/bulk-dismiss').send({ type: 'lead' })
    const res = await request(app())
      .post('/api/laptop-connector/review/bulk-dismiss')
      .send({ type: 'lead' })
    expect(res.body.dismissed).toBe(0)
  })

  it('requires a target and is admin-only', async () => {
    expect(
      (await request(app()).post('/api/laptop-connector/review/bulk-dismiss').send({})).status,
    ).toBe(400)
    expect(
      (
        await request(app({ isAdmin: false }))
          .post('/api/laptop-connector/review/bulk-dismiss')
          .send({ all: true })
      ).status,
    ).toBe(403)
  })
})
