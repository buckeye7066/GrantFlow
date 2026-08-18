/**
 * Verified database backup (SQLite VACUUM INTO / Postgres pg_dump -Fc).
 *
 * Stamps system_kv `backup_last_run` only AFTER the artifact exists and
 * passes integrity_check (mark-after-write). Consumed by Sam
 * `ops.backupFreshness` and by nightly self-heal (`runSelfHealOnDemand`).
 *
 * CLI: `npm run db:backup` → scripts/backup-db.mjs
 * Restore: `npm run db:restore -- <file>` → scripts/restore-db.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const BACKUP_LAST_RUN_KEY = 'backup_last_run'

/**
 * In-memory SQLite (`:memory:`) cannot produce a durable backup artifact.
 * Nightly self-heal skips that case so unit tests using makeDb() do not fail
 * the db_backup step or write files into ./backups.
 */
export async function isDurableSqlite(db) {
  try {
    const stmt = db.prepare('PRAGMA database_list')
    const rows = typeof stmt.all === 'function'
      ? await stmt.all()
      : [await stmt.get()].filter(Boolean)
    const list = Array.isArray(rows) ? rows : []
    const main = list.find((r) => String(r?.name || '') === 'main') || list[0]
    const file = String(main?.file || '')
    return Boolean(file) && file !== ':memory:'
  } catch {
    return true
  }
}

function backupKeep() {
  return Math.max(1, Number(process.env.BACKUP_KEEP || 14) || 14)
}

export function resolveBackupDir() {
  const explicit = String(process.env.BACKUP_DIR || '').trim()
  if (explicit) return explicit
  try {
    if (fs.existsSync('/mnt/data') && fs.statSync('/mnt/data').isDirectory()) {
      return '/mnt/data/backups'
    }
  } catch { /* fall through */ }
  try {
    if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) {
      return '/data/backups'
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
  const keep = backupKeep()
  for (const { f } of files.slice(keep)) {
    fs.unlinkSync(path.join(dir, f))
    pruned.push(f)
  }
  return pruned
}

async function backupSqlite(db, dir) {
  const dest = path.join(dir, `grantflow-backup-${stamp()}.db`)
  const literal = dest.replace(/'/g, "''")
  await db.exec(`VACUUM INTO '${literal}'`)

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

/**
 * Take a verified backup and stamp `backup_last_run`. Never stamps on failure.
 *
 * @param {{ db: object }} args
 * @returns {Promise<{ ok: true, dialect: string, path: string, bytes: number, pruned: string[] }>}
 */
export async function runDatabaseBackup({ db } = {}) {
  if (!db?.prepare) throw new Error('runDatabaseBackup requires a db handle')
  const dialect = db?.dialect === 'postgres' ? 'postgres' : 'sqlite'
  const dir = resolveBackupDir()
  fs.mkdirSync(dir, { recursive: true })

  const dest = dialect === 'postgres' ? backupPostgres(dir) : await backupSqlite(db, dir)
  const bytes = fs.statSync(dest).size

  await kvSet(db, BACKUP_LAST_RUN_KEY, { at: new Date().toISOString(), path: dest, bytes, dialect })

  const pruned = pruneOld(dir)
  return { ok: true, dialect, path: dest, bytes, pruned }
}

export default { BACKUP_LAST_RUN_KEY, resolveBackupDir, runDatabaseBackup, isDurableSqlite }
