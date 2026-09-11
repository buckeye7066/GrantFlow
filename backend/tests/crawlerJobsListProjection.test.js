// Live incident 2026-09-11: GET /api/crawlers/jobs timed out (45s) on production.
// The list did SELECT * and shipped profile_context_snapshot for every row; those
// snapshots averaged 2.9MB (32MB max) across the latest 100 jobs. The list is a
// status view - the snapshot belongs only on the single-job read.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { getAppAndDb, resetDb, TEST_ADMIN_AUTH_HEADER } from './testServer.js'

let app
let db

beforeAll(async () => {
  const loaded = await getAppAndDb()
  app = loaded.app
  db = loaded.db
})

beforeEach(() => {
  resetDb(db)
})

describe('GET /api/crawlers/jobs list projection', () => {
  it('omits the per-job profile snapshot from the list but keeps it on the single-job read', async () => {
    const bigSnapshot = JSON.stringify({ profile: { id: 'p-list' }, filler: 'x'.repeat(200000) })
    db.prepare(
      `INSERT INTO crawler_jobs (id, type, status, parameters, profile_context_snapshot, result_meta)
       VALUES ('job-list-1', 'profile_enrichment', 'completed', '{}', ?, '{"stored":1}')`,
    ).run(bigSnapshot)

    const list = await request(app).get('/api/crawlers/jobs').set(TEST_ADMIN_AUTH_HEADER)
    expect(list.status).toBe(200)
    const row = list.body.find((job) => job.id === 'job-list-1')
    expect(row).toBeTruthy()
    expect(row.status).toBe('completed')
    expect(row.result_meta).toEqual({ stored: 1 })
    expect(row).not.toHaveProperty('profile_context_snapshot')
    expect(JSON.stringify(list.body).length).toBeLessThan(20000)

    const single = await request(app).get('/api/crawlers/jobs/job-list-1').set(TEST_ADMIN_AUTH_HEADER)
    expect(single.status).toBe(200)
    expect(JSON.stringify(single.body)).toContain('filler')
  })
})

describe('GET /api/real-crawlers/find-profile validation', () => {
  it('answers a missing name with 400, not a 200 carrying an error', async () => {
    const res = await request(app).get('/api/real-crawlers/find-profile').set(TEST_ADMIN_AUTH_HEADER)
    expect(res.status).toBe(400)
  })
})
