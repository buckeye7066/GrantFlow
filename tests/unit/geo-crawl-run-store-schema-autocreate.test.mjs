import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

import { createGeoCrawlRun, appendGeoCrawlEvent, listGeoCrawlEvents } from '../../backend/services/geoCrawlRunStore.js'

test('geoCrawlRunStore: auto-creates geo_crawl_runs/events when missing', async () => {
  const db = new Database(':memory:')
  try {
    const schemaSql = fs.readFileSync(path.resolve(process.cwd(), 'backend/db/schema.sql'), 'utf8')
    db.exec(schemaSql)

    // Simulate a deployment that is missing geo crawl tables (migration lag).
    db.exec('DROP TABLE IF EXISTS geo_crawl_events;')
    db.exec('DROP TABLE IF EXISTS geo_crawl_runs;')

    const run = await createGeoCrawlRun(db, { state: 'OH' })
    assert.ok(run?.id, 'run id missing')

    await appendGeoCrawlEvent(db, run.id, {
      level: 'info',
      state: 'OH',
      zip: '44089',
      county: null,
      source: 'test',
      message: 'hello',
    })

    const events = await listGeoCrawlEvents(db, run.id, { limit: 10 })
    assert.ok(Array.isArray(events), 'events not array')
    assert.ok(events.length >= 1, 'expected at least 1 event')
  } finally {
    db.close()
  }
})

