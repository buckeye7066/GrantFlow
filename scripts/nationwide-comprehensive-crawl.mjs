#!/usr/bin/env node
/**
 * Nationwide Comprehensive Crawler
 * 
 * This script:
 * 1. Crawls ALL USA ZIP codes (43,859 zips)
 * 2. Ensures at least 3 funding sources per ZIP code
 * 3. Adds opportunities visible to all profiles
 * 4. Comprehensive with no upper limit on opportunities
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { runComprehensiveCrawler as processComprehensiveCrawlerJob } from '../backend/services/comprehensiveCrawlerOptimized.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

function ensureFile(filePath, description) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${description} at ${filePath}`)
  }
}

function main() {
  const dbPath = path.resolve(projectRoot, 'backend', 'data', 'grantflow.db')
  const dataDir = path.resolve(projectRoot, 'backend', 'data', 'crawlers')
  const zipFile = path.join(dataDir, 'zip_coordinates.json')

  ensureFile(dbPath, 'SQLite database (run `npm run seed:db` first)')
  ensureFile(zipFile, 'zip coordinate file')

  const zipMap = JSON.parse(fs.readFileSync(zipFile, 'utf8'))
  const zipCodes = Object.keys(zipMap)
  
  if (zipCodes.length === 0) {
    console.error('[nationwide-crawler] ERROR: No ZIP codes found in zip_coordinates.json')
    process.exit(1)
  }

  console.log(`[nationwide-crawler] Starting comprehensive nationwide crawl`)
  console.log(`[nationwide-crawler] Total ZIP codes to process: ${zipCodes.length.toLocaleString()}`)
  console.log(`[nationwide-crawler] Minimum opportunities per ZIP: 3`)
  console.log(`[nationwide-crawler] No upper limit - comprehensive coverage\n`)

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  const startedAt = Date.now()
  let totalInserted = 0
  let totalEvaluated = 0
  let failures = 0
  let zipsWithLessThan3 = 0

  console.log(`Starting crawl at ${new Date().toISOString()}\n`)

  zipCodes.forEach((zip, index) => {
    const job = {
      id: `nationwide-comprehensive-${zip}-${Date.now()}`,
      type: 'comprehensive',
      parameters: {
        zip_list: [zip],
        // No limit per zip - comprehensive crawl
        limit_per_zip: 999999, // Effectively unlimited
        fallback_zip_limit: 1,
      },
    }

    try {
      const result = processComprehensiveCrawlerJob({
        db,
        job,
        dataDir,
        profileContext: null, // null means opportunities are visible to ALL profiles
      })

      const inserted = Number(result?.inserted ?? 0)
      const evaluated = Number(result?.evaluated ?? 0)
      
      totalInserted += inserted
      totalEvaluated += evaluated

      if (inserted < 3) {
        zipsWithLessThan3++
        console.log(
          `⚠️  [${index + 1}/${zipCodes.length}] ZIP ${zip.padEnd(5)} → inserted ${inserted}, evaluated ${evaluated} (BELOW MINIMUM)`
        )
      } else if ((index + 1) % 100 === 0 || inserted >= 10) {
        // Log progress every 100 zips or when we find many opportunities
        console.log(
          `✓  [${index + 1}/${zipCodes.length}] ZIP ${zip.padEnd(5)} → inserted ${inserted}, evaluated ${evaluated}`
        )
      }
    } catch (error) {
      failures++
      const message = error instanceof Error ? error.message : String(error)
      console.error(`❌ [${index + 1}/${zipCodes.length}] ZIP ${zip} FAILED: ${message}`)
      
      // Stop immediately on error as per requirement
      console.error('\n[nationwide-crawler] ERROR DETECTED - Stopping immediately')
      db.close()
      process.exit(1)
    }
  })

  db.close()

  const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  const durationMinutes = Math.floor(durationSeconds / 60)
  const durationHours = Math.floor(durationMinutes / 60)
  
  console.log('\n' + '='.repeat(80))
  console.log('NATIONWIDE COMPREHENSIVE CRAWL COMPLETE')
  console.log('='.repeat(80))
  console.log(`Total ZIP codes processed: ${zipCodes.length.toLocaleString()}`)
  console.log(`Total opportunities inserted: ${totalInserted.toLocaleString()}`)
  console.log(`Total opportunities evaluated: ${totalEvaluated.toLocaleString()}`)
  console.log(`Failed ZIP codes: ${failures}`)
  console.log(`ZIP codes with <3 opportunities: ${zipsWithLessThan3}`)
  console.log(`Duration: ${durationHours}h ${durationMinutes % 60}m ${durationSeconds % 60}s`)
  console.log(`Completed at: ${new Date().toISOString()}`)
  console.log('='.repeat(80))

  if (failures > 0) {
    console.error('\n⚠️  Some ZIP codes failed to process')
    process.exit(1)
  }
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error('\n[nationwide-crawler] FATAL ERROR:', message)
  console.error(error.stack)
  process.exit(1)
}
