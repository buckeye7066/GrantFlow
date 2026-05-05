#!/usr/bin/env node
/**
 * Test Comprehensive Crawler with Small Dataset
 * Tests the crawler with 10 ZIP codes to verify it works correctly
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { runComprehensiveCrawler as processComprehensiveCrawlerJob } from '../backend/services/comprehensiveCrawlerOptimized.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

const dbPath = path.resolve(projectRoot, 'backend', 'data', 'grantflow.db')
const dataDir = path.resolve(projectRoot, 'backend', 'data', 'crawlers')

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')

// Test with just 10 ZIP codes from different states
const testZips = ['10001', '10002', '10003', '90001', '90002', '60601', '60602', '77001', '33101', '85001']

console.log(`Testing comprehensive crawler with ${testZips.length} ZIP codes...`)
console.log('This will create ~30 test opportunities (3 templates × 10 ZIPs)\n')

let totalInserted = 0
let totalEvaluated = 0

for (const zip of testZips) {
  const job = {
    id: `test-comprehensive-${zip}`,
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

    console.log(`✓ ZIP ${zip} → inserted ${inserted}, evaluated ${evaluated}`)
  } catch (error) {
    console.error(`❌ ZIP ${zip} FAILED:`, error.message)
    console.error(error.stack)
  }
}

// Check results
const count = db.prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = 1').get()
const bySource = db.prepare('SELECT source, COUNT(*) as count FROM funding_opportunities WHERE is_active = 1 GROUP BY source').all()

console.log('\n' + '='.repeat(60))
console.log('Test Results:')
console.log('='.repeat(60))
console.log(`Total opportunities in database: ${count.count}`)
console.log(`Total inserted this run: ${totalInserted}`)
console.log(`Total evaluated this run: ${totalEvaluated}`)
console.log('\nOpportunities by source:')
bySource.forEach(row => {
  console.log(`  ${row.source}: ${row.count}`)
})
console.log('='.repeat(60))

db.close()

if (totalInserted > 0) {
  console.log('\n✅ Test successful! Crawler is working correctly.')
} else {
  console.log('\n⚠️  Warning: No opportunities were inserted.')
}
