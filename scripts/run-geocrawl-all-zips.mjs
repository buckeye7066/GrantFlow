#!/usr/bin/env node
/**
 * THE national Geo Crawl — the single canonical crawl runner.
 *
 * Covers every US ZIP (~42.5k) + every Canadian FSA (~1.6k) = ~44k codes.
 * Guarantees a minimum of 3 real funding sources per code, with NO upper cap
 * (every eligible source found is saved). Pulls REAL sources with a URL only;
 * no profile matching.
 *
 * Env:
 *   MAX_ZIPS   - cap number of codes (default: all; set e.g. 100 for a test run)
 *   COUNTRIES  - comma list to scope (default "US,CA"; e.g. "CA" for Canada-only)
 *   DB_PATH    - path to grantflow.db (default: backend/data/grantflow.db)
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
const countries = process.env.COUNTRIES
  ? process.env.COUNTRIES.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)
  : ['US', 'CA']

async function main() {
  const { runNationalZipCrawl } = await import('../backend/services/crawlers/nationalZipCrawler.js')

  const options = {
    countries, // US + Canada by default
    discover_local_resources: true,
    rate_limit_ms: 800,
    batch_size: 25,
    min_sources_per_zip: 3, // floor; no max (all eligible sources are saved)
    timeout_ms: 12000,
    resume: false,
  }
  if (Number.isFinite(maxZips) && maxZips > 0) {
    options.max_zips = maxZips
  }

  console.log('[geocrawl] Starting national Geo Crawl (real funding sources with URL only)')
  console.log('[geocrawl] DB:', dbPath)
  console.log('[geocrawl] countries:', countries.join(', '))
  console.log('[geocrawl] min_sources_per_zip: 3 (no max)')
  console.log('[geocrawl] max_zips:', options.max_zips ?? 'all codes (set MAX_ZIPS for a capped run)')
  if (!options.max_zips) {
    console.log('[geocrawl] Full run: all US ZIPs + Canadian FSAs (~44k). Expect long runtime; rate_limit_ms=800.')
  }
  console.log('')

  const result = await runNationalZipCrawl(dbPath, options)

  console.log('')
  console.log('[geocrawl] Done:', {
    processed: result.processed,
    sources: result.sources,
    failed: result.failed,
    skipped: result.skipped,
    duration_min: result.duration ? (result.duration / 1000 / 60).toFixed(2) : 0,
  })
  process.exitCode = result.failed > 0 ? 1 : 0
}

main().catch((err) => {
  console.error('[geocrawl]', err?.message || err)
  process.exitCode = 1
})
