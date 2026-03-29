#!/usr/bin/env node
/**
 * One-time backfill utility for funding_opportunities.
 *
 * - Normalize `deadline` into ISO (YYYY-MM-DD) so SQLite date filters work.
 * - Optionally fill `geo_county` when `geo_zip` exists (offline resolver).
 *
 * Safe by design:
 * - Idempotent (re-running results in 0 updates)
 * - Logged (counts + sample of changes)
 * - Reversible (does not run automatically; only updates specific derived fields)
 */

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'
import { normalizeDateToIso } from '../backend/services/dateNormalization.js'
import { resolveCountyForZip } from '../backend/services/geo/zipCountyResolver.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function parseArgs(argv) {
  const args = { dryRun: false, limit: null, dbPath: null, table: null, fillCounty: true }
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--no-county') args.fillCounty = false
    else if (a === '--limit') args.limit = Number.parseInt(argv[i + 1] || '0', 10) || null
    else if (a === '--db') args.dbPath = argv[i + 1] || null
    else if (a === '--table') args.table = argv[i + 1] || null
  }
  return args
}

function defaultDbPath() {
  // Prefer explicit env vars used by backend.
  const fromEnv =
    process.env.DB_PATH ||
    process.env.SQLITE_DB_PATH ||
    process.env.DATABASE_PATH ||
    null
  if (fromEnv) return path.resolve(fromEnv)
  // Repo default.
  return path.resolve(__dirname, '..', 'backend', 'data', 'grantflow.db')
}

function main() {
  const { dryRun, limit, dbPath, table, fillCounty } = parseArgs(process.argv)

  if (/^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || '')) {
    console.error('ERROR: This script only supports SQLite databases. DATABASE_URL points to PostgreSQL.')
    console.error('Use the application API or a Postgres client instead.')
    process.exit(1)
  }

  const target = path.resolve(dbPath || defaultDbPath())

  // Lightweight logging header.
  console.log('[backfill] target db:', target)
  console.log('[backfill] options:', { dryRun, limit, fillCounty, table })

  const db = new Database(target)

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => row.name)

  const candidates = [
    table ? String(table) : null,
    'funding_opportunities',
    'fundingOpportunities',
    'opportunities',
  ].filter(Boolean)

  const oppTable = candidates.find((name) => tables.includes(name)) || null
  if (!oppTable) {
    console.error(
      '[backfill] No opportunities table found. Expected one of: ' +
        candidates.map((c) => `"${c}"`).join(', ') +
        '\n' +
        '[backfill] Available tables: ' +
        (tables.length ? tables.join(', ') : '(none)') +
        '\n' +
        'Fix: pass the correct table name via --table, or point --db at the GrantFlow SQLite database.',
    )
    process.exitCode = 2
    return
  }

  const quotedTable = `"${String(oppTable).replaceAll('"', '""')}"`
  const columns = db
    .prepare(`PRAGMA table_info(${quotedTable})`)
    .all()
    .map((row) => row.name)
  const hasColumn = (name) => columns.includes(name)

  if (!hasColumn('deadline')) {
    console.warn('[backfill] Table has no deadline column; deadline normalization disabled.')
  }
  if (fillCounty && !(hasColumn('geo_zip') && hasColumn('geo_county'))) {
    console.warn('[backfill] Table lacks geo_zip/geo_county columns; county backfill disabled.')
  }

  const where = []
  // Deadlines that are likely non-ISO or have time suffixes.
  if (hasColumn('deadline')) {
    where.push("(deadline IS NOT NULL AND deadline != '' AND (deadline LIKE '%/%' OR deadline LIKE '____-__-__-__-__-__'))")
  }
  if (fillCounty && hasColumn('geo_zip') && hasColumn('geo_county')) {
    // IMPORTANT: SQLite treats double quotes as identifiers. Use single quotes for string literals.
    where.push("(geo_zip IS NOT NULL AND geo_zip != '' AND (geo_county IS NULL OR geo_county = ''))")
  }
  const whereSql = where.length ? `WHERE ${where.join(' OR ')}` : ''
  const limitSql = limit ? `LIMIT ${Number(limit)}` : ''

  const rows = db
    .prepare(
      `
        SELECT id, deadline, deadline_type, geo_zip, geo_county, state
        FROM ${quotedTable}
        ${whereSql}
        ${limitSql}
      `,
    )
    .all()

  console.log('[backfill] rows selected:', rows.length)

  let deadlineUpdated = 0
  let countyUpdated = 0
  const samples = []

  const updateDeadlineStmt = db.prepare(
    `UPDATE ${quotedTable}
     SET deadline = ?, deadline_type = COALESCE(deadline_type, 'fixed'), updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
  const updateCountyStmt = db.prepare(
    `UPDATE ${quotedTable}
     SET geo_county = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )

  const tx = db.transaction(() => {
    for (const row of rows) {
      if (hasColumn('deadline')) {
        const beforeDeadline = row.deadline ?? null
        const afterDeadline = normalizeDateToIso(beforeDeadline)
        if (afterDeadline && beforeDeadline && String(beforeDeadline) !== String(afterDeadline)) {
          deadlineUpdated += 1
          if (!dryRun) updateDeadlineStmt.run(afterDeadline, row.id)
          if (samples.length < 10) samples.push({ id: row.id, deadline: { from: beforeDeadline, to: afterDeadline } })
        }
      }

      if (fillCounty && hasColumn('geo_zip') && hasColumn('geo_county')) {
        const zip = row.geo_zip ? String(row.geo_zip).trim() : ''
        const county = row.geo_county ? String(row.geo_county).trim() : ''
        if (zip && !county) {
          const resolved = resolveCountyForZip(zip, row.state || null)
          if (resolved) {
            countyUpdated += 1
            if (!dryRun) updateCountyStmt.run(resolved, row.id)
            if (samples.length < 10) samples.push({ id: row.id, county: { to: resolved }, zip })
          }
        }
      }
    }
  })

  tx()

  console.log('[backfill] updated:', { deadlineUpdated, countyUpdated })
  if (samples.length) console.log('[backfill] sample changes:', samples)
  console.log('[backfill] done', dryRun ? '(dry-run)' : '')
}

main()

