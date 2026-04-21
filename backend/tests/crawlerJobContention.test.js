/**
 * Multi-worker contention test for crawlerJobState.claimJob
 *
 * Proves that under simulated parallel claim attempts, exactly one worker
 * wins per job. Uses an in-memory SQLite DB with the same shape as the
 * production schema.
 *
 * This is the concurrency guarantee the production dispatcher relies on: the
 * DB row itself is the lock, via a conditional UPDATE.
 */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import crypto from 'crypto'
import { claimJob } from '../services/crawlerJobState.js'

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

describe('claimJob — multi-worker contention', () => {
  it('exactly one worker claims a job when N workers race', async () => {
    const db = makeDb()
    const jobId = crypto.randomUUID()
    db.prepare(
      `INSERT INTO crawler_jobs (id, type, status) VALUES (?, 'comprehensive', 'queued')`,
    ).run(jobId)

    const workers = Array.from({ length: 16 }, (_, i) => `worker-${i}`)
    const results = await Promise.all(workers.map((w) => claimJob(db, jobId, { workerId: w })))
    const claims = results.filter((r) => r.claimed)

    expect(claims).toHaveLength(1)

    const row = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row.status).toBe('running')
    expect(row.attempt_count).toBe(1)
    expect(workers).toContain(row.worker_id)
  })

  it('under batch load, N workers draining M jobs each claim at most once per job', async () => {
    const db = makeDb()
    const N = 20
    const jobIds = []
    for (let i = 0; i < N; i++) {
      const id = crypto.randomUUID()
      db.prepare(
        `INSERT INTO crawler_jobs (id, type, status) VALUES (?, 'comprehensive', 'queued')`,
      ).run(id)
      jobIds.push(id)
    }

    // Simulate 4 workers each trying to drain the whole queue
    const workerIds = ['w1', 'w2', 'w3', 'w4']
    const attempts = []
    for (const w of workerIds) {
      for (const j of jobIds) {
        attempts.push(claimJob(db, j, { workerId: w }))
      }
    }

    const results = await Promise.all(attempts)
    const byJob = new Map()
    for (let i = 0; i < results.length; i++) {
      const res = results[i]
      if (!res.claimed) continue
      const idx = Math.floor(i / jobIds.length)
      const jobIdx = i % jobIds.length
      const jobId = jobIds[jobIdx]
      const worker = workerIds[idx]
      byJob.set(jobId, [...(byJob.get(jobId) || []), worker])
    }

    expect(byJob.size).toBe(N)
    for (const [, claimants] of byJob) {
      expect(claimants).toHaveLength(1)
    }

    const running = db.prepare(`SELECT COUNT(*) AS c FROM crawler_jobs WHERE status = 'running'`).get()
    expect(running.c).toBe(N)
  })
})
