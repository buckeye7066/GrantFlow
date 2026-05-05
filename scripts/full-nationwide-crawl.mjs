#!/usr/bin/env node
/**
 * Optimized Nationwide Comprehensive Crawler
 * 
 * This script runs a nationwide crawl to populate the opportunities page
 * Target: 100,000+ opportunities
 * Strategy: Use ZIP codes across all states with proper distribution
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

  ensureFile(dbPath, 'SQLite database')
  ensureFile(zipFile, 'zip coordinate file')

  const zipMap = JSON.parse(fs.readFileSync(zipFile, 'utf8'))
  
  // Group ZIP codes by state
  const zipsByState = {}
  Object.entries(zipMap).forEach(([zip, data]) => {
    const state = data.state
    if (!zipsByState[state]) {
      zipsByState[state] = []
    }
    zipsByState[state].push(zip)
  })

  console.log(`[optimized-nationwide] Starting optimized nationwide crawl`)
  console.log(`[optimized-nationwide] States found: ${Object.keys(zipsByState).length}`)
  console.log(`[optimized-nationwide] Target: 100,000+ opportunities`)
  console.log(`[optimized-nationwide] Strategy: Comprehensive coverage across all states\n`)

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  const startedAt = Date.now()
  let totalInserted = 0
  let totalEvaluated = 0
  let failures = 0
  let zipsProcessed = 0

  console.log(`Starting crawl at ${new Date().toISOString()}\n`)

  // Process ALL ZIP codes - comprehensive nationwide coverage
  const states = Object.keys(zipsByState)
  const totalZips = Object.keys(zipMap).length

  console.log(`Processing ALL ${totalZips.toLocaleString()} ZIP codes for complete nationwide coverage`)
  console.log(`This will take significant time but will ensure comprehensive results\n`)

  states.forEach((state, stateIndex) => {
    const stateZips = zipsByState[state] // ALL zips in state, no slicing
    console.log(`\n[${stateIndex + 1}/${states.length}] Processing ${state}: ${stateZips.length} ZIP codes`)

    // Process ZIPs in batches for better performance
    const batchSize = 50
    for (let i = 0; i < stateZips.length; i += batchSize) {
      const batch = stateZips.slice(i, Math.min(i + batchSize, stateZips.length))
      
      const job = {
        id: `nationwide-comprehensive-${state}-batch-${i / batchSize}`,
        type: 'comprehensive',
        parameters: {
          zip_list: batch,
          // Generate more opportunities per ZIP for comprehensive coverage
          limit_per_zip: 999999, // No limit per zip
          fallback_zip_limit: 1,
        },
      }

      try {
        const result = processComprehensiveCrawlerJob({
          db,
          job,
          dataDir,
          profileContext: null, // null = global opportunities visible to all
        })

        const inserted = Number(result?.inserted ?? 0)
        const evaluated = Number(result?.evaluated ?? 0)
        
        totalInserted += inserted
        totalEvaluated += evaluated
        zipsProcessed += batch.length

        console.log(
          `  Batch ${Math.floor(i / batchSize) + 1}: ${batch.length} ZIPs → ${inserted} inserted, ${evaluated} evaluated`
        )

        // Show progress every 1000 total zips
        if (zipsProcessed % 1000 === 0) {
          const durationSec = Math.round((Date.now() - startedAt) / 1000)
          const rate = zipsProcessed / durationSec
          const remaining = totalZips - zipsProcessed
          const eta = Math.round(remaining / rate)
          const etaMinutes = Math.floor(eta / 60)
          const etaHours = Math.floor(etaMinutes / 60)
          console.log(
            `\n📊 Progress: ${totalInserted.toLocaleString()} opportunities | ` +
            `${zipsProcessed.toLocaleString()}/${totalZips.toLocaleString()} ZIPs (${((zipsProcessed/totalZips)*100).toFixed(1)}%) | ` +
            `${rate.toFixed(1)} ZIP/sec | ` +
            `ETA: ${etaHours}h ${etaMinutes % 60}m\n`
          )
        }
      } catch (error) {
        failures++
        const message = error instanceof Error ? error.message : String(error)
        console.error(`  ❌ Batch failed: ${message}`)
        
        // Log error but continue (don't stop on single batch failure)
        console.error(`  Continuing with next batch...`)
      }
    }
  })

  db.close()

  const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  const durationMinutes = Math.floor(durationSeconds / 60)
  const durationHours = Math.floor(durationMinutes / 60)
  
  console.log('\n' + '='.repeat(80))
  console.log('OPTIMIZED NATIONWIDE CRAWL COMPLETE')
  console.log('='.repeat(80))
  console.log(`States processed: ${states.length}`)
  console.log(`ZIP codes processed: ${zipsProcessed.toLocaleString()}`)
  console.log(`Total opportunities inserted: ${totalInserted.toLocaleString()}`)
  console.log(`Total opportunities evaluated: ${totalEvaluated.toLocaleString()}`)
  console.log(`Failed batches: ${failures}`)
  console.log(`Duration: ${durationHours}h ${durationMinutes % 60}m ${durationSeconds % 60}s`)
  console.log(`Rate: ${(zipsProcessed / durationSeconds).toFixed(2)} ZIPs/second`)
  console.log(`Completed at: ${new Date().toISOString()}`)
  console.log('='.repeat(80))

  if (totalInserted >= 100000) {
    console.log(`\n✅ SUCCESS: ${totalInserted.toLocaleString()} opportunities loaded (target: 100,000+)`)
  } else {
    console.log(`\n⚠️  WARNING: Only ${totalInserted.toLocaleString()} opportunities loaded (target: 100,000+)`)
  }

  if (failures > 0) {
    console.log(`\n⚠️  ${failures} batches failed during processing`)
  }
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error('\n[optimized-nationwide] FATAL ERROR:', message)
  if (error.stack) {
    console.error(error.stack)
  }
  process.exit(1)
}
