#!/usr/bin/env node
/**
 * crawler:smoke
 * - Runs the V2 national funding crawler in SMOKE_MODE (tiny curated sources)
 * - Writes artifacts to /artifacts/crawler/YYYY-MM-DD/
 */

import path from 'node:path'
import Database from 'better-sqlite3'
import fs from 'node:fs'

import { runNationalCrawlerV2 } from '../backend/services/nationalCrawlerV2/run.js'

const projectRoot = path.resolve(process.cwd())
const dbPath = process.env.DATABASE_URL || path.join(projectRoot, 'backend', 'data', 'grantflow.db')

function main() {
  const mode = 'SMOKE_MODE'
  const useLiveSources = process.env.CRAWLER_USE_LIVE_SOURCES === 'true'
  const maxSources = Number.parseInt(process.env.CRAWLER_MAX_SOURCES || '10', 10)
  const maxUrlsPerSource = Number.parseInt(process.env.CRAWLER_MAX_URLS_PER_SOURCE || '6', 10)
  const timeoutSeconds = Number.parseInt(process.env.CRAWLER_TIMEOUT_SECONDS || '25', 10)

  if (!fs.existsSync(dbPath)) {
    console.error(`[crawler:smoke] Database not found at ${dbPath}`)
    process.exit(1)
  }

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  runNationalCrawlerV2({
    db,
    scopeMode: mode,
    useLiveSources,
    maxSources,
    maxUrlsPerSource,
    timeoutSeconds,
  })
    .then((result) => {
      console.log('[crawler:smoke] OK', {
        crawl_run_id: result.crawl_run_id,
        artifacts_dir: result.artifacts_dir,
        counts: result.counts,
      })
      db.close()
      process.exit(0)
    })
    .catch((err) => {
      console.error('[crawler:smoke] FAILED', err?.message || err)
      db.close()
      process.exit(1)
    })
}

main()

