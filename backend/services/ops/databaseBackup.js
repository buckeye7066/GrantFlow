/**
 * Verified database backup (SQLite VACUUM INTO / Postgres pg_dump -Fc).
 *
 * Stamps system_kv `backup_last_run` only AFTER the artifact exists and
 * passes integrity_check (mark-after-write). Consumed by Sam
 * `ops.backupFreshness` and by nightly self-heal (`runSelfHealOnDemand`).
 *
 * SECURITY: backup artifacts are full database snapshots and therefore carry
 * the same sensitivity as the live database, including secrets/tokens stored
 * in DB tables. Every artifact this module writes is chmod'd to owner-only
 * read/write (`0600`) immediately after creation.
 * Full-fidelity parity with `pg_dump` is INTENTIONAL: the fallback JSON export
 * does not exclude "sensitive" tables, because a partial backup is not a
 * disaster-recovery backup. Protect BACKUP_DIR the same way you protect the DB.
 *
 * CLI: `npm run db:backup` → scripts/backup-db.mjs
 * Restore: `npm run db:restore -- <file>` → scripts/restore-db.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { createGzip, gunzipSync } from 'node:zlib'
import * as childProcess from 'node:child_process'

export const BACKUP_LAST_RUN_KEY = 'backup_last_run'
export const POSTGRES_JSON_BACKUP_FORMAT = 'grantflow-postgres-json-v1'
const POSTGRES_JSON_BACKUP_BATCH_ROWS = Math.max(100, Number(process.env.POSTGRES_JSON_BACKUP_BATCH_ROWS || 1000) || 1000)

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

function withOwnerOnlyUmask(fn) {
  const prior = process.umask(0o077)
  try {
    return fn()
  } finally {
    process.umask(prior)
  }
}

function createOwnerOnlyWriteStream(dest) {
  let stream = null
  withOwnerOnlyUmask(() => {
    stream = fs.createWriteStream(dest, { mode: 0o600 })
  })
  return stream
}

async function backupSqlite(db, dir) {
  const dest = path.join(dir, `grantflow-backup-${stamp()}.db`)
  const literal = dest.replace(/'/g, "''")
  await withOwnerOnlyUmask(() => db.exec(`VACUUM INTO '${literal}'`))

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
  if (!db?._pool?.query || typeof db._pool.connect !== 'function') {
    throw new Error('pg_dump not found and the live db handle does not expose a postgres pool for JSON fallback backup')
  }
  const dest = path.join(dir, `grantflow-backup-${stamp()}.json.gz`)
  const client = await db._pool.connect()
  let out = null
  let gzip = null
  let finished = null
  try {
    out = createOwnerOnlyWriteStream(dest)
    gzip = createGzip()
    gzip.pipe(out)
    finished = new Promise((resolve, reject) => {
      out.once('finish', resolve)
      out.once('error', reject)
      gzip.once('error', reject)
    })
    await client.query('START TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const tablesRes = await client.query(`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type = 'BASE TABLE'
       ORDER BY table_name
    `)
    gzip.write(`{"format":"${POSTGRES_JSON_BACKUP_FORMAT}","created_at":${JSON.stringify(new Date().toISOString())},"tables":[`)
    let firstTable = true
    for (const row of tablesRes.rows || []) {
      const tableName = String(row?.table_name || '').trim()
      if (!tableName) continue
      const columnsRes = await client.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = $1
          ORDER BY ordinal_position`,
        [tableName],
      )
      const columns = (columnsRes.rows || []).map((col) => String(col?.column_name || '')).filter(Boolean)
      gzip.write(
        `${firstTable ? '' : ','}{"name":${JSON.stringify(tableName)},"columns":${JSON.stringify(columns)},"rows":[`,
      )
      firstTable = false
      let firstRow = true
      let offset = 0
      for (;;) {
        // Full backups cannot assume every table has a portable logical key.
        // `ctid` gives a deterministic page order within this repeatable-read
        // snapshot without inventing per-table ordering rules.
        const dataRes = await client.query(
          `SELECT * FROM public.${quotePgIdentifier(tableName)} ORDER BY ctid OFFSET $1 LIMIT $2`,
          [offset, POSTGRES_JSON_BACKUP_BATCH_ROWS],
        )
        const rows = dataRes.rows || []
        if (!rows.length) break
        for (const record of rows) {
          gzip.write(`${firstRow ? '' : ','}${JSON.stringify(encodeBackupValue(record))}`)
          firstRow = false
        }
        offset += rows.length
        if (rows.length < POSTGRES_JSON_BACKUP_BATCH_ROWS) break
      }
      gzip.write(']}')
    }
    gzip.end(']}')
    await finished
    verifyJsonBackup(dest)
    await client.query('COMMIT')
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* ignore rollback failure */ }
    gzip?.destroy()
    out?.destroy()
    try { fs.unlinkSync(dest) } catch { /* ignore cleanup failure */ }
    throw error
  } finally {
    client.release()
  }
  return dest
}

async function backupPostgres(db, dir) {
  const url = String(process.env.DATABASE_URL || '').trim()
  if (!url) throw new Error('postgres dialect but DATABASE_URL is not set')
  const dest = path.join(dir, `grantflow-backup-${stamp()}.dump`)
  const result = withOwnerOnlyUmask(() => childProcess.spawnSync('pg_dump', ['--format=custom', `--file=${dest}`, url], {
    stdio: ['ignore', 'inherit', 'pipe'],
    timeout: 15 * 60 * 1000,
  }))
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
