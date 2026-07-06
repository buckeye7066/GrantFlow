/**
 * Integration tests for /api/admin/queue/* (admin queue ops).
 *
 * These tests prove the admin-guarded maintenance endpoints work end-to-end
 * with a live express app and in-memory SQLite:
 *   1. Without admin token → 403 on ops endpoints
 *   2. With admin token    → stats + list work
 *   3. Requeue moves failed → queued and clears worker_id
 *   4. Cancel moves queued → cancelled
 *   5. Recover-stale runs cleanly with no stale jobs
 */

import request from 'supertest'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import crypto from 'crypto'
import { getAppAndDb, resetDb, TEST_ADMIN_AUTH_HEADER } from './testServer.js'

function insertJob(db, { status = 'queued', type = 'comprehensive', workerId = null, error = null } = {}) {
  const id = crypto.randomUUID()
  db.prepare(
    `INSERT INTO crawler_jobs (id, type, status, worker_id, error, parameters)
     VALUES (?, ?, ?, ?, ?, '{}')`,
  ).run(id, type, status, workerId, error)
  return id
}

describe('admin queue ops', () => {
  let app
  let db

  beforeAll(async () => {
    const loaded = await getAppAndDb()
    app = loaded.app
    db = loaded.db
  }, 60_000)

  beforeEach(() => {
    resetDb(db)
  })

  it('rejects unauthenticated callers with 401', async () => {
    // The /api/admin choke-point gate (server.js) runs ensureAuth first, so a
    // caller with NO credentials gets 401 (unauthenticated); an authenticated
    // non-admin gets 403 from ensureAdmin.
    const res = await request(app).get('/api/admin/queue/stats')
    expect(res.status).toBe(401)
  })

  it('returns stats and status counts for admin', async () => {
    insertJob(db, { status: 'queued' })
    insertJob(db, { status: 'queued' })
    insertJob(db, { status: 'failed', error: 'boom' })

    const res = await request(app)
      .get('/api/admin/queue/stats')
      .set(TEST_ADMIN_AUTH_HEADER)

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('status_counts')
    expect(res.body.status_counts.queued).toBe(2)
    expect(res.body.status_counts.failed).toBe(1)
    expect(res.body).toHaveProperty('stale_running_count')
  })

  it('lists jobs with filters', async () => {
    insertJob(db, { status: 'failed', type: 'comprehensive', error: 'x' })
    insertJob(db, { status: 'failed', type: 'scholarship', error: 'y' })
    insertJob(db, { status: 'queued', type: 'comprehensive' })

    const res = await request(app)
      .get('/api/admin/queue/jobs?status=failed')
      .set(TEST_ADMIN_AUTH_HEADER)

    expect(res.status).toBe(200)
    expect(res.body.total).toBe(2)
    expect(res.body.rows.every((r) => r.status === 'failed')).toBe(true)
  })

  it('requeues a failed job and clears worker_id', async () => {
    const jobId = insertJob(db, {
      status: 'failed',
      workerId: 'host:123:abc',
      error: 'transient',
    })

    const res = await request(app)
      .post(`/api/admin/queue/jobs/${jobId}/requeue`)
      .set(TEST_ADMIN_AUTH_HEADER)
      .send({ reason: 'operator_retry', reset_attempts: true })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.job.status).toBe('queued')
    expect(res.body.job.worker_id).toBeNull()
    expect(res.body.job.attempt_count).toBe(0)
  })

  it('cancels a queued job', async () => {
    const jobId = insertJob(db, { status: 'queued' })

    const res = await request(app)
      .post(`/api/admin/queue/jobs/${jobId}/cancel`)
      .set(TEST_ADMIN_AUTH_HEADER)
      .send({ reason: 'no_longer_needed' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.job.status).toBe('cancelled')
    expect(res.body.job.error).toContain('no_longer_needed')
  })

  it('returns 409 when requeueing a completed job', async () => {
    const jobId = insertJob(db, { status: 'queued' })
    db.prepare(`UPDATE crawler_jobs SET status = 'completed' WHERE id = ?`).run(jobId)

    const res = await request(app)
      .post(`/api/admin/queue/jobs/${jobId}/requeue`)
      .set(TEST_ADMIN_AUTH_HEADER)
      .send({ reason: 'should_fail' })

    expect(res.status).toBe(409)
  })

  it('returns 404 for unknown job ids', async () => {
    const res = await request(app)
      .post(`/api/admin/queue/jobs/does-not-exist/cancel`)
      .set(TEST_ADMIN_AUTH_HEADER)
    expect(res.status).toBe(404)
  })

  it('recover-stale runs cleanly with no stale jobs', async () => {
    const res = await request(app)
      .post('/api/admin/queue/recover-stale')
      .set(TEST_ADMIN_AUTH_HEADER)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(typeof res.body.cleaned_running).toBe('number')
    expect(typeof res.body.cleaned_queued).toBe('number')
  })
})
