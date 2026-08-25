import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import { hardDeleteAmyProfile } from '../services/amy/amyProfileStore.js'
import { ORIGIN_CREATED_BY } from '../services/amy/amyConstants.js'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, created_by TEXT NOT NULL);
    CREATE TABLE profile_sections (id INTEGER PRIMARY KEY, profile_id TEXT NOT NULL);
    CREATE TABLE surprise_profile_cache (id INTEGER PRIMARY KEY, profile_id TEXT NOT NULL);
  `)
  return db
}

function makePostgresAbortSimulator(sqlite, catalogTables) {
  let transactionAborted = false

  const abortedError = () => Object.assign(
    new Error('current transaction is aborted, commands ignored until end of transaction block'),
    { code: '25P02' },
  )

  const tx = {
    dialect: 'postgres',
    prepare(sql) {
      if (/information_schema\.columns/i.test(sql)) {
        return {
          all: async () => catalogTables.map((table_name) => ({ table_name })),
        }
      }

      return {
        run: async (...args) => {
          if (transactionAborted) throw abortedError()
          try {
            return sqlite.prepare(sql).run(...args)
          } catch (err) {
            // Model PostgreSQL's behavior, which differs from SQLite: after a
            // statement error, only rollback to a savepoint (or full rollback)
            // can make the transaction usable again.
            transactionAborted = true
            throw err
          }
        },
      }
    },
    async exec(sql) {
      if (/^ROLLBACK TO SAVEPOINT\b/i.test(sql)) {
        sqlite.exec(sql)
        transactionAborted = false
        return
      }
      if (transactionAborted) throw abortedError()
      sqlite.exec(sql)
    },
  }

  return {
    dialect: 'postgres',
    async withTransaction(work) {
      sqlite.exec('BEGIN')
      transactionAborted = false
      try {
        const result = await work(tx)
        if (transactionAborted) throw abortedError()
        sqlite.exec('COMMIT')
        return result
      } catch (err) {
        try { sqlite.exec('ROLLBACK') } catch { /* preserve original failure */ }
        transactionAborted = false
        throw err
      }
    },
  }
}

describe('Amy synthetic profile deletion totality', () => {
  it('discovers and deletes profile-owned rows added after the fixed registry', async () => {
    const db = makeDb()
    try {
      db.prepare('INSERT INTO profiles (id, created_by) VALUES (?, ?)').run('amy-1', ORIGIN_CREATED_BY)
      db.prepare('INSERT INTO profile_sections (profile_id) VALUES (?)').run('amy-1')
      db.prepare('INSERT INTO surprise_profile_cache (profile_id) VALUES (?)').run('amy-1')

      const result = await hardDeleteAmyProfile(db, 'amy-1')
      expect(result.dependent_rows).toBe(2)
      expect(db.prepare('SELECT COUNT(*) AS n FROM surprise_profile_cache').get().n).toBe(0)
      expect(db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n).toBe(0)
    } finally {
      db.close()
    }
  })

  it('finishes SQLite cleanup synchronously before another microtask can write on the shared connection', async () => {
    const db = makeDb()
    try {
      db.prepare('INSERT INTO profiles (id, created_by) VALUES (?, ?)').run('amy-sync', ORIGIN_CREATED_BY)
      db.prepare('INSERT INTO profile_sections (profile_id) VALUES (?)').run('amy-sync')
      let interleaved = false
      queueMicrotask(() => { interleaved = true })

      const cleanup = hardDeleteAmyProfile(db, 'amy-sync')
      expect(interleaved).toBe(false)
      expect(db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n).toBe(0)
      await cleanup
      expect(interleaved).toBe(true)
    } finally {
      db.close()
    }
  })

  it('rolls back every child deletion when any discovered relation refuses cleanup', async () => {
    const db = makeDb()
    try {
      db.prepare('INSERT INTO profiles (id, created_by) VALUES (?, ?)').run('amy-2', ORIGIN_CREATED_BY)
      db.prepare('INSERT INTO profile_sections (profile_id) VALUES (?)').run('amy-2')
      db.prepare('INSERT INTO surprise_profile_cache (profile_id) VALUES (?)').run('amy-2')
      db.exec(`
        CREATE TRIGGER refuse_surprise_delete
        BEFORE DELETE ON surprise_profile_cache
        BEGIN
          SELECT RAISE(ABORT, 'simulated dependent cleanup failure');
        END;
      `)

      await expect(hardDeleteAmyProfile(db, 'amy-2')).rejects.toThrow(/surprise_profile_cache/)
      expect(db.prepare('SELECT COUNT(*) AS n FROM profile_sections').get().n).toBe(1)
      expect(db.prepare('SELECT COUNT(*) AS n FROM surprise_profile_cache').get().n).toBe(1)
      expect(db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n).toBe(1)
    } finally {
      db.close()
    }
  })

  it('deletes newly discovered child relations before their registered parent table', async () => {
    const db = makeDb()
    try {
      db.exec(`
        CREATE TABLE grants (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id)
        );
        CREATE TABLE new_application_artifacts (
          id INTEGER PRIMARY KEY,
          profile_id TEXT NOT NULL,
          grant_id TEXT NOT NULL REFERENCES grants(id)
        );
      `)
      db.prepare('INSERT INTO profiles (id, created_by) VALUES (?, ?)').run('amy-3', ORIGIN_CREATED_BY)
      db.prepare('INSERT INTO grants (id, profile_id) VALUES (?, ?)').run('grant-3', 'amy-3')
      db.prepare('INSERT INTO new_application_artifacts (profile_id, grant_id) VALUES (?, ?)').run('amy-3', 'grant-3')

      await hardDeleteAmyProfile(db, 'amy-3')
      expect(db.prepare('SELECT COUNT(*) AS n FROM new_application_artifacts').get().n).toBe(0)
      expect(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n).toBe(0)
      expect(db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n).toBe(0)
    } finally {
      db.close()
    }
  })

  it('does not probe absent historical tables after PostgreSQL catalog discovery', async () => {
    const sqlite = makeDb()
    try {
      sqlite.prepare('INSERT INTO profiles (id, created_by) VALUES (?, ?)').run('amy-pg-1', ORIGIN_CREATED_BY)
      sqlite.prepare('INSERT INTO profile_sections (profile_id) VALUES (?)').run('amy-pg-1')
      sqlite.prepare('INSERT INTO surprise_profile_cache (profile_id) VALUES (?)').run('amy-pg-1')
      const db = makePostgresAbortSimulator(sqlite, ['profile_sections', 'surprise_profile_cache'])

      const result = await hardDeleteAmyProfile(db, 'amy-pg-1')
      expect(result.dependent_rows).toBe(2)
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM profiles').get().n).toBe(0)
    } finally {
      sqlite.close()
    }
  })

  it('uses PostgreSQL savepoints to recover and retry a parent-first dependency order', async () => {
    const sqlite = makeDb()
    try {
      sqlite.exec(`
        CREATE TABLE parent_profile_cache (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id)
        );
        CREATE TABLE child_profile_cache (
          id INTEGER PRIMARY KEY,
          profile_id TEXT NOT NULL,
          parent_id TEXT NOT NULL REFERENCES parent_profile_cache(id)
        );
      `)
      sqlite.prepare('INSERT INTO profiles (id, created_by) VALUES (?, ?)').run('amy-pg-2', ORIGIN_CREATED_BY)
      sqlite.prepare('INSERT INTO profile_sections (profile_id) VALUES (?)').run('amy-pg-2')
      sqlite.prepare('INSERT INTO parent_profile_cache (id, profile_id) VALUES (?, ?)').run('parent-2', 'amy-pg-2')
      sqlite.prepare('INSERT INTO child_profile_cache (profile_id, parent_id) VALUES (?, ?)').run('amy-pg-2', 'parent-2')
      const db = makePostgresAbortSimulator(sqlite, [
        'parent_profile_cache',
        'child_profile_cache',
        'profile_sections',
      ])

      const result = await hardDeleteAmyProfile(db, 'amy-pg-2')
      expect(result.dependent_rows).toBe(3)
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM child_profile_cache').get().n).toBe(0)
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM parent_profile_cache').get().n).toBe(0)
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM profiles').get().n).toBe(0)
    } finally {
      sqlite.close()
    }
  })
})
