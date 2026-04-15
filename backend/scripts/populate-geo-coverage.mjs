#!/usr/bin/env node
/**
 * populate-geo-coverage.mjs
 *
 * Initial population of the geographic coverage system:
 * 1. Creates geo_zip_coverage table + indexes
 * 2. Populates nearby-ZIP cache for every profile ZIP (25mi + 50mi radii)
 * 3. Reports which states need geo crawling (no completed geo_state_runs)
 * 4. Optionally dispatches geo crawls for uncovered states (--crawl flag)
 *
 * Usage:
 *   node backend/scripts/populate-geo-coverage.mjs             # populate ZIP coverage only
 *   node backend/scripts/populate-geo-coverage.mjs --crawl     # also dispatch geo crawls for uncovered states
 *   node backend/scripts/populate-geo-coverage.mjs --state OH  # only populate for a specific state
 */

import path from 'path'
import crypto from 'crypto'
import { db } from '../db/index.js'
import {
  ensureGeoCoverageTables,
  populateProfileZipCoverage,
  findStatesNeedingCoverage,
  populateZipCoverage,
  findNearbyZips,
} from '../services/geo/geoCoverageService.js'

const args = process.argv.slice(2)
const doCrawl = args.includes('--crawl')
const stateFlag = args.find((a, i) => args[i - 1] === '--state')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  console.log('='.repeat(70))
  console.log('Geographic Coverage Population')
  console.log('='.repeat(70))

  // Step 1: Ensure tables exist
  console.log('\n[1/4] Ensuring geo coverage tables...')
  await ensureGeoCoverageTables(db)
  console.log('  Tables ready.')

  // Step 2: Populate ZIP coverage for all profile ZIPs
  console.log('\n[2/4] Populating nearby-ZIP coverage for profile ZIPs...')
  const { zips, entries } = await populateProfileZipCoverage(db)
  console.log(`  Done: ${zips} profile ZIPs → ${entries} coverage entries.`)

  // Step 3: Report state coverage
  console.log('\n[3/4] Checking state coverage...')
  const { all, covered, uncovered } = await findStatesNeedingCoverage(db)
  console.log(`  Profile states: ${all.length}`)
  console.log(`  Already covered: ${covered.length} — ${covered.join(', ') || '(none)'}`)
  console.log(`  Need crawling:   ${uncovered.length} — ${uncovered.join(', ') || '(none)'}`)

  // Step 4: Optionally dispatch geo crawls
  if (doCrawl && uncovered.length > 0) {
    console.log('\n[4/4] Dispatching geo crawls for uncovered states...')

    if (!process.env.CRAWLER_DATA_DIR) {
      process.env.CRAWLER_DATA_DIR = path.resolve(process.cwd(), 'backend', 'tests', 'fixtures', 'crawlers')
    }

    const { dispatchCrawlerJob } = await import('../services/crawlerDispatcher.js')
    const { createGeoCrawlRun } = await import('../services/geoCrawlRunStore.js')

    const targetStates = stateFlag ? [stateFlag.toUpperCase()] : uncovered

    for (const st of targetStates) {
      console.log(`\n  Dispatching geo crawl for ${st}...`)
      const geoRunId = crypto.randomUUID()
      try {
        await createGeoCrawlRun(db, {
          id: geoRunId,
          state: st,
          type: 'geo',
          status: 'pending',
        })
      } catch {
        // table may not exist yet
      }

      try {
        await dispatchCrawlerJob(db, {
          mode: 'geo',
          geo_run_id: geoRunId,
          state: st,
          max_zips: 20,
          offline_only: true,
          min_sources_per_zip: 3,
          resume: false,
        })
        console.log(`  ✓ ${st} dispatched (run=${geoRunId}, max_zips=20, offline_only)`)
      } catch (e) {
        console.error(`  ✗ ${st} dispatch failed:`, e?.message || e)
      }

      await sleep(500)
    }
  } else if (doCrawl && uncovered.length === 0) {
    console.log('\n[4/4] All profile states already have geo coverage. Nothing to dispatch.')
  } else {
    console.log('\n[4/4] Skipping crawl dispatch (use --crawl to enable).')
  }

  // Summary
  console.log('\n' + '='.repeat(70))
  console.log('Summary')
  console.log('='.repeat(70))
  console.log(`  Profile ZIPs populated: ${zips}`)
  console.log(`  Coverage entries:       ${entries}`)
  console.log(`  States covered:         ${covered.length}/${all.length}`)
  if (uncovered.length > 0 && !doCrawl) {
    console.log(`\n  To crawl uncovered states, run:`)
    console.log(`    node backend/scripts/populate-geo-coverage.mjs --crawl`)
  }
  console.log()
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Fatal error:', e)
    process.exit(1)
  })
