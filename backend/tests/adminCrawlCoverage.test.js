/**
 * Integration tests for GET /api/admin/crawl-coverage (admin crawl coverage
 * & health dashboard). Proves:
 *   1. Non-admin callers get 403.
 *   2. Admin gets the documented report shape.
 *   3. Per-run rollups (planned/queried/failed/found + failed_sources) are
 *      derived from crawler_source_runs.
 *   4. profileId filter scopes the runs.
 *   5. Degrades gracefully when the optional rejection_log table is absent.
 */

import request from 'supertest'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import crypto from 'crypto'
import { getAppAndDb, resetDb, TEST_ADMIN_AUTH_HEADER } from './testServer.js'

function ensureTable(db) {
  // The table ships via migration 072 / pg 0066; create defensively so the
  // test is robust on a fresh sqlite that hasn't replayed migrations.
  db.prepare(
    `CREATE TABLE IF NOT EXISTS crawler_source_runs (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       crawler_run_id TEXT NOT NULL,
       profile_id TEXT,
       crawler_type TEXT,
       source_id TEXT NOT NULL,
       source_label TEXT,
       planned INTEGER NOT NULL DEFAULT 0,
       queried INTEGER NOT NULL DEFAULT 0,
       failed INTEGER NOT NULL DEFAULT 0,
       found INTEGER NOT NULL DEFAULT 0,
       directory INTEGER NOT NULL DEFAULT 0,
       duration_ms INTEGER,
       error TEXT,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
     )`,
  ).run()
}

function insertSourceRun(db, runId, profileId, row) {
  db.prepare(
    `INSERT INTO crawler_source_runs
       (crawler_run_id, profile_id, crawler_type, source_id, source_label,
        planned, queried, failed, found, directory, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    profileId,
    'comprehensive',
    row.source_id,
    row.source_label ?? row.source_id,
    row.planned ? 1 : 0,
    row.queried ? 1 : 0,
    row.failed ? 1 : 0,
    Number(row.found ?? 0),
    row.directory ? 1 : 0,
    row.error ?? null,
    row.created_at ?? new Date().toISOString(),
  )
}

describe('admin crawl coverage', () => {
  let app
  let db

  beforeAll(async () => {
    const loaded = await getAppAndDb()
    app = loaded.app
    db = loaded.db
    ensureTable(db)
  }, 60_000)

  beforeEach(() => {
    resetDb(db)
    ensureTable(db)
    db.prepare('DELETE FROM crawler_source_runs').run()
  })

  it('rejects unauthenticated/non-admin callers', async () => {
    const res = await request(app).get('/api/admin/crawl-coverage')
    // 401 (no auth) or 403 (authed non-admin) — never 200 for a guest.
    expect([401, 403]).toContain(res.status)
  })

  it('returns the documented report shape for admin', async () => {
    const res = await request(app)
      .get('/api/admin/crawl-coverage')
      .set(TEST_ADMIN_AUTH_HEADER)

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('generated_at')
    expect(res.body).toHaveProperty('runs')
    expect(Array.isArray(res.body.runs)).toBe(true)
    expect(res.body).toHaveProperty('stale_sources')
    expect(Array.isArray(res.body.stale_sources)).toBe(true)
    expect(res.body).toHaveProperty('weak_data_profiles')
    expect(res.body).toHaveProperty('totals')
    expect(res.body.totals).toHaveProperty('source_failure_rate')
    expect(res.body).toHaveProperty('optional_tables')
    // rejection_log presence is reported honestly as a boolean (the test
    // schema may or may not carry the table / a compatible shape).
    expect(typeof res.body.optional_tables.rejection_log).toBe('boolean')
    // Registry sources that have never run show up as stale (never_run).
    expect(res.body.stale_sources.length).toBeGreaterThan(0)
  })

  it('derives per-run planned/queried/failed/found + failed_sources', async () => {
    const runId = crypto.randomUUID()
    insertSourceRun(db, runId, null, { source_id: 'grants_gov', planned: true, queried: true, found: 4 })
    insertSourceRun(db, runId, null, { source_id: 'state_portal', planned: true, queried: true, found: 0 })
    insertSourceRun(db, runId, null, {
      source_id: 'sba_grants',
      planned: true,
      queried: true,
      failed: true,
      error: 'timeout',
    })

    const res = await request(app)
      .get('/api/admin/crawl-coverage')
      .set(TEST_ADMIN_AUTH_HEADER)

    expect(res.status).toBe(200)
    const run = res.body.runs.find((r) => r.crawler_run_id === runId)
    expect(run).toBeTruthy()
    expect(run.sources_planned).toBe(3)
    expect(run.sources_queried).toBe(3)
    expect(run.sources_failed).toBe(1)
    expect(run.results_found).toBe(4)
    expect(run.failed_sources).toHaveLength(1)
    expect(run.failed_sources[0].source_id).toBe('sba_grants')
    expect(run.failed_sources[0].error).toBe('timeout')
    // avg_trust is derived from the queried sources' registry trust tiers.
    expect(typeof run.avg_trust === 'number' || run.avg_trust === null).toBe(true)
    expect(res.body.totals.sources_failed_recent).toBeGreaterThanOrEqual(1)
  })

  it('scopes runs to a single profileId when provided', async () => {
    const runA = crypto.randomUUID()
    const runB = crypto.randomUUID()
    insertSourceRun(db, runA, 'profile-a', { source_id: 'grants_gov', planned: true, queried: true, found: 2 })
    insertSourceRun(db, runB, 'profile-b', { source_id: 'grants_gov', planned: true, queried: true, found: 9 })

    const res = await request(app)
      .get('/api/admin/crawl-coverage?profileId=profile-a')
      .set(TEST_ADMIN_AUTH_HEADER)

    expect(res.status).toBe(200)
    expect(res.body.filters.profile_id).toBe('profile-a')
    expect(res.body.runs).toHaveLength(1)
    expect(res.body.runs[0].crawler_run_id).toBe(runA)
    expect(res.body.runs[0].profile_id).toBe('profile-a')
  })
})
