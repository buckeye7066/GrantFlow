import test from 'node:test'
import assert from 'node:assert/strict'

import { runNationalZipCrawl } from '../../backend/services/crawlers/nationalZipCrawler.js'

test('geo crawl: nationalZipCrawler does not close shared DB objects', async () => {
  let closed = false
  const db = {
    dialect: 'sqlite',
    close: () => {
      closed = true
    },
    prepare: () => {
      throw new Error('prepare() should not be called for empty zip list test')
    },
  }

  // Invalid zip_list -> normalized to empty -> should return early without touching DB
  const result = await runNationalZipCrawl(db, { zip_list: ['BADZIP'], max_zips: 1 })

  assert.equal(closed, false)
  assert.equal(result?.processed, 0)
  assert.equal(result?.sources, 0)
})

