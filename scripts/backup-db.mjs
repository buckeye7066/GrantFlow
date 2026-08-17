#!/usr/bin/env node
/**
 * `npm run db:backup` — REAL database backup (epic slice 9).
 *
 * The runbooks said "restore from backup" while no backup mechanism existed
 * anywhere in the repo. This script is the mechanism:
 *
 *   SQLite   → `VACUUM INTO` an online-consistent snapshot copy, then
 *              PRAGMA integrity_check on the snapshot (a backup that cannot
 *              be opened is not a backup).
 *   Postgres → `pg_dump -Fc` (custom format, pg_restore-able) using the same
 *              DATABASE_URL the backend uses. A missing pg_dump binary is a
 *              loud failure naming the install step, never a silent no-op.
 *
 * Every successful run stamps system_kv `backup_last_run` with
 * {at, path, bytes, dialect} so the Sam check `ops.backupFreshness` can
 * assert freshness instead of trusting documentation. Retention: keeps the
 * newest BACKUP_KEEP (default 14) files in BACKUP_DIR, pruning older ones.
 *
 * Restore counterpart: scripts/restore-db.mjs <backup-file>.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { getDb } from '../backend/db/index.js'

const BACKUP_KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 14))

function resolveBackupDir() {
  const explicit = String(process.env.BACKUP_DIR || '').trim()
  if (explicit) return explicit
  // Railway persistent volume when present (same preference as the SQLite DB
  // itself — a backup on the ephemeral layer dies with the deploy).
  try {
    if (fs.existsSync('/mnt/data') && fs.statSync('/mnt/data').isDirectory()) {
      return '/mnt/data/backups'
    }
  } catch { /* fall through */ }
  return path.join(process.cwd(), 'backups')
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function kvSet(db, key, value) {
  const now = new Date().toISOString()
  const json = JSON.stringify(value)
  const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(json, now, key)
  if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, json, now)
  }
}

function pruneOld(dir) {
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith('grantflow-backup-'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  const pruned = []
  for (const { f } of files.slice(BACKUP_KEEP)) {
    fs.unlinkSync(path.join(dir, f))
    pruned.push(f)
  }
  return pruned
}

async function backupSqlite(db, dir) {
  const dest = path.join(dir, `grantflow-backup-${stamp()}.db`)
  // VACUUM INTO produces a consistent snapshot even with concurrent readers.
  // The path is script-controlled (never user input); escape single quotes
  // defensively anyway.
  const literal = dest.replace(/'/g, "''")
  await db.exec(`VACUUM INTO '${literal}'`)

  // Verify the snapshot actually opens and is intact — direct sqlite open.
  const { default: Database } = await import('better-sqlite3')
  const check = new Database(dest, { readonly: true })
  const verdict = check.pragma('integrity_check', { simple: true })
  check.close()
  if (String(verdict).toLowerCase() !== 'ok') {
    fs.unlinkSync(dest)
    throw new Error(`backup failed integrity_check (${verdict}) — snapshot deleted, nothing recorded`)
  }
  return dest
}

function backupPostgres(dir) {
  const url = String(process.env.DATABASE_URL || '').trim()
  if (!url) throw new Error('postgres dialect but DATABASE_URL is not set')
  const dest = path.join(dir, `grantflow-backup-${stamp()}.dump`)
  const result = spawnSync('pg_dump', ['--format=custom', `--file=${dest}`, url], {
    stdio: ['ignore', 'inherit', 'pipe'],
    timeout: 15 * 60 * 1000,
  })
  if (result.error?.code === 'ENOENT') {
    throw new Error('pg_dump not found on PATH — install postgresql-client (apt) / postgresql (winget/brew) and re-run')
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').slice(0, 500)
    throw new Error(`pg_dump exited ${result.status}: ${stderr}`)
  }
  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
    throw new Error('pg_dump reported success but produced no bytes — nothing recorded')
  }
  return dest
}

async function main() {
  const db = getDb()
  const dialect = db?.dialect === 'postgres' ? 'postgres' : 'sqlite'
  const dir = resolveBackupDir()
  fs.mkdirSync(dir, { recursive: true })

  const dest = dialect === 'postgres' ? backupPostgres(dir) : await backupSqlite(db, dir)
  const bytes = fs.statSync(dest).size

  // The stamp is written only AFTER the verified artifact exists (the
  // mark-after-write rule): a failed backup leaves the previous stamp intact
  // so ops.backupFreshness goes red on staleness instead of lying green.
  await kvSet(db, 'backup_last_run', { at: new Date().toISOString(), path: dest, bytes, dialect })

  const pruned = pruneOld(dir)
  console.log(`[db:backup] OK dialect=${dialect} -> ${dest} (${(bytes / 1024 / 1024).toFixed(1)} MB)${pruned.length ? `, pruned ${pruned.length} old backup(s)` : ''}`)
  await db.close?.()
  process.exit(0)
}

main().catch((err) => {
  console.error(`[db:backup] FAILED: ${err?.message || err}`)
  process.exit(1)
})
