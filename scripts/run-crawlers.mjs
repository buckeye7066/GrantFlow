#!/usr/bin/env node
/**
 * Runs the offline-friendly crawlers against the seeded SQLite database.
 * Exits with non-zero status if any crawler throws to make CI integration easy.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { loadProfileContext } from '../backend/services/profileHelpers.js'
import { processLocalCrawlerJob } from '../backend/services/localCrawler.js'
import { processScholarshipCrawlerJob } from '../backend/services/scholarshipCrawler.js'
import { processComprehensiveCrawlerJob } from '../backend/services/comprehensiveCrawler.js'
import { processItemCrawlerJob } from '../backend/services/itemCrawler.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

function resolveDbPath() {
  if (process.env.DB_PATH && process.env.DB_PATH.trim().length > 0) {
    return path.resolve(projectRoot, process.env.DB_PATH.trim())
  }
  return path.resolve(projectRoot, 'backend', 'data', 'grantflow.db')
}

function ensureFileExists(filePath, description) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${description} at ${filePath}`)
  }
}

async function main() {
  const dbPath = resolveDbPath()
  ensureFileExists(dbPath, 'SQLite database (run `npm run seed:db`)')

  const dataDir = path.resolve(projectRoot, 'backend', 'data', 'crawlers')
  ensureFileExists(dataDir, 'crawler data directory')

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  try {
    const profileRow = db
      .prepare('SELECT id FROM profiles ORDER BY created_at ASC LIMIT 1')
      .get()
    if (!profileRow) {
      throw new Error('No profiles found in database. Seed profiles before running.')
    }

    const profileContext = loadProfileContext(db, profileRow.id)
    const fallbackZip = profileContext?.signals?.location?.zip ?? '43215'
    const fallbackState = profileContext?.signals?.location?.state ?? 'OH'

    const crawlers = [
      {
        name: 'local',
        run: () =>
          processLocalCrawlerJob({
            db,
            job: {
              id: 'local-test',
              type: 'local',
              parameters: {
                radius_miles: 500,
                limit: 10,
                zip: fallbackZip,
              },
            },
            profileContext,
            dataDir,
          }),
      },
      {
        name: 'scholarship',
        run: () =>
          processScholarshipCrawlerJob({
            db,
            job: {
              id: 'scholarship-test',
              type: 'scholarship',
              parameters: {
                limit: 8,
                state: fallbackState,
                campus_zip: fallbackZip,
              },
            },
            profileContext,
            dataDir,
          }),
      },
      {
        name: 'comprehensive',
        run: () =>
          processComprehensiveCrawlerJob({
            db,
            job: {
              id: 'comprehensive-test',
              type: 'comprehensive',
              parameters: {
                limit_per_zip: 2,
                fallback_zip_limit: 5,
                zip_list: [fallbackZip],
              },
            },
            profileContext,
            dataDir,
          }),
      },
      {
        name: 'item_search',
        run: () =>
          processItemCrawlerJob({
            db,
            job: {
              id: 'item-test',
              type: 'item_search',
              parameters: {
                item: 'laptop',
                limit: 5,
                state: fallbackState,
                zip: fallbackZip,
              },
            },
            profileContext,
            dataDir,
          }),
      },
    ]

    let failures = 0
    for (const crawler of crawlers) {
      process.stdout.write(`[crawler] Running ${crawler.name} ... `)
      try {
        const result = await Promise.resolve(crawler.run())
        const summaryParts = []
        if (typeof result?.inserted === 'number') summaryParts.push(`inserted=${result.inserted}`)
        if (typeof result?.evaluated === 'number') summaryParts.push(`evaluated=${result.evaluated}`)
        if (typeof result?.result_count === 'number') summaryParts.push(`result_count=${result.result_count}`)
        console.log(`ok${summaryParts.length ? ` (${summaryParts.join(', ')})` : ''}`)
      } catch (error) {
        failures += 1
        const message = error instanceof Error ? error.message : String(error)
        console.log('FAILED')
        console.error(`          ${message}`)
      }
    }

    if (failures > 0) {
      console.error(`\n[crawler] Completed with ${failures} failure${failures === 1 ? '' : 's'}.`)
      process.exitCode = 1
    } else {
      console.log('\n[crawler] All crawler runs completed without errors.')
    }
  } finally {
    db.close()
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[crawler] Aborted: ${message}`)
  process.exitCode = 1
})
