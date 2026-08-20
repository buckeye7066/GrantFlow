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
import { gzipSync, gunzipSync } from 'node:zlib'
import * as childProcess from 'node:child_process'

export const BACKUP_LAST_RUN_KEY = 'backup_last_run'
export const POSTGRES_JSON_BACKUP_FORMAT = 'grantflow-postgres-json-v1'

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

function quotePgIdentifier(id) {
  return `"${String(id || '').replace(/"/g, '""')}"`
}

function encodeBackupValue(value) {
  if (Buffer.isBuffer(value)) {
    return { __bytea_base64: value.toString('base64') }
  }
  if (Array.isArray(value)) return value.map((item) => encodeBackupValue(item))
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, encodeBackupValue(val)]),
    )
  }
  return value
}

function verifyJsonBackup(dest) {
  const raw = fs.readFileSync(dest)
  const parsed = JSON.parse(gunzipSync(raw).toString('utf8'))
  if (parsed?.format !== POSTGRES_JSON_BACKUP_FORMAT) {
    throw new Error('postgres JSON backup verification failed — unexpected format marker')
  }
  if (!Array.isArray(parsed?.tables)) {
    throw new Error('postgres JSON backup verification failed — tables payload missing')
  }
}

async function backupPostgresViaSql(db, dir) {
  if (!db?._pool?.query) {
    throw new Error('pg_dump not found and the live db handle does not expose a postgres pool for JSON fallback backup')
  }
  const dest = path.join(dir, `grantflow-backup-${stamp()}.json.gz`)
  const tablesRes = await db._pool.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
     ORDER BY table_name
  `)
  const tables = []
  for (const row of tablesRes.rows || []) {
    const tableName = String(row?.table_name || '').trim()
    if (!tableName) continue
    const columnsRes = await db._pool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
        ORDER BY ordinal_position`,
      [tableName],
    )
    const dataRes = await db._pool.query(`SELECT * FROM public.${quotePgIdentifier(tableName)}`)
    tables.push({
      name: tableName,
      columns: (columnsRes.rows || []).map((col) => String(col?.column_name || '')).filter(Boolean),
      rows: (dataRes.rows || []).map((record) => encodeBackupValue(record)),
    })
  }
  fs.writeFileSync(
    dest,
    gzipSync(Buffer.from(JSON.stringify({
      format: POSTGRES_JSON_BACKUP_FORMAT,
      created_at: new Date().toISOString(),
      tables,
    }))),
  )
  verifyJsonBackup(dest)
  return dest
}

async function backupPostgres(db, dir) {
  const url = String(process.env.DATABASE_URL || '').trim()
  if (!url) throw new Error('postgres dialect but DATABASE_URL is not set')
  const dest = path.join(dir, `grantflow-backup-${stamp()}.dump`)
  const result = childProcess.spawnSync('pg_dump', ['--format=custom', `--file=${dest}`, url], {
    stdio: ['ignore', 'inherit', 'pipe'],
    timeout: 15 * 60 * 1000,
  })
  if (result.error?.code === 'ENOENT') {
    return backupPostgresViaSql(db, dir)
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

  const dest = dialect === 'postgres' ? await backupPostgres(db, dir) : await backupSqlite(db, dir)
  const bytes = fs.statSync(dest).size

  await kvSet(db, BACKUP_LAST_RUN_KEY, { at: new Date().toISOString(), path: dest, bytes, dialect })

  const pruned = pruneOld(dir)
  return { ok: true, dialect, path: dest, bytes, pruned }
}

export default { BACKUP_LAST_RUN_KEY, resolveBackupDir, runDatabaseBackup, isDurableSqlite }
