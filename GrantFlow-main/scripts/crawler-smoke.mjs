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
// IMPORTANT: this script uses sqlite directly (better-sqlite3). Do NOT point it at a Postgres DATABASE_URL.
const dbPath =
  process.env.DB_PATH ||
  process.env.SQLITE_DB_PATH ||
  path.join(projectRoot, 'backend', 'data', 'grantflow.db')

function normalizeSqliteValue(value) {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return value
}

function normalizeSqliteArgs(args) {
  if (args.length === 1 && Array.isArray(args[0])) {
    return [args[0].map(normalizeSqliteValue)]
  }
  if (
    args.length === 1 &&
    args[0] &&
    typeof args[0] === 'object' &&
    !Array.isArray(args[0]) &&
    !(args[0] instanceof Date) &&
    !Buffer.isBuffer(args[0])
  ) {
    const bindings = args[0]
    const normalized = {}
    for (const [key, val] of Object.entries(bindings)) {
      normalized[key] = normalizeSqliteValue(val)
    }
    return [normalized]
  }
  return args.map(normalizeSqliteValue)
}

function main() {
  const mode = 'SMOKE_MODE'
  // Smoke must be stable and use only known-200 public pages.
  const useLiveSources = true
  const maxSources = Number.parseInt(process.env.CRAWLER_MAX_SOURCES || '10', 10)
  const maxUrlsPerSource = Number.parseInt(process.env.CRAWLER_MAX_URLS_PER_SOURCE || '6', 10)
  const timeoutSeconds = Number.parseInt(process.env.CRAWLER_TIMEOUT_SECONDS || '25', 10)

  if (!fs.existsSync(dbPath)) {
    console.error(`[crawler:smoke] Database not found at ${dbPath}`)
    process.exit(1)
  }

  const raw = new Database(dbPath)
  raw.pragma('journal_mode = WAL')

  // Wrap raw better-sqlite3 so call sites can pass booleans/objects safely.
  const db = {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        get: (...args) => stmt.get(...normalizeSqliteArgs(args)),
        all: (...args) => stmt.all(...normalizeSqliteArgs(args)),
        run: (...args) => stmt.run(...normalizeSqliteArgs(args)),
      }
    },
    exec(sql) {
      return raw.exec(sql)
    },
    transaction(fn) {
      const wrapped = raw.transaction(fn)
      return (...args) => wrapped(...args)
    },
    close() {
      raw.close()
    },
  }

  runNationalCrawlerV2({
    db,
    scopeMode: mode,
    useLiveSources,
    sourceSet: 'SMOKE_SAFE_SOURCES',
    maxSources,
    maxUrlsPerSource,
    timeoutSeconds,
  })
    .then((result) => {
      // Smoke must be 100% successful on SMOKE_SAFE_SOURCES.
      if (
        result?.counts?.sources_failed > 0 ||
        (Array.isArray(result?.counts?.failures) && result.counts.failures.length > 0)
      ) {
        console.error('[crawler:smoke] FAILED (expected 100% success)', {
          crawl_run_id: result.crawl_run_id,
          counts: result.counts,
          artifacts_dir: result.artifacts_dir,
        })
        db.close()
        process.exit(1)
      }
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

