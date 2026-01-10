#!/usr/bin/env node
/**
 * Ensure and/or verify the minimum number of REAL national opportunities.
 *
 * Definition (enforceable with current schema):
 * - >= MIN_NATIONAL_OPPORTUNITIES (default 3) opportunities where:
 *   - is_active = 1
 *   - is_national = 1
 *   - source_url is present
 *   - source NOT IN (synthetic/template/comprehensive_crawler)
 */

import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'

import ensureMinimumNationalOpportunities from '../backend/utils/ensureMinimumNationalOpportunities.js'

const projectRoot = path.resolve(process.cwd())
const dbPath = process.env.DATABASE_URL || path.join(projectRoot, 'backend', 'data', 'grantflow.db')
const schemaPath = path.join(projectRoot, 'backend', 'db', 'schema.sql')

function countRealNational(db) {
  return (
    db
      .prepare(
        `
          SELECT COUNT(*) AS c
          FROM funding_opportunities
          WHERE is_active=1
            AND is_national=1
            AND source_url IS NOT NULL
            AND source_url != ''
            AND (source IS NULL OR LOWER(source) NOT IN ('synthetic','template','comprehensive_crawler'))
        `,
      )
      .get()?.c ?? 0
  )
}

function main() {
  const mode = (process.argv[2] || 'check').toLowerCase()
  const minimum = Number.parseInt(process.env.MIN_NATIONAL_OPPORTUNITIES || '3', 10) || 3

  if (!fs.existsSync(path.dirname(dbPath))) fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, '')

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(fs.readFileSync(schemaPath, 'utf8'))

  const before = countRealNational(db)
  if (mode === 'ensure') {
    const ensured = ensureMinimumNationalOpportunities(db, minimum)
    const after = countRealNational(db)
    console.log('[opps:national-minimum] ensure', { minimum, before, after, ensured })
    db.close()
    process.exit(after >= minimum ? 0 : 1)
  }

  console.log('[opps:national-minimum] check', { minimum, count: before })
  db.close()
  process.exit(before >= minimum ? 0 : 1)
}

main()

