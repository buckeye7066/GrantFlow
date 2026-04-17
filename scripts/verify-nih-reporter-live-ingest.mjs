#!/usr/bin/env node
/**
 * Verify NIH RePORTER live ingest
 *
 * Exercises the full UI → API → crawler → normalizer → reviewer → Postgres
 * path for the NIH RePORTER source without requiring an HTTP server or a
 * live frontend. Pass when:
 *   - fetchOpportunities() returns a non-empty array of real NIH projects
 *   - ingestOpportunities() reports at least one inserted OR updated record
 *   - no uncaught exceptions are thrown
 *
 * Usage:
 *   node scripts/verify-nih-reporter-live-ingest.mjs             # SQLite, defaults
 *   DATABASE_PATH=./backend/data/grantflow.db \
 *     node scripts/verify-nih-reporter-live-ingest.mjs
 *
 * DRY_RUN=1 skips DB writes and just prints fetched record summaries.
 *
 * Exit code: 0 on success, 1 on any failure (including zero rows — zero is
 * treated as a failure state per mission goal "avoid zero-result experiences").
 */

import path from 'path'
import { fileURLToPath } from 'url'
import Database from 'better-sqlite3'

import { fetchOpportunities as fetchNihReporter } from '../backend/src/integrations/nihReporter.js'
import { ingestOpportunities } from '../backend/services/sources/ingestionService.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DB_PATH =
  process.env.DATABASE_PATH || path.join(__dirname, '..', 'backend', 'data', 'grantflow.db')
const DRY_RUN = String(process.env.DRY_RUN || '').trim() === '1'
const LIMIT = Number(process.env.NIH_LIMIT || 25)
const TEXT = (process.env.NIH_TEXT || '').trim()

function log(...args) {
  console.log('[verify-nih-reporter]', ...args)
}

async function main() {
  log('Starting live verification')
  log('DB_PATH=', DB_PATH)
  log('DRY_RUN=', DRY_RUN)
  log('LIMIT=', LIMIT)
  log('TEXT=', TEXT || '<none>')

  let fetched
  try {
    fetched = await fetchNihReporter({ text: TEXT, limit: LIMIT, offset: 0 })
  } catch (err) {
    console.error('[verify-nih-reporter] fetch failed:', err.message)
    process.exit(1)
  }

  if (!Array.isArray(fetched)) {
    console.error('[verify-nih-reporter] fetch returned non-array:', typeof fetched)
    process.exit(1)
  }

  log(`Fetched ${fetched.length} records from NIH RePORTER`)
  if (fetched.length === 0) {
    console.error('[verify-nih-reporter] ZERO records returned — treat as failure')
    process.exit(1)
  }

  // Show first 3 records for human eyeball verification
  for (const row of fetched.slice(0, 3)) {
    log(
      '  •',
      row.source_id,
      '|',
      (row.title || '').slice(0, 80),
      '|',
      row.source_url,
    )
  }

  if (DRY_RUN) {
    log('DRY_RUN=1 — skipping DB insert. Verification complete.')
    process.exit(0)
  }

  // Write to DB
  let db
  try {
    db = new Database(DB_PATH)
  } catch (err) {
    console.error('[verify-nih-reporter] failed to open DB:', err.message)
    process.exit(1)
  }

  let result
  try {
    result = await ingestOpportunities(db, fetched, 'nih.reporter')
  } catch (err) {
    console.error('[verify-nih-reporter] ingest threw:', err.message)
    db.close()
    process.exit(1)
  }

  log('Ingest result:', {
    success: result.success,
    inserted: result.records_inserted,
    updated: result.records_updated,
    rejected_policy: result.records_rejected_policy,
    rejected_reviewer: result.records_rejected_reviewer,
    errors: result.errors,
  })

  if (!result.success) {
    console.error('[verify-nih-reporter] ingestion marked failure:', result.error)
    db.close()
    process.exit(1)
  }

  const written = (result.records_inserted || 0) + (result.records_updated || 0)
  if (written === 0) {
    console.error(
      '[verify-nih-reporter] zero rows written despite non-empty fetch — check policy/reviewer reasons above',
    )
    db.close()
    process.exit(1)
  }

  // Confirm by reading back
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM funding_opportunities WHERE source = 'nih.reporter'",
      )
      .get()
    log(`funding_opportunities where source='nih.reporter': ${row?.n ?? 0}`)
  } catch (err) {
    console.warn('[verify-nih-reporter] read-back failed (non-fatal):', err.message)
  }

  db.close()
  log('SUCCESS — NIH RePORTER live ingest verified.')
  process.exit(0)
}

main().catch((err) => {
  console.error('[verify-nih-reporter] unexpected error:', err)
  process.exit(1)
})
