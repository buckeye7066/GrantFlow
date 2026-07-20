import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { findPendingRetryOf } from '../services/crawlerJobCreation.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE crawler_jobs (
      id TEXT PRIMARY KEY,
      type TEXT,
      profile_id TEXT,
      status TEXT,
      parameters TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `)
  db.dialect = 'sqlite'
  return db
}

describe('findPendingRetryOf', () => {
  it('returns null when no retry of the given job exists', async () => {
    const db = makeDb()
    const result = await findPendingRetryOf(db, 'job-1')
    expect(result).toBeNull()
  })

  it('finds a queued retry of the given job', async () => {
    const db = makeDb()
    db.prepare('INSERT INTO crawler_jobs (id, type, status, parameters) VALUES (?, ?, ?, ?)').run(
      'retry-1', 'document_ingest', 'queued', JSON.stringify({ retried_from_job_id: 'job-1' }),
    )
    const result = await findPendingRetryOf(db, 'job-1')
    expect(result?.id).toBe('retry-1')
  })

  it('finds a running retry of the given job', async () => {
    const db = makeDb()
    db.prepare('INSERT INTO crawler_jobs (id, type, status, parameters) VALUES (?, ?, ?, ?)').run(
      'retry-1', 'document_ingest', 'running', JSON.stringify({ retried_from_job_id: 'job-1' }),
    )
    const result = await findPendingRetryOf(db, 'job-1')
    expect(result?.id).toBe('retry-1')
  })

  it('does NOT match a retry that has already terminated (failed/completed/cancelled)', async () => {
    const db = makeDb()
    db.prepare('INSERT INTO crawler_jobs (id, type, status, parameters) VALUES (?, ?, ?, ?)').run(
      'retry-1', 'document_ingest', 'failed', JSON.stringify({ retried_from_job_id: 'job-1' }),
    )
    const result = await findPendingRetryOf(db, 'job-1')
    expect(result).toBeNull()
  })

  it('does NOT match a retry of a DIFFERENT job — the substring-match must not cross ids', async () => {
    const db = makeDb()
    // 'job-1' is a prefix of 'job-10' — a naive %job-1% LIKE would false-positive here
    // if the marker weren't quote-delimited on both sides.
    db.prepare('INSERT INTO crawler_jobs (id, type, status, parameters) VALUES (?, ?, ?, ?)').run(
      'retry-1', 'document_ingest', 'queued', JSON.stringify({ retried_from_job_id: 'job-10' }),
    )
    const result = await findPendingRetryOf(db, 'job-1')
    expect(result).toBeNull()
  })

  it('when multiple pending retries somehow exist, returns the most recent', async () => {
    const db = makeDb()
    db.prepare('INSERT INTO crawler_jobs (id, type, status, parameters, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'retry-old', 'document_ingest', 'queued', JSON.stringify({ retried_from_job_id: 'job-1' }), '2026-01-01T00:00:00Z',
    )
    db.prepare('INSERT INTO crawler_jobs (id, type, status, parameters, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'retry-new', 'document_ingest', 'queued', JSON.stringify({ retried_from_job_id: 'job-1' }), '2026-06-01T00:00:00Z',
    )
    const result = await findPendingRetryOf(db, 'job-1')
    expect(result?.id).toBe('retry-new')
  })

  it('returns null when originalJobId is falsy', async () => {
    const db = makeDb()
    expect(await findPendingRetryOf(db, null)).toBeNull()
    expect(await findPendingRetryOf(db, '')).toBeNull()
  })
})
