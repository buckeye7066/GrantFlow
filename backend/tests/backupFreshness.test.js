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
import { spawnSync } from 'node:child_process'
import { getCheckById } from '../services/sam/samRegistry.js'

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
