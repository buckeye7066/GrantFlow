#!/usr/bin/env node
/**
 * Test Nationwide Crawler (Small Sample)
 * Tests the crawler with just 10 ZIP codes to ensure it works
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { processComprehensiveCrawlerJob } from '../backend/services/comprehensiveCrawler.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

function main() {
  const dbPath = path.resolve(projectRoot, 'backend', 'data', 'grantflow.db')
  const dataDir = path.resolve(projectRoot, 'backend', 'data', 'crawlers')
  const zipFile = path.join(dataDir, 'zip_coordinates.json')

  const zipMap = JSON.parse(fs.readFileSync(zipFile, 'utf8'))
  const zipCodes = Object.keys(zipMap).slice(0, 10) // Test with first 10 ZIPs

  console.log(`[test-crawler] Testing with ${zipCodes.length} ZIP codes: ${zipCodes.join(', ')}\n`)

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  const startedAt = Date.now()
  let totalInserted = 0
  let totalEvaluated = 0

  zipCodes.forEach((zip, index) => {
    const job = {
      id: `test-comprehensive-${zip}-${Date.now()}`,
      type: 'comprehensive',
      parameters: {
        zip_list: [zip],
        limit_per_zip: 10, // Limit for testing
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

      console.log(
        `[${index + 1}/${zipCodes.length}] ZIP ${zip.padEnd(5)} → inserted ${inserted}, evaluated ${evaluated}`
      )
    } catch (error) {
      console.error(`❌ ZIP ${zip} FAILED: ${error.message}`)
      throw error
    }
  })

  db.close()

  const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  
  console.log('\n' + '='.repeat(60))
  console.log('TEST CRAWL COMPLETE')
  console.log('='.repeat(60))
  console.log(`Total ZIP codes: ${zipCodes.length}`)
  console.log(`Total inserted: ${totalInserted}`)
  console.log(`Total evaluated: ${totalEvaluated}`)
  console.log(`Average per ZIP: ${Math.round(totalInserted / zipCodes.length)}`)
  console.log(`Duration: ${durationSeconds}s`)
  console.log('='.repeat(60))
}

try {
  main()
} catch (error) {
  console.error('\n[test-crawler] ERROR:', error.message)
  process.exit(1)
}
