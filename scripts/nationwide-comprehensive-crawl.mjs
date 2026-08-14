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

/**
 * WHY THIS WAS REWRITTEN (2026-08-14) — the script could not do its stated job.
 *
 * Three defects compounded, and every one of them was invisible in the output:
 *
 * 1. `runComprehensiveCrawler` is `async`, and the old loop never awaited it.
 *    `result?.inserted` was therefore read off a PROMISE, so `totalInserted` and
 *    `totalEvaluated` were ALWAYS 0: every ZIP printed "(BELOW MINIMUM)" and the
 *    final report claimed "Total opportunities inserted: 0" for a full 43,859-ZIP
 *    crawl. The try/catch could not catch a rejected promise either, so the
 *    documented "Stop immediately on error" guarantee never held — failures
 *    surfaced as unhandled rejections.
 *
 * 2. Because it was `Array.prototype.forEach` over a non-awaited async call, all
 *    43,859 crawls were launched at once rather than sequenced — a fetch storm
 *    against grants.gov/Overpass that would earn a rate-limit or bot wall long
 *    before it earned any data.
 *
 * 3. The ZIP lane never ran AT ALL. `runComprehensiveCrawler` only reads
 *    `zip_list` / `min_sources_per_zip` inside its `parameters.mode === 'geo'`
 *    branch; without that flag it falls through to profile matching, which was
 *    then handed `profileContext: null`. So the "crawl ALL USA ZIP codes" script
 *    ran profile matching against an empty profile, once per ZIP, and ignored
 *    the ZIP list entirely. (`dataDir` was passed and never read.)
 *
 * The geo lane already batches, paces, resumes and enforces a per-ZIP minimum
 * internally, so the correct shape is ONE call carrying the whole ZIP list —
 * not one call per ZIP. Counters are read from the keys that branch actually
 * returns (`inserted` = sources, `evaluated` = ZIPs processed, plus
 * `result_meta.failed` / `.skipped`).
 */
async function main() {
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

  const minSourcesPerZip = Number(process.env.NATIONWIDE_MIN_SOURCES_PER_ZIP || 3)
  const batchSize = Number(process.env.NATIONWIDE_BATCH_SIZE || 50)
  const rateLimitMs = Number(process.env.NATIONWIDE_RATE_LIMIT_MS || 250)

  console.log(`[nationwide-crawler] Starting comprehensive nationwide crawl`)
  console.log(`[nationwide-crawler] Total ZIP codes to process: ${zipCodes.length.toLocaleString()}`)
  console.log(`[nationwide-crawler] Minimum opportunities per ZIP: ${minSourcesPerZip}`)
  console.log(`[nationwide-crawler] Batch size: ${batchSize}, pacing: ${rateLimitMs}ms/ZIP`)
  console.log(`[nationwide-crawler] No upper limit - comprehensive coverage\n`)

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  const startedAt = Date.now()
  console.log(`Starting crawl at ${new Date().toISOString()}\n`)

  const job = {
    id: `nationwide-comprehensive-${Date.now()}`,
    type: 'comprehensive',
    parameters: {
      // REQUIRED: without mode:'geo' the ZIP list below is never read.
      mode: 'geo',
      zip_list: zipCodes,
      // No cap — this script exists to be exhaustive.
      max_zips: null,
      batch_size: batchSize,
      rate_limit_ms: rateLimitMs,
      min_sources_per_zip: minSourcesPerZip,
      // Hit the real upstream sources; offline_only would make this a no-op crawl.
      offline_only: false,
      discover_local_resources: true,
      // Pick up where a previous interrupted run stopped instead of restarting.
      resume: true,
    },
  }

  let result
  try {
    result = await processComprehensiveCrawlerJob({
      db,
      job,
      profileContext: null, // null means opportunities are visible to ALL profiles
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`\n[nationwide-crawler] CRAWL FAILED: ${message}`)
    console.error(error instanceof Error ? error.stack : '')
    db.close()
    process.exit(1)
  }

  db.close()

  const meta = result?.result_meta ?? {}
  const totalInserted = Number(result?.inserted ?? meta.sources ?? 0)
  const totalEvaluated = Number(result?.evaluated ?? meta.processed ?? 0)
  const failures = Number(meta.failed ?? 0)
  const skipped = Number(meta.skipped ?? 0)

  const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  const durationMinutes = Math.floor(durationSeconds / 60)
  const durationHours = Math.floor(durationMinutes / 60)

  console.log('\n' + '='.repeat(80))
  console.log('NATIONWIDE COMPREHENSIVE CRAWL COMPLETE')
  console.log('='.repeat(80))
  console.log(`ZIP codes offered:          ${zipCodes.length.toLocaleString()}`)
  console.log(`ZIP codes processed:        ${totalEvaluated.toLocaleString()}`)
  console.log(`ZIP codes skipped (resume): ${skipped.toLocaleString()}`)
  console.log(`ZIP codes failed:           ${failures.toLocaleString()}`)
  console.log(`Opportunities inserted:     ${totalInserted.toLocaleString()}`)
  console.log(`Duration: ${durationHours}h ${durationMinutes % 60}m ${durationSeconds % 60}s`)
  console.log(`Completed at: ${new Date().toISOString()}`)
  console.log('='.repeat(80))

  // An exhaustive crawl that processed NOTHING is a failure, not a success —
  // say so with a non-zero exit rather than printing a clean summary of zeros.
  if (totalEvaluated === 0 && skipped === 0) {
    console.error('\n[nationwide-crawler] NO ZIP CODES WERE PROCESSED — treating this run as failed.')
    process.exit(1)
  }
  if (failures > 0) {
    console.error(`\n[nationwide-crawler] ${failures} ZIP code(s) failed to process`)
    process.exit(1)
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error('\n[nationwide-crawler] FATAL ERROR:', message)
  console.error(error instanceof Error ? error.stack : '')
  process.exit(1)
})
