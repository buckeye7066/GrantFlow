#!/usr/bin/env node
/**
 * `npm run db:check`
 *
 * Fails CI if the database is drifted from what backend code expects.
 *
 * Runs the same schema-drift probe that admin.diagnostics.schema_checks
 * exposes, so a CI failure here predicts an admin.diagnostics failure in
 * staging. Exits 0 when `missing_columns` is empty and `missing_tables` is
 * empty; exits 1 (with a one-line human summary) otherwise.
 *
 * Honors DB dialect via the normal backend/db/index.js wiring. Set
 * DATABASE_URL / SQLITE_DB_PATH as usual; defaults to the in-repo sqlite.
 */

import { getDb } from '../backend/db/index.js'
import { getSystemDiagnostics } from '../backend/services/diagnosticsService.js'

async function main() {
  const db = getDb()
  const d = await getSystemDiagnostics(db)
  const sc = d?.db?.schema_checks || {}
  const missingCols = sc?.details?.missing_columns || []
  const missingTables = sc?.details?.missing_tables || []

  if (missingCols.length === 0 && missingTables.length === 0) {
    console.log(`[db:check] OK (dialect=${sc?.details?.dialect || 'unknown'})`)
    await db.close?.()
    process.exit(0)
  }

  console.error('[db:check] DRIFT DETECTED')
  if (missingCols.length) {
    console.error(`  missing columns (${missingCols.length}):`)
    for (const c of missingCols) console.error(`    - ${c}`)
  }
  if (missingTables.length) {
    console.error(`  missing tables (${missingTables.length}):`)
    for (const t of missingTables) console.error(`    - ${t}`)
  }
  console.error('')
  console.error('  Run `npm run migrate` to apply pending migrations,')
  console.error('  or set MIGRATE_ON_BOOT=1 in the server environment.')
  await db.close?.()
  process.exit(1)
}

main().catch((err) => {
  console.error('[db:check] FAILED:', err?.message || err)
  process.exit(2)
})
