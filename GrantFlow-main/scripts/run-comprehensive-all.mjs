#!/usr/bin/env node
/**
 * Executes the comprehensive crawler for every ZIP code in backend/data/crawlers/zip_coordinates.json.
 * Results are upserted into the funding_opportunities table (same as the regular crawler job).
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { processComprehensiveCrawlerJob } from '../backend/services/comprehensiveCrawler.js'

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

  ensureFile(dbPath, 'SQLite database (run `npm run seed:db`)')
  ensureFile(zipFile, 'zip coordinate file')

  const zipMap = JSON.parse(fs.readFileSync(zipFile, 'utf8'))
  const zipCodes = Object.keys(zipMap)
  if (zipCodes.length === 0) {
    console.warn('[comprehensive-all] No ZIP codes found; exiting.')
    return
  }

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  const startedAt = Date.now()
  let totalInserted = 0
  let totalEvaluated = 0
  let failures = 0

  zipCodes.forEach((zip, index) => {
    const job = {
      id: `comprehensive-${zip}-${Date.now()}`,
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

      totalInserted += Number(result?.inserted ?? 0)
      totalEvaluated += Number(result?.evaluated ?? 0)

      console.log(
        `[${index + 1}/${zipCodes.length}] ZIP ${zip.padEnd(5)} → inserted ${
          result?.inserted ?? 0
        }, evaluated ${result?.evaluated ?? 0}`,
      )
    } catch (error) {
      failures += 1
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${index + 1}/${zipCodes.length}] ZIP ${zip} failed: ${message}`)
    }
  })

  db.close()

  const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  console.log('---')
  console.log(
    `[comprehensive-all] Complete — inserted ${totalInserted} opportunities, evaluated ${totalEvaluated}, failures ${failures}, duration ${durationSeconds}s.`,
  )
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error('[comprehensive-all] Aborted:', message)
  process.exitCode = 1
}
