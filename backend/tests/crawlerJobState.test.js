/**
 * Unit tests for backend/services/crawlerJobState.js
 *
 * These prove the core lifecycle invariants without requiring the full server:
 *   1. Atomic claim — duplicate claimJob() calls never both succeed.
 *   2. Claim sets worker_id, claimed_at, started_at, attempt_count += 1.
 *   3. completeJob requires worker ownership.
 *   4. failJob without force requires worker ownership; with force it works
 *      even if a different worker owns the row.
 *   5. cancelJob moves queued/running → cancelled; terminal states reject.
 *   6. requeueJob moves failed/cancelled/running → queued and clears worker.
 *   7. Valid state transitions are enforced (terminal states don't get
 *      overwritten by claim/complete).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import crypto from 'crypto'
import {
  claimJob,
  completeJob,
  failJob,
  cancelJob,
  requeueJob,
  heartbeatJob,
  isValidTransition,
  jobHasMeaningfulProgress,
  markJobPartial,
  WORKER_ID,
} from '../services/crawlerJobState.js'

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE crawler_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      profile_id TEXT,
      organization_id TEXT,
      parameters TEXT DEFAULT '{}',
      profile_context_snapshot TEXT,
      idempotency_key TEXT,
      result_count INTEGER DEFAULT 0,
      result_meta TEXT,
      error TEXT,
      requested_by TEXT,
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
      completed_at DATETIME
    );
  `)
  // Thin Promise-compatible wrapper that matches backend db shape
  // (prepare(sql).run/.get/.all, all awaitable).
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

async function insertQueued(db, { id = crypto.randomUUID(), type = 'comprehensive', profileId = null } = {}) {
  db.prepare(
    `INSERT INTO crawler_jobs (id, type, status, profile_id, parameters)
     VALUES (?, ?, 'queued', ?, '{}')`,
  ).run(id, type, profileId)
  return id
}

describe('crawlerJobState.isValidTransition', () => {
  it('allows queued → running via claim', () => {
    expect(isValidTransition('claim', 'queued')).toBe(true)
    expect(isValidTransition('claim', 'running')).toBe(false)
    expect(isValidTransition('claim', 'completed')).toBe(false)
  })
  it('allows running → completed via complete', () => {
    expect(isValidTransition('complete', 'running')).toBe(true)
    expect(isValidTransition('complete', 'queued')).toBe(false)
  })
  it('allows queued or running → failed via fail', () => {
    expect(isValidTransition('fail', 'queued')).toBe(true)
    expect(isValidTransition('fail', 'running')).toBe(true)
    expect(isValidTransition('fail', 'completed')).toBe(false)
  })
})

describe('crawlerJobState.claimJob', () => {
  let db
  beforeEach(() => {
    db = makeDb()
  })

  it('atomically claims a queued job and records worker_id, attempt_count, claimed_at', async () => {
    const jobId = await insertQueued(db)
    const res = await claimJob(db, jobId, { workerId: 'worker-a' })

    expect(res.claimed).toBe(true)
    expect(res.job.status).toBe('running')
    expect(res.job.worker_id).toBe('worker-a')
    expect(res.job.attempt_count).toBe(1)
    expect(res.job.claimed_at).toBeTruthy()
    expect(res.job.started_at).toBeTruthy()
    expect(res.job.last_heartbeat_at).toBeTruthy()
  })

  it('prevents two workers from both claiming the same job', async () => {
    const jobId = await insertQueued(db)
    const [a, b] = await Promise.all([
      claimJob(db, jobId, { workerId: 'worker-a' }),
      claimJob(db, jobId, { workerId: 'worker-b' }),
    ])
    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1)
    const row = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row.status).toBe('running')
    expect(['worker-a', 'worker-b']).toContain(row.worker_id)
  })

  it('refuses to claim a job that is not queued', async () => {
    const jobId = await insertQueued(db)
    db.prepare(`UPDATE crawler_jobs SET status = 'failed' WHERE id = ?`).run(jobId)
    const res = await claimJob(db, jobId, { workerId: 'worker-a' })
    expect(res.claimed).toBe(false)
    expect(res.reason).toBe('not_claimable')
  })

  it('increments attempt_count on each successful claim cycle', async () => {
    const jobId = await insertQueued(db)

    await claimJob(db, jobId, { workerId: 'worker-a' })
    // First cycle fails and the job is re-queued
    await failJob(db, jobId, 'boom', { workerId: 'worker-a', force: true })
    await requeueJob(db, jobId, { reason: 'retry' })

    const res2 = await claimJob(db, jobId, { workerId: 'worker-a' })
    expect(res2.claimed).toBe(true)
    expect(res2.job.attempt_count).toBe(2)
  })

  it('respects extraWhereSql (global concurrency guard)', async () => {
    const jobId = await insertQueued(db)
    // Synthetically pretend the limit is already hit: 0 < 0 is false, so claim blocked.
    const res = await claimJob(db, jobId, {
      workerId: 'worker-a',
      extraWhereSql: '(SELECT COUNT(*) FROM crawler_jobs WHERE status = ?) < ?',
      extraWhereParams: ['queued', 0],
    })
    expect(res.claimed).toBe(false)
  })
})

describe('crawlerJobState.completeJob', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('marks a running job completed when worker owns it', async () => {
    const jobId = await insertQueued(db)
    await claimJob(db, jobId, { workerId: 'worker-a' })
    const res = await completeJob(db, jobId, {
      workerId: 'worker-a',
      resultCount: 5,
      resultMeta: { ok: true },
    })
    expect(res.ok).toBe(true)
    const row = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row.status).toBe('completed')
    expect(row.result_count).toBe(5)
    expect(row.completed_at).toBeTruthy()
    expect(JSON.parse(row.result_meta).ok).toBe(true)
  })

  it('refuses to complete when another worker owns the job', async () => {
    const jobId = await insertQueued(db)
    await claimJob(db, jobId, { workerId: 'worker-a' })
    const res = await completeJob(db, jobId, { workerId: 'worker-b' })
    expect(res.ok).toBe(false)
    const row = db.prepare('SELECT status FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row.status).toBe('running')
  })

  it('refuses to complete a non-running job', async () => {
    const jobId = await insertQueued(db)
    const res = await completeJob(db, jobId, { workerId: 'worker-a', resultCount: 1 })
    expect(res.ok).toBe(false)
  })
})

describe('crawlerJobState.failJob', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('marks a running job failed when worker owns it and stores the error', async () => {
    const jobId = await insertQueued(db)
    await claimJob(db, jobId, { workerId: 'worker-a' })
    const res = await failJob(db, jobId, new Error('crawler blew up'), {
      workerId: 'worker-a',
    })
    expect(res.ok).toBe(true)
    const row = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row.status).toBe('failed')
    expect(row.error).toContain('crawler blew up')
  })

  it('force=true fails even when another worker owns the job', async () => {
    const jobId = await insertQueued(db)
    await claimJob(db, jobId, { workerId: 'worker-a' })
    const res = await failJob(db, jobId, 'abandoned', { workerId: 'worker-b', force: true })
    expect(res.ok).toBe(true)
    const row = db.prepare('SELECT status FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row.status).toBe('failed')
  })

  it('does not fail a job already in a terminal state', async () => {
    const jobId = await insertQueued(db)
    db.prepare(`UPDATE crawler_jobs SET status = 'completed' WHERE id = ?`).run(jobId)
    const res = await failJob(db, jobId, 'nope', { force: true })
    expect(res.ok).toBe(false)
  })
})

describe('crawlerJobState.cancelJob / requeueJob', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('cancels a queued job', async () => {
    const jobId = await insertQueued(db)
    const res = await cancelJob(db, jobId, { reason: 'user_cancel' })
    expect(res.ok).toBe(true)
    const row = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row.status).toBe('cancelled')
    expect(row.error).toContain('user_cancel')
  })

  it('cancels a running job regardless of worker', async () => {
    const jobId = await insertQueued(db)
    await claimJob(db, jobId, { workerId: 'worker-a' })
    const res = await cancelJob(db, jobId, { reason: 'stuck' })
    expect(res.ok).toBe(true)
    const row = db.prepare('SELECT status FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row.status).toBe('cancelled')
  })

  it('does not cancel a completed job', async () => {
    const jobId = await insertQueued(db)
    db.prepare(`UPDATE crawler_jobs SET status = 'completed' WHERE id = ?`).run(jobId)
    const res = await cancelJob(db, jobId)
    expect(res.ok).toBe(false)
  })

  it('requeueJob moves a failed job back to queued and clears worker_id', async () => {
    const jobId = await insertQueued(db)
    await claimJob(db, jobId, { workerId: 'worker-a' })
    await failJob(db, jobId, 'transient', { workerId: 'worker-a' })

    const res = await requeueJob(db, jobId, { reason: 'admin_retry' })
    expect(res.ok).toBe(true)
    const row = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row.status).toBe('queued')
    expect(row.worker_id).toBeNull()
    expect(row.claimed_at).toBeNull()
    expect(row.completed_at).toBeNull()
    expect(row.dispatch_attempts).toBe(0)
    // attempt_count is preserved unless resetAttempts is true
    expect(row.attempt_count).toBe(1)
  })

  it('requeueJob with resetAttempts wipes all attempt counters', async () => {
    const jobId = await insertQueued(db)
    await claimJob(db, jobId, { workerId: 'worker-a' })
    await failJob(db, jobId, 'boom', { workerId: 'worker-a' })

    const res = await requeueJob(db, jobId, { resetAttempts: true })
    expect(res.ok).toBe(true)
    const row = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row.attempt_count).toBe(0)
    expect(row.retry_count).toBe(0)
    expect(row.dispatch_attempts).toBe(0)
  })
})

describe('crawlerJobState.heartbeatJob', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('updates last_heartbeat_at only when the current worker owns the running job', async () => {
    const jobId = await insertQueued(db)
    await claimJob(db, jobId, { workerId: 'worker-a' })

    // Reset heartbeat to confirm the update fires
    db.prepare(`UPDATE crawler_jobs SET last_heartbeat_at = NULL WHERE id = ?`).run(jobId)

    const ok = await heartbeatJob(db, jobId, { workerId: 'worker-a' })
    expect(ok.ok).toBe(true)

    const row = db.prepare('SELECT last_heartbeat_at FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row.last_heartbeat_at).toBeTruthy()
  })

  it('does not update heartbeat when a different worker calls it', async () => {
    const jobId = await insertQueued(db)
    await claimJob(db, jobId, { workerId: 'worker-a' })
    db.prepare(`UPDATE crawler_jobs SET last_heartbeat_at = NULL WHERE id = ?`).run(jobId)

    const res = await heartbeatJob(db, jobId, { workerId: 'worker-b' })
    expect(res.ok).toBe(false)
    const row = db.prepare('SELECT last_heartbeat_at FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row.last_heartbeat_at).toBeNull()
  })
})

describe('crawlerJobState.WORKER_ID', () => {
  it('is a stable non-empty string unique-ish per process', () => {
    expect(typeof WORKER_ID).toBe('string')
    expect(WORKER_ID.length).toBeGreaterThan(5)
    expect(WORKER_ID).toContain(String(process.pid))
  })
})

// ---------------------------------------------------------------------------
// Partial completion — mission-critical for geo crawls
// ---------------------------------------------------------------------------
//
// Regression for the "Job ID 665bc046-…" bug: a 6-hour geo crawl produced
// 3,891 ZIPs / 93,384 sources with 0 failed / 0 skipped, but the worker died
// mid-state-6 and the orphan-cleanup stamped the row `failed`. Per mission
// rules ("counts displayed in the UI must map 1:1 to backend response fields";
// "real, persisted output is success"), real work must NOT be reclassified as
// failure. markJobPartial encodes that semantic.

describe('crawlerJobState.jobHasMeaningfulProgress', () => {
  it('returns false for null / empty rows', () => {
    expect(jobHasMeaningfulProgress(null)).toBe(false)
    expect(jobHasMeaningfulProgress(undefined)).toBe(false)
    expect(jobHasMeaningfulProgress({})).toBe(false)
    expect(jobHasMeaningfulProgress({ result_count: 0, result_meta: null })).toBe(false)
  })

  it('returns true when result_count > 0', () => {
    expect(jobHasMeaningfulProgress({ result_count: 1 })).toBe(true)
    expect(jobHasMeaningfulProgress({ result_count: 93384 })).toBe(true)
  })

  it('returns true when result_meta JSON contains processed > 0', () => {
    const meta = JSON.stringify({ processed: 3891, sources: 93384, failed: 0, skipped: 0 })
    expect(jobHasMeaningfulProgress({ result_count: 0, result_meta: meta })).toBe(true)
  })

  it('returns true when result_meta JSON contains sources > 0', () => {
    const meta = JSON.stringify({ processed: 0, sources: 12 })
    expect(jobHasMeaningfulProgress({ result_meta: meta })).toBe(true)
  })

  it('accepts an already-parsed object as result_meta', () => {
    expect(
      jobHasMeaningfulProgress({ result_meta: { processed: 100, sources: 5 } }),
    ).toBe(true)
  })

  it('returns false when result_meta has 0 progress on every counter', () => {
    const meta = JSON.stringify({ processed: 0, sources: 0, failed: 0, skipped: 0 })
    expect(jobHasMeaningfulProgress({ result_count: 0, result_meta: meta })).toBe(false)
  })

  it('handles malformed result_meta JSON without throwing', () => {
    expect(jobHasMeaningfulProgress({ result_meta: '{not json' })).toBe(false)
  })
})

describe('crawlerJobState.markJobPartial', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('moves a running job to completed with result_meta.partial=true', async () => {
    const jobId = await insertQueued(db)
    await claimJob(db, jobId, { workerId: 'worker-a' })
    // Simulate the comprehensive crawler's intermediate flush after state 5/51.
    db.prepare(
      `UPDATE crawler_jobs
         SET result_count = 93384,
             result_meta = ?
       WHERE id = ?`,
    ).run(
      JSON.stringify({
        mode: 'geo', run_all_states: true,
        states_completed: 5, states_total: 51,
        processed: 3891, sources: 93384, failed: 0, skipped: 0,
      }),
      jobId,
    )

    const res = await markJobPartial(db, jobId, {
      reason: 'withTimeout',
      error: 'Job comprehensive timed out after 21600s',
      durationSeconds: 21600,
    }, { workerId: 'worker-a' })

    expect(res.ok).toBe(true)
    const row = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row.status).toBe('completed')
    expect(row.error).toBeNull()
    const meta = JSON.parse(row.result_meta)
    expect(meta.partial).toBe(true)
    expect(meta.partial_reason).toBe('withTimeout')
    expect(meta.partial_error).toContain('timed out')
    // All previously-flushed counters must be preserved.
    expect(meta.sources).toBe(93384)
    expect(meta.processed).toBe(3891)
    expect(meta.states_completed).toBe(5)
    expect(meta.states_total).toBe(51)
  })

  it('refuses to touch a job a different worker owns when force=false', async () => {
    const jobId = await insertQueued(db)
    await claimJob(db, jobId, { workerId: 'worker-a' })
    const res = await markJobPartial(db, jobId,
      { reason: 'withTimeout' },
      { workerId: 'worker-b' },
    )
    expect(res.ok).toBe(false)
    const row = db.prepare('SELECT status FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row.status).toBe('running')
  })

  it('honors force=true so orphan-cleanup can claim the partial transition', async () => {
    const jobId = await insertQueued(db)
    await claimJob(db, jobId, { workerId: 'worker-a' })
    // Simulate worker death — orphan-cleanup runs from a different worker.
    const res = await markJobPartial(db, jobId,
      { reason: 'heartbeat_stale', error: 'last heartbeat > 300000ms ago' },
      { workerId: 'cleanup-worker', force: true },
    )
    expect(res.ok).toBe(true)
    const row = db.prepare('SELECT status, result_meta FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row.status).toBe('completed')
    expect(JSON.parse(row.result_meta).partial_reason).toBe('heartbeat_stale')
  })

  it('writes partial=true even when there was no prior result_meta', async () => {
    const jobId = await insertQueued(db)
    await claimJob(db, jobId, { workerId: 'worker-a' })
    const res = await markJobPartial(db, jobId,
      { reason: 'withTimeout' },
      { workerId: 'worker-a' },
    )
    expect(res.ok).toBe(true)
    const row = db.prepare('SELECT result_meta FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(JSON.parse(row.result_meta)).toMatchObject({
      partial: true,
      partial_reason: 'withTimeout',
    })
  })
})
