#!/usr/bin/env node
/**
 * Crawl ZIPs matching organization states for better matching
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
  console.log(`[targeted-crawler] Organization states: ${orgStates.join(', ')}\n`)

  // Load ZIP coordinates
  const zipMap = JSON.parse(fs.readFileSync(zipFile, 'utf8'))

  // Get 10 ZIPs per state (varied coverage)
  const targetZips = []
  orgStates.forEach(state => {
    const stateZips = Object.entries(zipMap)
      .filter(([zip, data]) => data.state === state)
      .slice(0, 10)
      .map(([zip]) => zip)
    targetZips.push(...stateZips)
  })

  console.log(`[targeted-crawler] Processing ${targetZips.length} ZIPs across ${orgStates.length} states\n`)

  const startedAt = Date.now()
  let totalInserted = 0
  let totalEvaluated = 0

  targetZips.forEach((zip, index) => {
    const job = {
      id: `targeted-${zip}-${Date.now()}`,
      type: 'comprehensive',
      parameters: {
        zip_list: [zip],
        limit_per_zip: 5,
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
        `[${index + 1}/${targetZips.length}] ZIP ${zip.padEnd(5)} → inserted ${inserted}, evaluated ${evaluated}`
      )
    } catch (error) {
      console.error(`❌ ZIP ${zip} FAILED: ${error.message}`)
      throw error
    }
  })

  db.close()

  const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  
  console.log('\n' + '='.repeat(60))
  console.log('TARGETED CRAWL COMPLETE')
  console.log('='.repeat(60))
  console.log(`Total ZIP codes: ${targetZips.length}`)
  console.log(`Total inserted: ${totalInserted}`)
  console.log(`Total evaluated: ${totalEvaluated}`)
  console.log(`Average per ZIP: ${Math.round(totalInserted / targetZips.length)}`)
  console.log(`Duration: ${durationSeconds}s`)
  console.log('='.repeat(60))
}

try {
  main()
} catch (error) {
  console.error('\n[targeted-crawler] ERROR:', error.message)
  process.exit(1)
}
