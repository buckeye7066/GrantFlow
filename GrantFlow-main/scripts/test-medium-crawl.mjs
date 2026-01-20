#!/usr/bin/env node
/**
 * Medium-Scale Crawler Test
 * Creates ~3,000 opportunities (1,000 ZIPs × 3 templates) to test performance
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { processComprehensiveCrawlerJob } from '../backend/services/comprehensiveCrawler.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

const dbPath = path.resolve(projectRoot, 'backend', 'data', 'grantflow.db')
const dataDir = path.resolve(projectRoot, 'backend', 'data', 'crawlers')
const zipFile = path.join(dataDir, 'zip_coordinates.json')

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')

// Load all ZIP codes and select 1000 of them
const zipMap = JSON.parse(fs.readFileSync(zipFile, 'utf8'))
const allZips = Object.keys(zipMap)
const targetCount = 1000
const step = Math.floor(allZips.length / targetCount)
const testZips = allZips.filter((_, index) => index % step === 0).slice(0, targetCount)

console.log(`Testing comprehensive crawler with ${testZips.length} ZIP codes...`)
console.log(`This will create ~${testZips.length * 3} test opportunities (3 templates per ZIP)`)
console.log(`Selected ZIPs from all ${allZips.length} available ZIPs\n`)

const startTime = Date.now()
let totalInserted = 0
let totalEvaluated = 0

// Process in batches for better performance
const batchSize = 100
for (let i = 0; i < testZips.length; i += batchSize) {
  const batch = testZips.slice(i, i + batchSize)
  
  for (const zip of batch) {
    const job = {
      id: `test-medium-${zip}`,
      type: 'comprehensive',
      parameters: {
        zip_list: [zip],
        limit_per_zip: 999999,
        fallback_zip_limit: 1,
      },
    }

    try {
      const result = processComprehensiveCrawlerJob({
        db,
        job,
        dataDir,
        profileContext: null,
      })

      const inserted = Number(result?.inserted ?? 0)
      const evaluated = Number(result?.evaluated ?? 0)
      
      totalInserted += inserted
      totalEvaluated += evaluated
    } catch (error) {
      console.error(`❌ ZIP ${zip} FAILED:`, error.message)
    }
  }
  
  console.log(`Processed batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(testZips.length / batchSize)} (${i + batch.length}/${testZips.length} ZIPs)`)
}

const duration = ((Date.now() - startTime) / 1000).toFixed(2)

// Check results
const count = db.prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = 1').get()
const bySource = db.prepare('SELECT source, COUNT(*) as count FROM funding_opportunities WHERE is_active = 1 GROUP BY source').all()
const byState = db.prepare('SELECT state, COUNT(*) as count FROM funding_opportunities WHERE is_active = 1 GROUP BY state ORDER BY count DESC LIMIT 10').all()

console.log('\n' + '='.repeat(60))
console.log('Medium-Scale Test Results:')
console.log('='.repeat(60))
console.log(`Total opportunities in database: ${count.count}`)
console.log(`Total inserted this run: ${totalInserted}`)
console.log(`Total evaluated this run: ${totalEvaluated}`)
console.log(`Duration: ${duration} seconds`)
console.log(`Rate: ${(totalInserted / parseFloat(duration)).toFixed(1)} opportunities/second`)
console.log('\nOpportunities by source:')
bySource.forEach(row => {
  console.log(`  ${row.source}: ${row.count}`)
})
console.log('\nTop 10 states by opportunity count:')
byState.forEach(row => {
  console.log(`  ${row.state}: ${row.count}`)
})
console.log('='.repeat(60))

db.close()

if (totalInserted >= testZips.length * 2) {
  console.log('\n✅ Test successful! Crawler is working well at scale.')
  console.log(`\nTo create 100K+ opportunities, run: npm run crawl:nationwide`)
  console.log(`This will process all ${allZips.length.toLocaleString()} US ZIP codes.`)
} else {
  console.log('\n⚠️  Warning: Expected more opportunities to be inserted.')
}
