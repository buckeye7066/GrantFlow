#!/usr/bin/env node
/**
 * crawler:run
 * Configurable run:
 * - SMOKE_MODE (default)
 * - STATE_MODE (requires CRAWLER_STATE=XX)
 * - NATIONAL_MODE
 *
 * Use CRAWLER_USE_LIVE_SOURCES=true for https crawling (polite, robots-aware).
 */

import path from 'node:path'
import Database from 'better-sqlite3'
import fs from 'node:fs'

import { runNationalCrawlerV2 } from '../backend/services/nationalCrawlerV2/run.js'

const projectRoot = path.resolve(process.cwd())
const dbPath = process.env.DATABASE_URL || path.join(projectRoot, 'backend', 'data', 'grantflow.db')

function main() {
  const scopeMode = process.env.CRAWLER_MODE || 'SMOKE_MODE'
  const state = process.env.CRAWLER_STATE || null
  const useLiveSources = process.env.CRAWLER_USE_LIVE_SOURCES === 'true'
  const maxSources = Number.parseInt(process.env.CRAWLER_MAX_SOURCES || '25', 10)
  const maxUrlsPerSource = Number.parseInt(process.env.CRAWLER_MAX_URLS_PER_SOURCE || '12', 10)
  const timeoutSeconds = Number.parseInt(process.env.CRAWLER_TIMEOUT_SECONDS || '25', 10)

  if (!fs.existsSync(dbPath)) {
    console.error(`[crawler:run] Database not found at ${dbPath}`)
    process.exit(1)
  }

  if (scopeMode === 'STATE_MODE' && (!state || state.length !== 2)) {
    console.error('[crawler:run] STATE_MODE requires CRAWLER_STATE=XX')
    process.exit(1)
  }

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  runNationalCrawlerV2({
    db,
    scopeMode,
    state: state ? state.toUpperCase() : null,
    useLiveSources,
    maxSources,
    maxUrlsPerSource,
    timeoutSeconds,
  })
    .then((result) => {
      console.log('[crawler:run] OK', {
        crawl_run_id: result.crawl_run_id,
        artifacts_dir: result.artifacts_dir,
        counts: result.counts,
      })
      db.close()
      process.exit(0)
    })
    .catch((err) => {
      console.error('[crawler:run] FAILED', err?.message || err)
      db.close()
      process.exit(1)
    })
}

main()

