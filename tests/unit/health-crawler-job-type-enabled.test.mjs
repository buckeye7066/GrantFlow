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

  const jobCreation = read('backend/services/crawlerJobCreation.js')
  assert.ok(jobCreation.includes("'health_resources'"), 'createCrawlerJob VALID_TYPES missing health_resources')

  const crawlersRoute = read('backend/routes/crawlers.js')
  assert.ok(crawlersRoute.includes("'health_resources'"), 'crawlers route missing health_resources gating')
})

