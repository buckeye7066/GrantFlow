#!/usr/bin/env node
/**
 * `npm run db:restore -- <backup-file>` — restore a backup produced by
 * scripts/backup-db.mjs.
 *
 *   *.db    (SQLite)  → integrity-check the backup, snapshot the CURRENT db
 *                       beside it (pre-restore safety copy), then replace the
 *                       live file. Requires the backend to be STOPPED — the
 *                       script refuses when the live db is locked.
 *   *.dump  (Postgres)→ pg_restore --clean --if-exists into DATABASE_URL.
 *
 * The backup file argument IS the intent — no confirmation prompt.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const file = process.argv[2]
if (!file || !fs.existsSync(file)) {
  console.error('[db:restore] usage: npm run db:restore -- <backup-file> (file must exist)')
  process.exit(1)
}

async function restoreSqlite(backupPath) {
  const { default: Database } = await import('better-sqlite3')
  const check = new Database(backupPath, { readonly: true })
  const verdict = check.pragma('integrity_check', { simple: true })
  check.close()
  if (String(verdict).toLowerCase() !== 'ok') {
    throw new Error(`backup fails integrity_check (${verdict}) — refusing to restore from a corrupt file`)
  }

  // Resolve the live path the same way the backend does.
  const explicit = String(process.env.SQLITE_DB_PATH || '').trim()
  const livePath = explicit || (fs.existsSync('/mnt/data') ? '/mnt/data/grantflow.db' : path.join(process.cwd(), 'backend', 'db', 'grantflow.db'))
  if (!fs.existsSync(livePath)) {
    console.warn(`[db:restore] live db not found at ${livePath} — restoring as a fresh file`)
  } else {
    // Refuse while the backend holds the file (an exclusive-lock probe).
    try {
      const live = new Database(livePath)
      live.pragma('locking_mode = EXCLUSIVE')
      live.exec('BEGIN EXCLUSIVE; COMMIT;')
      live.close()
    } catch {
      throw new Error(`live database at ${livePath} is locked — stop the backend first`)
    }
    const safety = `${livePath}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`
    fs.copyFileSync(livePath, safety)
    console.log(`[db:restore] pre-restore safety copy: ${safety}`)
  }
  fs.copyFileSync(backupPath, livePath)
  console.log(`[db:restore] OK — ${backupPath} -> ${livePath}`)
}

function restorePostgres(backupPath) {
  const url = String(process.env.DATABASE_URL || '').trim()
  if (!url) throw new Error('DATABASE_URL is not set')
  const result = spawnSync('pg_restore', ['--clean', '--if-exists', `--dbname=${url}`, backupPath], {
    stdio: ['ignore', 'inherit', 'pipe'],
    timeout: 30 * 60 * 1000,
  })
  if (result.error?.code === 'ENOENT') {
    throw new Error('pg_restore not found on PATH — install postgresql-client and re-run')
  }
  if (result.status !== 0) {
    throw new Error(`pg_restore exited ${result.status}: ${String(result.stderr || '').slice(0, 500)}`)
  }
  console.log(`[db:restore] OK — ${backupPath} -> DATABASE_URL target`)
}

const run = file.endsWith('.dump') ? Promise.resolve().then(() => restorePostgres(file)) : restoreSqlite(file)
run.then(() => process.exit(0)).catch((err) => {
  console.error(`[db:restore] FAILED: ${err?.message || err}`)
  process.exit(1)
})
