/**
 * Backup automation (epic slice 9): the runbook promised "restore from
 * backup" while no backup mechanism existed. These tests pin:
 *   • the ops.backupFreshness Sam check — never-run is a FILLABLE red,
 *     stale is red naming the age, fresh is green, an unreadable store
 *     degrades to skipped (never a comfortable green about recoverability)
 *   • the backup script end-to-end on SQLite — verified artifact + the
 *     mark-after-write stamp in system_kv + restore round-trip
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { getCheckById } from '../services/sam/samRegistry.js'
import {
  POSTGRES_JSON_BACKUP_FORMAT,
  runDatabaseBackup,
} from '../services/ops/databaseBackup.js'

function fakeDb(record) {
  return {
    prepare(sql) {
      return {
        get: async () => {
          if (/system_kv/.test(sql)) {
            return record === undefined ? undefined : { value: JSON.stringify(record) }
          }
          return undefined
        },
      }
    },
  }
}

describe('ops.backupFreshness', () => {
  const check = getCheckById('ops.backupFreshness')

  it('is registered', () => {
    expect(check).toBeTruthy()
  })

  it('reds with a fillable instruction when no backup has ever run', async () => {
    const res = await check.run({ db: fakeDb(undefined) })
    expect(res.ok).toBe(false)
    expect(res.summary).toMatch(/npm run db:backup/)
  })

  it('reds naming the age when the last backup is older than the bar', async () => {
    const old = new Date(Date.now() - 100 * 3_600_000).toISOString()
    const res = await check.run({ db: fakeDb({ at: old, path: '/mnt/data/backups/x.db', bytes: 1024, dialect: 'sqlite' }) })
    expect(res.ok).toBe(false)
    expect(res.summary).toMatch(/100h|9[0-9]h|1[0-9][0-9]h/)
  })

  it('greens on a fresh verified backup', async () => {
    const res = await check.run({ db: fakeDb({ at: new Date().toISOString(), path: '/tmp/y.db', bytes: 2048, dialect: 'sqlite' }) })
    expect(res.ok).toBe(true)
  })

  it('an unreadable system_kv degrades to skipped, never a green claim about recoverability', async () => {
    const broken = { prepare() { return { get: async () => { throw new Error('no such table') } } } }
    const res = await check.run({ db: broken })
    expect(res.skipped).toBe(true)
  })
})

describe('backup + restore scripts (SQLite end-to-end)', () => {
  it('produces a verified artifact, stamps system_kv, and the artifact restores', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-backup-'))
    const dbPath = path.join(dir, 'live.db')
    const backupDir = path.join(dir, 'backups')

    const seed = new Database(dbPath)
    seed.exec(`
      CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
      CREATE TABLE grants (id TEXT PRIMARY KEY, title TEXT);
      INSERT INTO grants VALUES ('g1', 'Roof Repair Grant');
    `)
    seed.close()

    const env = {
      ...process.env,
      SQLITE_DB_PATH: dbPath,
      BACKUP_DIR: backupDir,
      DB_PROVIDER: 'sqlite',
      DATABASE_URL: '',
    }
    const run = spawnSync(process.execPath, ['scripts/backup-db.mjs'], { env, encoding: 'utf8', timeout: 60_000 })
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)

    const artifacts = fs.readdirSync(backupDir).filter((f) => f.startsWith('grantflow-backup-'))
    expect(artifacts).toHaveLength(1)

    // The stamp landed in the LIVE db only after verification.
    const live = new Database(dbPath, { readonly: true })
    const stamp = JSON.parse(live.prepare(`SELECT value FROM system_kv WHERE key = 'backup_last_run'`).get().value)
    live.close()
    expect(stamp.dialect).toBe('sqlite')
    expect(stamp.bytes).toBeGreaterThan(0)

    // The artifact is a real, intact database carrying the data.
    const snap = new Database(path.join(backupDir, artifacts[0]), { readonly: true })
    expect(snap.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(snap.prepare('SELECT title FROM grants WHERE id = ?').get('g1').title).toBe('Roof Repair Grant')
    snap.close()

    // Restore round-trip: mutate live, restore, mutation gone.
    const mut = new Database(dbPath)
    mut.prepare(`UPDATE grants SET title = 'CLOBBERED' WHERE id = 'g1'`).run()
    mut.close()
    const restore = spawnSync(
      process.execPath,
      ['scripts/restore-db.mjs', path.join(backupDir, artifacts[0])],
      { env, encoding: 'utf8', timeout: 60_000 },
    )
    expect(restore.status, `${restore.stdout}\n${restore.stderr}`).toBe(0)
    const after = new Database(dbPath, { readonly: true })
    expect(after.prepare('SELECT title FROM grants WHERE id = ?').get('g1').title).toBe('Roof Repair Grant')
    after.close()

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('postgres backup fallback (no pg_dump on PATH)', () => {
  it('still records a real backup artifact + metadata via the live SQL connection', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-pg-backup-'))
    const priorEnv = {
      PATH: process.env.PATH,
      BACKUP_DIR: process.env.BACKUP_DIR,
      DATABASE_URL: process.env.DATABASE_URL,
    }
    const kv = new Map()
    const queryImpl = async (sql, params = []) => {
      if (/information_schema\.tables/.test(sql)) {
        return { rows: [{ table_name: 'grants' }, { table_name: 'system_kv' }] }
      }
      if (/information_schema\.columns/.test(sql)) {
        const t = params[0]
        if (t === 'grants') return { rows: [{ column_name: 'id' }, { column_name: 'title' }, { column_name: 'file_bytes' }] }
        if (t === 'system_kv') return { rows: [{ column_name: 'key' }, { column_name: 'value' }] }
      }
      if (/SELECT \* FROM public\."grants"/.test(sql)) {
        return { rows: [{ id: 'g1', title: 'Roof Repair Grant', file_bytes: Buffer.from('grant-bytes') }] }
      }
      if (/SELECT \* FROM public\."system_kv"/.test(sql)) {
        return { rows: [] }
      }
      if (/^(BEGIN|START TRANSACTION)\b/.test(sql) || /^COMMIT$/.test(sql) || /^ROLLBACK$/.test(sql)) {
        return { rows: [] }
      }
      throw new Error(`unexpected query: ${sql}`)
    }
    const db = {
      dialect: 'postgres',
      _pool: {
        async query(sql, params = []) { return queryImpl(sql, params) },
        async connect() {
          return {
            query: queryImpl,
            release() {},
          }
        },
      },
      prepare(sql) {
        return {
          async run(...args) {
            if (/UPDATE system_kv/.test(sql)) return { changes: 0 }
            if (/INSERT INTO system_kv/.test(sql)) {
              kv.set(args[0], args[1])
              return { changes: 1 }
            }
            throw new Error(`unexpected prepare().run sql: ${sql}`)
          },
        }
      },
    }

    try {
      process.env.BACKUP_DIR = dir
      process.env.DATABASE_URL = 'postgresql://localhost:5432/grantflow'
      process.env.PATH = ''
      const res = await runDatabaseBackup({ db })

      expect(res.ok).toBe(true)
      expect(res.path).toMatch(/\.json\.gz$/)
      expect(res.bytes).toBeGreaterThan(0)

      const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(res.path)).toString('utf8'))
      expect(payload.format).toBe(POSTGRES_JSON_BACKUP_FORMAT)
      expect(payload.tables.find((t) => t.name === 'grants')?.rows?.[0]?.file_bytes?.__bytea_base64).toBe(
        Buffer.from('grant-bytes').toString('base64'),
      )

      const stamp = JSON.parse(kv.get('backup_last_run'))
      expect(stamp.dialect).toBe('postgres')
      expect(stamp.path).toBe(res.path)
      expect(fs.statSync(res.path).mode & 0o777).toBe(0o600)
    } finally {
      if (priorEnv.PATH === undefined) delete process.env.PATH
      else process.env.PATH = priorEnv.PATH
      if (priorEnv.BACKUP_DIR === undefined) delete process.env.BACKUP_DIR
      else process.env.BACKUP_DIR = priorEnv.BACKUP_DIR
      if (priorEnv.DATABASE_URL === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = priorEnv.DATABASE_URL
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
