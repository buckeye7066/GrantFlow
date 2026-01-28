import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

import { runNationalZipCrawl } from '../../backend/services/crawlers/nationalZipCrawler.js'

test('geo crawl (offline_only): ZIP 44089 yields >=3 persisted funding sources', async () => {
  const db = new Database(':memory:')
  try {
    // Bootstrap schema (matches local tooling + avoids network).
    const schemaSql = fs.readFileSync(path.resolve(process.cwd(), 'backend/db/schema.sql'), 'utf8')
    db.exec(schemaSql)

    const result = await runNationalZipCrawl(db, {
      zip_list: ['44089'],
      offline_only: true,
      discover_local_resources: false,
      batch_size: 1,
      rate_limit_ms: 0,
      min_sources_per_zip: 3,
      resume: false,
    })
    assert.ok(result, 'run returned null')

    // Verify we have at least 3 for OH and each has a valid URL.
    const rows = db
      .prepare(
        `
          SELECT source_url, title, sponsor, source, source_id, state
          FROM funding_opportunities
          WHERE state = 'OH'
          ORDER BY created_at DESC
          LIMIT 50
        `,
      )
      .all()

    const withUrls = (rows || []).filter((r) => typeof r?.source_url === 'string' && /^https?:\/\//i.test(r.source_url))
    assert.ok(withUrls.length >= 3, `expected >=3 urls for OH, got ${withUrls.length}`)
    assert.ok(withUrls.every((r) => r.source && r.source_id), 'expected source + source_id for all')
  } finally {
    db.close()
  }
})

