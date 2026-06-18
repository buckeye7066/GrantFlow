/**
 * Item 6 — crawler run-summary logging + grant_pipeline_events FK guard.
 *
 * crawl_logs: crawlers historically never wrote run summaries, so the
 * Diagnostics crawl-log count sat at 0. completeJob/failJob now emit one
 * canonical crawl_logs row per finished run.
 *
 * FK guard: recordAutomationEvent must not insert (or crash) when the
 * referenced grant was deleted mid-run — it skips the audit event instead of
 * violating grant_pipeline_events_grant_id_fkey.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import {
  writeCrawlLog,
  countCrawlLogs,
  ensureCrawlLogsSchema,
  _resetCrawlLogSchemaCache,
} from '../../backend/services/crawlLogStore.js'
import { completeJob, failJob } from '../../backend/services/crawlerJobState.js'
import { __testing__ as pipelineTesting } from '../../backend/services/pipelineAutomation.js'

function makeDb() {
  _resetCrawlLogSchemaCache()
  return wrapSqlite(new Database(':memory:'))
}

function createCrawlerJobsTable(db) {
  db.raw.exec(`
    CREATE TABLE crawler_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      worker_id TEXT,
      profile_id TEXT,
      result_count INTEGER,
      result_meta TEXT,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME
    );
  `)
}

function insertRunningJob(db, { id, type = 'comprehensive' }) {
  db.raw
    .prepare(
      `INSERT INTO crawler_jobs (id, type, status, worker_id, started_at, created_at)
       VALUES (?, ?, 'running', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .run(id, type)
}

test('writeCrawlLog inserts a row and coerces an invalid status', async () => {
  const db = makeDb()
  await ensureCrawlLogsSchema(db)
  assert.equal(await countCrawlLogs(db), 0)

  await writeCrawlLog(db, { source: 'comprehensive', status: 'success', recordsFound: 5 })
  await writeCrawlLog(db, { source: 'local', status: 'not-a-real-status' }) // coerced → 'partial'

  assert.equal(await countCrawlLogs(db), 2)
  const rows = await db.prepare('SELECT source, status FROM crawl_logs ORDER BY source').all()
  assert.deepEqual(rows.map((r) => r.status).sort(), ['partial', 'success'])
})

test('completeJob writes a success crawl_logs row (fixes the 0-count)', async () => {
  const db = makeDb()
  createCrawlerJobsTable(db)
  insertRunningJob(db, { id: 'job-1', type: 'comprehensive' })

  assert.equal(await countCrawlLogs(db), 0)
  const res = await completeJob(db, 'job-1', { resultCount: 7, resultMeta: { found: 7 } })
  assert.equal(res.ok, true)

  assert.equal(await countCrawlLogs(db), 1)
  const row = await db.prepare('SELECT * FROM crawl_logs LIMIT 1').get()
  assert.equal(row.source, 'comprehensive')
  assert.equal(row.status, 'success')
  assert.equal(Number(row.records_found), 7)
})

test('failJob writes an error crawl_logs row', async () => {
  const db = makeDb()
  createCrawlerJobsTable(db)
  insertRunningJob(db, { id: 'job-2', type: 'scholarship' })

  await failJob(db, 'job-2', new Error('network down'), { force: true })

  const row = await db.prepare("SELECT * FROM crawl_logs WHERE source = 'scholarship' LIMIT 1").get()
  assert.ok(row, 'a crawl_logs row exists for the failed run')
  assert.equal(row.status, 'error')
  assert.match(String(row.error_message || ''), /network down/)
})

// ── FK guard ────────────────────────────────────────────────────────────────
function createGrantTables(db) {
  db.raw.exec(`
    CREATE TABLE grants (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE grant_pipeline_events (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
      job_id TEXT,
      previous_status TEXT,
      suggested_status TEXT,
      applied_status TEXT,
      confidence REAL,
      handoff_required BOOLEAN DEFAULT 0,
      handoff_reason TEXT,
      recommended_actions TEXT,
      ai_summary TEXT
    );
  `)
}

test('recordAutomationEvent skips (no insert, no throw) when the grant is gone', async () => {
  const db = makeDb()
  createGrantTables(db)
  // No grant row inserted → simulates a grant deleted mid-run.
  await pipelineTesting.recordAutomationEvent(db, {
    grantId: 'ghost-grant',
    jobId: 'job-x',
    suggestedStatus: 'interested',
    aiSummary: 'orphaned',
  })
  const n = await db.prepare('SELECT COUNT(*) AS n FROM grant_pipeline_events').get()
  assert.equal(Number(n.n), 0, 'no event inserted for a missing grant (FK violation avoided)')
})

test('recordAutomationEvent inserts when the grant exists', async () => {
  const db = makeDb()
  createGrantTables(db)
  db.raw.prepare("INSERT INTO grants (id, title) VALUES ('g1', 'Real Grant')").run()

  await pipelineTesting.recordAutomationEvent(db, {
    grantId: 'g1',
    jobId: 'job-y',
    suggestedStatus: 'interested',
    aiSummary: 'ok',
  })
  const n = await db.prepare('SELECT COUNT(*) AS n FROM grant_pipeline_events').get()
  assert.equal(Number(n.n), 1, 'event inserted when the grant exists')
})
