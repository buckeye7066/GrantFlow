#!/usr/bin/env node
/**
 * Ensure and/or verify the minimum number of REAL national opportunities.
 *
 * Definition (enforceable with current schema):
 * - >= MIN_NATIONAL_OPPORTUNITIES (default 3) opportunities where:
 *   - is_active = 1
 *   - is_national = 1
 *   - source_url is present
 *   - record_origin IN (live_crawl, curated_verified)
 */

import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'

import ensureMinimumNationalOpportunities from '../backend/utils/ensureMinimumNationalOpportunities.js'

const projectRoot = path.resolve(process.cwd())
const dbPath = process.env.DATABASE_URL || path.join(projectRoot, 'backend', 'data', 'grantflow.db')
const schemaPath = path.join(projectRoot, 'backend', 'db', 'schema.sql')

function hasColumn(db, tableName, columnName) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all()
    return cols.some((c) => String(c.name).toLowerCase() === String(columnName).toLowerCase())
  } catch {
    return false
  }
}

function ensureRecordOriginColumn(db) {
  if (hasColumn(db, 'funding_opportunities', 'record_origin')) return { ok: true, added: false }
  db.prepare(`ALTER TABLE funding_opportunities ADD COLUMN record_origin TEXT DEFAULT 'live_crawl'`).run()
  return { ok: true, added: true }
}

function backfillRecordOrigins(db) {
  // Positive classification: mark curated sources, default everything else to live_crawl.
  db.prepare(
    `
      UPDATE funding_opportunities
      SET record_origin = 'curated_verified'
      WHERE (record_origin IS NULL OR record_origin = '')
        AND LOWER(COALESCE(source, '')) IN ('seeded_real_grant','seeded_real','verified_real')
    `,
  ).run()
  db.prepare(
    `
      UPDATE funding_opportunities
      SET record_origin = 'live_crawl'
      WHERE (record_origin IS NULL OR record_origin = '')
    `,
  ).run()
}

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
            AND record_origin IN ('live_crawl','curated_verified')
        `,
      )
      .get()?.c ?? 0
  )
}

function countZipScopedNationalReal(db, state, limit = 50) {
  // Mirrors backend/routes/opportunities.js behavior for state-scoped first page:
  // return up to MIN_NATIONAL_VISIBLE nationals + remainder locals (non-national) within limit.
  const minNationalVisible = Math.max(
    Number.parseInt(process.env.MIN_NATIONAL_VISIBLE || '3', 10) || 3,
    0,
  )

  const orderClause = `
    ORDER BY
      CASE WHEN deadline IS NULL OR deadline = '' THEN 1 ELSE 0 END,
      deadline ASC,
      created_at DESC
  `

  const nationals = db
    .prepare(
      `
        SELECT id, title, is_national, record_origin
        FROM funding_opportunities
        WHERE is_active = 1
          AND is_national = 1
        ${orderClause}
        LIMIT ?
      `,
    )
    .all(minNationalVisible)

  const remaining = Math.max(limit - nationals.length, 0)
  const locals = remaining > 0
    ? db
        .prepare(
          `
            SELECT id, title, is_national, record_origin
            FROM funding_opportunities
            WHERE is_active = 1
              AND state = ?
              AND (is_national IS NULL OR is_national = 0)
            ${orderClause}
            LIMIT ?
          `,
        )
        .all(state, remaining)
    : []

  const rows = [...locals, ...nationals]
  const nationalReal = rows.filter(
    (r) =>
      Number(r.is_national) === 1 &&
      (r.record_origin === 'live_crawl' || r.record_origin === 'curated_verified'),
  )

  return { returned: rows.length, national_real: nationalReal.length, locals: locals.length, nationals: nationals.length }
}

async function main() {
  const mode = (process.argv[2] || 'check').toLowerCase()
  const minimum = Number.parseInt(process.env.MIN_NATIONAL_OPPORTUNITIES || '3', 10) || 3
  const testState = (process.env.TEST_STATE || 'CA').toUpperCase()

  if (!fs.existsSync(path.dirname(dbPath))) fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, '')

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(fs.readFileSync(schemaPath, 'utf8'))

  // Ensure new column exists even on an already-created DB file.
  try {
    ensureRecordOriginColumn(db)
    backfillRecordOrigins(db)
  } catch {
    // best-effort; checks will fail loudly if invariant is not enforceable
  }

  const before = countRealNational(db)
  const zipScopedBefore = countZipScopedNationalReal(db, testState, 50)
  if (mode === 'ensure') {
    const ensured = await ensureMinimumNationalOpportunities(db, minimum)
    const after = countRealNational(db)
    const zipScopedAfter = countZipScopedNationalReal(db, testState, 50)
    console.log('[opps:national-minimum] ensure', {
      minimum,
      before,
      after,
      zip_scoped: { state: testState, before: zipScopedBefore, after: zipScopedAfter },
      ensured,
    })
    db.close()
    process.exit(after >= minimum && zipScopedAfter.national_real >= minimum ? 0 : 1)
  }

  console.log('[opps:national-minimum] check', {
    minimum,
    count: before,
    zip_scoped: { state: testState, result: zipScopedBefore },
  })
  db.close()
  process.exit(before >= minimum && zipScopedBefore.national_real >= minimum ? 0 : 1)
}

main()

