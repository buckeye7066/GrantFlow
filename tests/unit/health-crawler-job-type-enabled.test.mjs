import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

function read(relPath) {
  const p = path.resolve(process.cwd(), relPath)
  return fs.readFileSync(p, 'utf8')
}

test('health_resources is a supported crawler job type (drift guard)', () => {
  const constants = read('backend/config/constants.js')
  assert.ok(constants.includes("'health_resources'"), 'CRAWLER_JOB_TYPES missing health_resources')

  // crawlerJobCreation no longer hardcodes its own list — it consumes the
  // canonical CRAWLER_JOB_TYPES from constants.js (single source of truth), so
  // it cannot drift from the list the constants drift-guard above protects.
  const jobCreation = read('backend/services/crawlerJobCreation.js')
  assert.ok(
    jobCreation.includes('CRAWLER_JOB_TYPES'),
    'createCrawlerJob must consume CRAWLER_JOB_TYPES from constants (single source of truth)'
  )

  const crawlersRoute = read('backend/routes/crawlers.js')
  assert.ok(crawlersRoute.includes("'health_resources'"), 'crawlers route missing health_resources gating')
})

