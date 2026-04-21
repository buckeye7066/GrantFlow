/**
 * crawlerJobReclaim.test.js
 *
 * Race/ownership edge-case tests for crawlerJobState.
 *
 * The concern locked down here:
 *
 *   1. Worker A claims a job and starts work.
 *   2. Stale-recovery (or an admin) requeues the job because A's heartbeat went
 *      cold. A new worker B then claims the requeued job.
 *   3. Worker A finally returns — whether to report completion or failure — and
 *      must NOT corrupt worker B's in-flight state.
 *
 * The contract we prove:
 *   - Worker A's late `completeJob` is a no-op once ownership has rotated.
 *   - Worker A's late scoped `failJob` (no `force`) is a no-op — it cannot
 *     overwrite B's running row.
 *   - Admin `failJob({ force: true })` still works while B is running (operator
 *     override), and the row moves to `failed`.
 *   - A job that has already `completed` can never be transitioned to `failed`
 *     by a late-arriving worker (terminal-state integrity).
 */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import crypto from 'crypto'
import {
  claimJob,
  completeJob,
  failJob,
  requeueJob,
} from '../services/crawlerJobState.js'

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE crawler_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      profile_id TEXT,
      parameters TEXT DEFAULT '{}',
      dispatch_attempts INTEGER DEFAULT 0,
      next_dispatch_at DATETIME,
      retry_count INTEGER DEFAULT 0,
      last_retry_at DATETIME,
      last_heartbeat_at DATETIME,
      worker_id TEXT,
      attempt_count INTEGER DEFAULT 0,
      claimed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME,
      error TEXT,
      result_count INTEGER,
      result_meta TEXT
    );
  `)
  return {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        run: (...a) => stmt.run(...a),
        get: (...a) => stmt.get(...a),
        all: (...a) => stmt.all(...a),
      }
    },
    exec: (sql) => raw.exec(sql),
  }
}

function enqueueJob(db) {
  const id = crypto.randomUUID()
  db.prepare(
    `INSERT INTO crawler_jobs (id, type, status) VALUES (?, 'comprehensive', 'queued')`,
  ).run(id)
  return id
}

describe('crawlerJobState — reclaim / force-fail race', () => {
  it('late completeJob from a rotated-out worker is a no-op', async () => {
    const db = makeDb()
    const jobId = enqueueJob(db)

    // Worker A claims the job.
    const claimA = await claimJob(db, jobId, { workerId: 'worker-A' })
    expect(claimA.claimed).toBe(true)

    // Stale-recovery requeues the job (simulated admin/stale handler).
    const req = await requeueJob(db, jobId, { reason: 'stale_heartbeat' })
    expect(req.ok).toBe(true)

    // Worker B claims the requeued job.
    const claimB = await claimJob(db, jobId, { workerId: 'worker-B' })
    expect(claimB.claimed).toBe(true)

    const rowAfterB = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(rowAfterB.worker_id).toBe('worker-B')
    expect(rowAfterB.status).toBe('running')

    // Worker A finally tries to report success — must be a no-op.
    const lateComplete = await completeJob(db, jobId, {
      workerId: 'worker-A',
      resultCount: 99,
    })
    expect(lateComplete.ok).toBe(false)

    const rowAfterLateComplete = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(rowAfterLateComplete.worker_id).toBe('worker-B')
    expect(rowAfterLateComplete.status).toBe('running')
    expect(rowAfterLateComplete.result_count).toBeFalsy()
  })

  it('late scoped failJob from a rotated-out worker is a no-op', async () => {
    const db = makeDb()
    const jobId = enqueueJob(db)
    await claimJob(db, jobId, { workerId: 'worker-A' })
    await requeueJob(db, jobId, { reason: 'stale_heartbeat' })
    await claimJob(db, jobId, { workerId: 'worker-B' })

    // Worker A's scoped fail — must NOT corrupt worker B's state.
    const lateFail = await failJob(db, jobId, 'A crashed late', {
      workerId: 'worker-A',
    })
    expect(lateFail.ok).toBe(false)

    const row = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row.worker_id).toBe('worker-B')
    expect(row.status).toBe('running')
    expect(row.error).toBeFalsy()
  })

  it('admin force failJob wins even over an active owner', async () => {
    const db = makeDb()
    const jobId = enqueueJob(db)
    await claimJob(db, jobId, { workerId: 'worker-A' })
    await requeueJob(db, jobId, { reason: 'stale_heartbeat' })
    await claimJob(db, jobId, { workerId: 'worker-B' })

    // Admin force-fails the job regardless of ownership.
    const adminFail = await failJob(db, jobId, 'hard-stopped by admin', {
      force: true,
    })
    expect(adminFail.ok).toBe(true)

    const row = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row.status).toBe('failed')
    expect(row.error).toContain('hard-stopped by admin')
  })

  it('completed job is immune to a late force fail (terminal-state integrity)', async () => {
    const db = makeDb()
    const jobId = enqueueJob(db)
    await claimJob(db, jobId, { workerId: 'worker-A' })

    const ok = await completeJob(db, jobId, { workerId: 'worker-A', resultCount: 7 })
    expect(ok.ok).toBe(true)

    const lateForceFail = await failJob(db, jobId, 'stale recover tried to fail', {
      force: true,
    })
    // failJob only acts on status IN ('queued','running') so completed rows
    // must remain completed.
    expect(lateForceFail.ok).toBe(false)

    const row = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row.status).toBe('completed')
    expect(row.result_count).toBe(7)
  })

  it('requeue after failure resets ownership and clears the worker_id', async () => {
    const db = makeDb()
    const jobId = enqueueJob(db)
    await claimJob(db, jobId, { workerId: 'worker-A' })
    await failJob(db, jobId, 'boom', { workerId: 'worker-A' })

    const req = await requeueJob(db, jobId, { reason: 'retry', resetAttempts: true })
    expect(req.ok).toBe(true)

    const row = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row.status).toBe('queued')
    expect(row.worker_id).toBeNull()
    expect(row.attempt_count).toBe(0)

    // A new worker can now claim cleanly.
    const claim = await claimJob(db, jobId, { workerId: 'worker-C' })
    expect(claim.claimed).toBe(true)
    const row2 = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row2.worker_id).toBe('worker-C')
    expect(row2.attempt_count).toBe(1)
  })
})
