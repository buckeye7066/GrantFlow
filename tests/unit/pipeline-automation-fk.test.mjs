/**
 * pipeline_automation — grant_pipeline_events FK safety.
 *
 * Regression for the production error:
 *   insert or update on table "grant_pipeline_events" violates foreign key
 *   constraint "grant_pipeline_events_grant_id_fkey"
 *
 * A job loads a grant, runs AI for several seconds, then records an audit
 * event — but the grant can be deleted in that window. recordAutomationEvent
 * pre-checks the grant exists AND swallows a late FK violation (the TOCTOU
 * race the pre-check can't fully close) so the crawler job is never aborted.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'
import { __testing__ } from '../../backend/services/pipelineAutomation.js'

const { recordAutomationEvent } = __testing__

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(`
    CREATE TABLE grants (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE grant_pipeline_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grant_id TEXT NOT NULL REFERENCES grants(id),
      job_id TEXT,
      previous_status TEXT,
      suggested_status TEXT,
      applied_status TEXT,
      confidence REAL,
      handoff_required INTEGER,
      handoff_reason TEXT,
      recommended_actions TEXT,
      ai_summary TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return { sqlite, db: wrapSqlite(sqlite) }
}

const countEvents = (sqlite) =>
  sqlite.prepare('SELECT COUNT(*) AS n FROM grant_pipeline_events').get().n

test('records an event for an existing grant', async () => {
  const { sqlite, db } = makeDb()
  sqlite.prepare('INSERT INTO grants (id, title) VALUES (?, ?)').run('g1', 'Test Grant')

  await recordAutomationEvent(db, { grantId: 'g1', suggestedStatus: 'interested', handoffRequired: false })

  assert.equal(countEvents(sqlite), 1, 'event should be persisted for a live grant')
})

test('pre-check: a grant that no longer exists is skipped (no throw, no row)', async () => {
  const { sqlite, db } = makeDb()
  await assert.doesNotReject(
    recordAutomationEvent(db, { grantId: 'missing', suggestedStatus: 'interested' }),
  )
  assert.equal(countEvents(sqlite), 0)
})

test('race: a grant deleted between the check and the insert is swallowed (FK), job not aborted', async () => {
  const { sqlite, db } = makeDb()
  // Proxy the db so the existence check reports the grant as present, but the
  // real INSERT still hits the FK constraint (the grant is not in `grants`).
  // This deterministically exercises the late-FK catch branch.
  const proxy = {
    ...db,
    prepare(sql) {
      if (/SELECT id FROM grants WHERE id/i.test(sql)) {
        return { get: () => ({ id: 'ghost' }), all: () => [{ id: 'ghost' }], run: () => ({}) }
      }
      return db.prepare(sql)
    },
  }

  await assert.doesNotReject(
    recordAutomationEvent(proxy, { grantId: 'ghost', suggestedStatus: 'interested', handoffRequired: true }),
    'a late FK violation must be swallowed, not thrown',
  )
  assert.equal(countEvents(sqlite), 0, 'no orphan event row should be written')
})
