/**
 * orphanHeartbeatRetry.test.js
 *
 * The 5-minute heartbeat sweep (cleanupStaleCrawlersByHeartbeat) is what fires
 * when a deploy/OOM kills a worker mid-job. Until 2026-07 it terminal-failed
 * every orphan while only the 7-hour started-at sweep auto-retried — so a
 * deploy during document ingestion permanently lost the work (Liubov's three
 * document_ingest jobs, 2026-07-01). These tests lock down the shared retry:
 *
 *   1. A heartbeat-orphaned job is failed AND a fresh queued copy is inserted
 *      (parameters carry retried_from_job_id + orphan_retry_generation).
 *   2. The generation cap stops the retry chain — a job that orphans on every
 *      attempt cannot spawn fresh rows forever (each copy starts with
 *      retry_count 0, so only the generation counter can bound the chain).
 *   3. Retired crawler types and jobs with meaningful progress keep their
 *      existing behavior (never retried / partial-complete).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import crypto from 'crypto'
import {
  cleanupStaleCrawlersByHeartbeat,
  autoRetryOrphanedJob,
} from '../services/crawlerConcurrencyGuard.js'

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
      idempotency_key TEXT,
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
      completed_at DATETIME,
      error TEXT,
      result_count INTEGER,
      result_meta TEXT
    );
    CREATE TABLE dead_letter_jobs (
      id TEXT PRIMARY KEY, job_id TEXT, job_type TEXT, profile_id TEXT,
      error TEXT, severity TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return raw
}

const STALE = new Date(Date.now() - 30 * 60 * 1000).toISOString() // 30 min ago

function insertRunningJob(db, { type = 'document_ingest', parameters = {}, id = crypto.randomUUID() } = {}) {
  db.prepare(
    `INSERT INTO crawler_jobs (id, type, status, profile_id, parameters, worker_id, started_at, last_heartbeat_at)
     VALUES (?, ?, 'running', 'profile-1', ?, 'dead-worker', ?, ?)`,
  ).run(id, type, JSON.stringify(parameters), STALE, STALE)
  return id
}

describe('cleanupStaleCrawlersByHeartbeat — orphan auto-requeue', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('fails the orphan AND inserts a fresh queued copy with generation tracking', async () => {
    const jobId = insertRunningJob(db, { parameters: { document_id: 'doc-1', source: 'upload' } })

    const cleaned = await cleanupStaleCrawlersByHeartbeat(db, 5 * 60 * 1000)
    expect(cleaned).toBe(1)

    const original = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(original.status).toBe('failed')
    expect(original.error).toContain('heartbeat stale')

    const retry = db.prepare("SELECT * FROM crawler_jobs WHERE status = 'queued'").get()
    expect(retry).toBeTruthy()
    expect(retry.type).toBe('document_ingest')
    expect(retry.requested_by).toBe('system:orphan-retry')
    const params = JSON.parse(retry.parameters)
    expect(params.document_id).toBe('doc-1') // original work is preserved
    expect(params.retried_from_job_id).toBe(jobId)
    expect(params.orphan_retry_generation).toBe(1)
  })

  it('the generation cap stops an orphan-on-every-attempt chain', async () => {
    // Simulate the retry copy of a retry copy (generation already at the cap of 2).
    insertRunningJob(db, { parameters: { document_id: 'doc-1', orphan_retry_generation: 2 } })

    const cleaned = await cleanupStaleCrawlersByHeartbeat(db, 5 * 60 * 1000)
    expect(cleaned).toBe(1)

    const queued = db.prepare("SELECT COUNT(*) AS c FROM crawler_jobs WHERE status = 'queued'").get()
    expect(queued.c).toBe(0) // no fresh copy — chain is bounded
  })

  it('never retries a retired (superseded) crawler type', async () => {
    insertRunningJob(db, { type: 'comprehensive' })
    const cleaned = await cleanupStaleCrawlersByHeartbeat(db, 5 * 60 * 1000)
    expect(cleaned).toBe(1)
    const queued = db.prepare("SELECT COUNT(*) AS c FROM crawler_jobs WHERE status = 'queued'").get()
    expect(queued.c).toBe(0)
  })

  it('a job with meaningful progress is partial-completed, not failed/retried', async () => {
    const id = crypto.randomUUID()
    db.prepare(
      `INSERT INTO crawler_jobs (id, type, status, profile_id, worker_id, started_at, last_heartbeat_at, result_count, result_meta)
       VALUES (?, 'run_all_states', 'running', 'profile-1', 'dead-worker', ?, ?, 500, ?)`,
    ).run(id, STALE, STALE, JSON.stringify({ sources: 500 }))

    const cleaned = await cleanupStaleCrawlersByHeartbeat(db, 5 * 60 * 1000)
    expect(cleaned).toBe(1)
    const row = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(id)
    expect(row.status).not.toBe('failed')
    const queued = db.prepare("SELECT COUNT(*) AS c FROM crawler_jobs WHERE status = 'queued'").get()
    expect(queued.c).toBe(0)
  })
})

describe('autoRetryOrphanedJob — caps', () => {
  it('refuses non-retryable error classes and exhausted retry budgets', async () => {
    const db = makeDb()
    const base = { id: 'j1', type: 'document_ingest', profile_id: 'p', parameters: '{}', created_at: new Date().toISOString() }
    expect((await autoRetryOrphanedJob(db, { ...base, error: 'violates foreign key constraint' })).retried).toBe(false)
    expect((await autoRetryOrphanedJob(db, { ...base, retry_count: 99 })).retried).toBe(false)
    const ok = await autoRetryOrphanedJob(db, { ...base, retry_count: 0 })
    expect(ok.retried).toBe(true)
  })
})
