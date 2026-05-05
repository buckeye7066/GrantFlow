#!/usr/bin/env node
/**
 * Extended Crawler - Process 50 ZIPs per org state
 * This provides enough variety for 50 grants per profile
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { runComprehensiveCrawler as processComprehensiveCrawlerJob } from '../backend/services/comprehensiveCrawlerOptimized.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

function main() {
  const dbPath = path.resolve(projectRoot, 'backend', 'data', 'grantflow.db')
  const dataDir = path.resolve(projectRoot, 'backend', 'data', 'crawlers')
  const zipFile = path.join(dataDir, 'zip_coordinates.json')

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  // Get organization states
  const orgStates = db.prepare('SELECT DISTINCT state FROM organizations WHERE state IS NOT NULL').all().map(o => o.state)
  console.log(`[extended-crawler] Organization states: ${orgStates.join(', ')}\n`)

  // Load ZIP coordinates
  const zipMap = JSON.parse(fs.readFileSync(zipFile, 'utf8'))

  // Get 50 ZIPs per state for better variety
  const targetZips = []
  orgStates.forEach(state => {
    const stateZips = Object.entries(zipMap)
      .filter(([zip, data]) => data.state === state)
      .slice(0, 50) // 50 ZIPs per state
      .map(([zip]) => zip)
    targetZips.push(...stateZips)
    console.log(`  ${state}: ${stateZips.length} ZIPs`)
  })

  console.log(`\n[extended-crawler] Processing ${targetZips.length} ZIPs across ${orgStates.length} states`)
  console.log(`[extended-crawler] Target: 3-5 opportunities per ZIP\n`)

  const startedAt = Date.now()
  let totalInserted = 0
  let totalEvaluated = 0

  targetZips.forEach((zip, index) => {
    const job = {
      id: `extended-${zip}-${Date.now()}`,
      type: 'comprehensive',
      parameters: {
        zip_list: [zip],
        limit_per_zip: 5, // Allow up to 5 per ZIP
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

      // Progress update every 50 ZIPs
      if ((index + 1) % 50 === 0 || index === targetZips.length - 1) {
        console.log(
          `[${index + 1}/${targetZips.length}] Progress: ${totalInserted} opportunities inserted`
        )
      }
    } catch (error) {
      console.error(`❌ ZIP ${zip} FAILED: ${error.message}`)
      throw error // Stop on error as per requirement
    }
  })

  db.close()

  const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  const durationMinutes = Math.floor(durationSeconds / 60)
  
  console.log('\n' + '='.repeat(70))
  console.log('EXTENDED CRAWL COMPLETE')
  console.log('='.repeat(70))
  console.log(`Total ZIP codes: ${targetZips.length}`)
  console.log(`Total opportunities inserted: ${totalInserted}`)
  console.log(`Total opportunities evaluated: ${totalEvaluated}`)
  console.log(`Average per ZIP: ${Math.round(totalInserted / targetZips.length)}`)
  console.log(`Duration: ${durationMinutes}m ${durationSeconds % 60}s`)
  console.log('='.repeat(70))
  console.log('\nRun prepopulation script next: npm run prepopulate:grants')
}

try {
  main()
} catch (error) {
  console.error('\n[extended-crawler] ERROR:', error.message)
  console.error(error.stack)
  process.exit(1)
}
