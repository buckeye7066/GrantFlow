#!/usr/bin/env node
/**
 * `npm run db:backup` — REAL database backup (epic slice 9).
 *
 * Implementation lives in `backend/services/ops/databaseBackup.js` so the
 * nightly on-demand self-heal schedule and this CLI cannot drift. That module
 * stamps system_kv `backup_last_run` only AFTER integrity verification
 * (mark-after-write). Sam `ops.backupFreshness` reads the same stamp.
 *
 * Restore counterpart: scripts/restore-db.mjs <backup-file>.
 */

import { getDb } from '../backend/db/index.js'
import { runDatabaseBackup } from '../backend/services/ops/databaseBackup.js'

async function main() {
  const db = getDb()
  const result = await runDatabaseBackup({ db })
  const mb = (result.bytes / 1024 / 1024).toFixed(1)
  const pruned = result.pruned?.length
    ? `, pruned ${result.pruned.length} old backup(s)`
    : ''
  console.log(`[db:backup] OK dialect=${result.dialect} -> ${result.path} (${mb} MB)${pruned}`)
  await db.close?.()
  process.exit(0)
}

main().catch((err) => {
  console.error(`[db:backup] FAILED: ${err?.message || err}`)
  process.exit(1)
})
