import fs from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'
import { adminRealCrawlersRunMultiple } from '../backend/services/anyaAdminTools.js'

function parseIntEnv(name, fallback) {
  const v = Number.parseInt(process.env[name] || '', 10)
  return Number.isFinite(v) ? v : fallback
}

function parseBoolEnv(name, fallback) {
  const v = process.env[name]
  if (v == null || v === '') return fallback
  if (v === '1' || v === 'true' || v === 'TRUE') return true
  if (v === '0' || v === 'false' || v === 'FALSE') return false
  return fallback
}

const DB_PATH = process.env.DATABASE_URL || path.resolve(process.cwd(), 'backend', 'data', 'grantflow.db')
const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')

const maxProfiles = parseIntEnv('MAX_PROFILES', 0)
const timeoutMsPerCrawler = parseIntEnv('CRAWLER_TIMEOUT_MS', 20_000)
const maxSavedPerCrawlerPerProfile = parseIntEnv('MAX_SAVED_PER_CRAWLER_PER_PROFILE', 25)
const minMatchScore = parseIntEnv('MIN_MATCH_SCORE', 80)
const itemRequest = process.env.ITEM_REQUEST || 'wheelchair van'
const dryRun = parseBoolEnv('DRY_RUN', false)

const user = {
  primary_email: process.env.ANYA_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@example.com',
  id: 'admin',
}

console.log('[anya-run-real-crawlers-all] db:', DB_PATH)
console.log('[anya-run-real-crawlers-all] admin:', user.primary_email)
console.log('[anya-run-real-crawlers-all] maxProfiles:', maxProfiles || 'ALL')
console.log('[anya-run-real-crawlers-all] minMatchScore:', minMatchScore)
console.log('[anya-run-real-crawlers-all] dryRun:', dryRun)

const db = new Database(DB_PATH)
try {
  // Ensure schema is applied so run tracking tables exist
  if (fs.existsSync(SCHEMA_PATH)) {
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
  }

  const report = await adminRealCrawlersRunMultiple(
    {
      maxProfiles: maxProfiles > 0 ? maxProfiles : null,
      timeoutMsPerCrawler,
      maxSavedPerCrawlerPerProfile,
      minMatchScore,
      itemRequest,
      dryRun,
    },
    { db, user },
  )

  const markers = db
    .prepare(
      `
        SELECT COUNT(1) AS c
        FROM funding_opportunities
        WHERE is_active=1
          AND last_verified_at IS NOT NULL
          AND evidence_url IS NOT NULL
          AND evidence_url != ''
          AND record_origin IN ('live_crawl','curated_verified')
      `,
    )
    .get()

  console.log(
    JSON.stringify(
      {
        run_id: report.run_id,
        totals: report.totals,
        artifact_path: report.artifact_path,
        active_verified_with_evidence: markers?.c ?? 0,
      },
      null,
      2,
    ),
  )
} finally {
  db.close()
}

