#!/usr/bin/env node
/**
 * Run Geo Crawl across (optionally capped) US ZIP codes.
 * Pulls REAL funding sources with URL only; no profile matching.
 *
 * Env:
 *   MAX_ZIPS - cap number of ZIPs (default: all; set e.g. 100 for a test run)
 *   DB_PATH  - path to grantflow.db (default: backend/data/grantflow.db)
 *
 * Run: node scripts/run-geocrawl-all-zips.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const defaultDbPath = path.join(projectRoot, 'backend', 'data', 'grantflow.db')

const dbPath = process.env.DB_PATH || defaultDbPath
const maxZips = process.env.MAX_ZIPS ? parseInt(process.env.MAX_ZIPS, 10) : null

async function main() {
  const { runNationalZipCrawl } = await import('../backend/services/crawlers/nationalZipCrawler.js')

  const options = {
    discover_local_resources: true,
    rate_limit_ms: 800,
    batch_size: 25,
    min_sources_per_zip: 3,
    timeout_ms: 12000,
    resume: false,
  }
  if (Number.isFinite(maxZips) && maxZips > 0) {
    options.max_zips = maxZips
  }

  console.log('[run-geocrawl-all-zips] Starting Geo Crawl (real funding sources with URL only)')
  console.log('[run-geocrawl-all-zips] DB:', dbPath)
  console.log('[run-geocrawl-all-zips] max_zips:', options.max_zips ?? 'all US ZIPs (set MAX_ZIPS for a capped run)')
  if (!options.max_zips) {
    console.log('[run-geocrawl-all-zips] Full run: all US ZIPs (~43k). Expect long runtime; rate_limit_ms=800.')
  }
  console.log('')

  const result = await runNationalZipCrawl(dbPath, options)

  console.log('')
  console.log('[run-geocrawl-all-zips] Done:', {
    processed: result.processed,
    sources: result.sources,
    failed: result.failed,
    skipped: result.skipped,
    duration_min: result.duration ? (result.duration / 1000 / 60).toFixed(2) : 0,
  })
  process.exitCode = result.failed > 0 ? 1 : 0
}

main().catch((err) => {
  console.error('[run-geocrawl-all-zips]', err?.message || err)
  process.exitCode = 1
})
