import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DB_PROVIDER = 'sqlite'
process.env.DB_DIALECT = 'sqlite'
process.env.SQLITE_DB_PATH = ':memory:'
// Force non-production so DB bootstrap allows ephemeral SQLite.
process.env.NODE_ENV = 'test'
process.env.ALLOW_EPHEMERAL_SQLITE = 'true'
process.env.ALLOW_SQLITE_IN_PROD = 'true'

const { db } = await import('../db/index.js')
const { default: runComprehensiveCrawler } = await import('../services/comprehensiveCrawlerOptimized.js')
const { DEFAULT_MIN_SCORE } = await import('../config/matchThresholds.js')

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8')
await db.exec(schemaSql)

// This intentionally runs WITHOUT backend/data/crawlers/real_funding_opportunities.json present.
// Expected behavior: single INFO about missing curated dataset; no ENOENT stack/noisy warn.
await runComprehensiveCrawler(db, {}, {
  saveToDatabase: false,
  maxResults: 1,
  matchThreshold: DEFAULT_MIN_SCORE,
})

console.log('[verify-real-opps-dataset-fallback] OK (completed without throwing)')
