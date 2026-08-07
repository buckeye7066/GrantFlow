/**
 * Guard tests for the production 500 on POST /api/admin/profiles/deduplicate
 * (owner-reported 2026-08-06; Railway log showed
 * `current transaction is aborted, commands ignored until end of transaction block`
 * raised from profileDedupeService.js at the top of the loser loop).
 *
 * Two dialect-drift facts made that reachable, and neither is observable under a
 * plain SQLite test:
 *
 *  1. `audit_logs.id` is `TEXT PRIMARY KEY` with NO default on both dialects.
 *     SQLite permits NULL in a non-INTEGER PRIMARY KEY column, so the merge's
 *     `INSERT INTO audit_logs (category, action, …)` — which omitted `id` —
 *     silently inserted a NULL-keyed row locally and threw
 *     `null value in column "id" … violates not-null constraint` on Postgres.
 *  2. On Postgres, ANY failed statement aborts the WHOLE transaction. The merge
 *     wrapped its optional writes in `try { … } catch {}`, so that failure was
 *     swallowed and the *next* loser's ordinary SELECT is what blew up.
 *
 * These tests run the real mergeProfiles against a SQLite-backed database that
 * emulates the two Postgres behaviours that matter: a NOT NULL primary key and
 * abort-the-transaction-on-error (cleared only by ROLLBACK / ROLLBACK TO
 * SAVEPOINT). Both fail on the pre-fix code.
 */

import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

import { mergeProfiles } from '../services/profileDedupeService.js'

const ABORTED_MESSAGE = 'current transaction is aborted, commands ignored until end of transaction block'

const SCHEMA = `
  CREATE TABLE profiles (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    user_id TEXT,
    organization_id TEXT,
    status TEXT DEFAULT 'active',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX ux_profiles_user_id ON profiles(user_id) WHERE user_id IS NOT NULL;

  CREATE TABLE profile_sections (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    profile_id TEXT NOT NULL,
    section_key TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_by TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE profile_emails (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    email TEXT NOT NULL,
    added_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE profile_documents (
    profile_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    PRIMARY KEY (profile_id, document_id)
  );

  -- Mirrors prod exactly: TEXT primary key, NOT NULL, no default.
  CREATE TABLE audit_logs (
    id TEXT PRIMARY KEY NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    category TEXT NOT NULL,
    action TEXT NOT NULL,
    severity TEXT DEFAULT 'info',
    user_id TEXT,
    profile_id TEXT,
    resource_type TEXT,
    resource_id TEXT,
    details TEXT
  );
`

/**
 * A SQLite-backed db handle that behaves like the Postgres shim
 * (`backend/db/index.js` PostgresDb/PostgresTx) in the two ways this bug needed:
 * catalog probes answer Postgres-style, and a failed statement poisons the
 * transaction until it is rolled back.
 */
function makePostgresSemanticsDb({ profileEmailUniqueIndex = true } = {}) {
  const sqlite = new Database(':memory:')
  sqlite.exec(SCHEMA)
  if (profileEmailUniqueIndex) {
    sqlite.exec('CREATE UNIQUE INDEX ux_profile_emails_profile_email ON profile_emails(profile_id, email)')
  }

  const state = { inTransaction: false, aborted: false }

  const tableNames = () =>
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)

  // Postgres answers these catalog probes successfully; SQLite would throw and
  // send the service down its SQLite fallback path (and, in this harness, would
  // spuriously mark the transaction aborted). Answer them like Postgres does.
  function interceptCatalog(sql, values) {
    if (/to_regclass/i.test(sql)) {
      const name = String(values[0] ?? '')
      return { rows: [{ reg: tableNames().includes(name) ? name : null }] }
    }
    if (/information_schema\.columns/i.test(sql)) {
      const [table, column] = values.map((v) => String(v ?? ''))
      if (!tableNames().includes(table)) return { rows: [] }
      const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)
      return { rows: cols.includes(column) ? [{ '?column?': 1 }] : [] }
    }
    return null
  }

  function execute(sql, values) {
    const text = String(sql).trim()
    if (state.aborted && !/^(ROLLBACK|RELEASE)/i.test(text)) {
      throw new Error(ABORTED_MESSAGE)
    }

    const intercepted = interceptCatalog(text, values)
    if (intercepted) return intercepted

    try {
      const stmt = sqlite.prepare(text)
      if (stmt.reader) return { rows: stmt.all(...values), changes: 0 }
      const info = stmt.run(...values)
      return { rows: [], changes: info.changes }
    } catch (error) {
      if (state.inTransaction) state.aborted = true
      throw error
    }
  }

  const makeHandle = () => ({
    dialect: 'postgres',
    prepare(sql) {
      return {
        get: async (...args) => execute(sql, args).rows[0],
        all: async (...args) => execute(sql, args).rows,
        run: async (...args) => {
          const res = execute(sql, args)
          return { changes: res.changes ?? 0, lastInsertRowid: null }
        },
      }
    },
    async exec(sql) {
      const text = String(sql).trim()
      if (/^ROLLBACK TO SAVEPOINT/i.test(text)) {
        sqlite.exec(text)
        state.aborted = false
        return
      }
      if (state.aborted && !/^(ROLLBACK|RELEASE)/i.test(text)) {
        throw new Error(ABORTED_MESSAGE)
      }
      sqlite.exec(text)
    },
  })

  const handle = makeHandle()

  return {
    ...handle,
    _sqlite: sqlite,
    async withTransaction(fn) {
      sqlite.exec('BEGIN')
      state.inTransaction = true
      state.aborted = false
      try {
        const result = await fn(makeHandle())
        sqlite.exec('COMMIT')
        return result
      } catch (error) {
        try { sqlite.exec('ROLLBACK') } catch { /* ignore */ }
        throw error
      } finally {
        state.inTransaction = false
        state.aborted = false
      }
    },
    close() { sqlite.close() },
  }
}

function seedGroup(db) {
  const sqlite = db._sqlite
  sqlite.prepare('INSERT INTO profiles (id, display_name, user_id) VALUES (?, ?, ?)').run('winner', 'Jane Doe', 'user-1')
  sqlite.prepare('INSERT INTO profiles (id, display_name, user_id) VALUES (?, ?, ?)').run('loser-a', 'Jane Doe', null)
  sqlite.prepare('INSERT INTO profiles (id, display_name, user_id) VALUES (?, ?, ?)').run('loser-b', 'Jane Doe', null)
  sqlite.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run('loser-a', 'basic_information', JSON.stringify({ city: 'Columbus' }))
  sqlite.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run('loser-b', 'narrative', JSON.stringify({ summary: 'hello' }))
  sqlite.prepare('INSERT INTO profile_emails (id, profile_id, email) VALUES (?, ?, ?)')
    .run('pe-1', 'loser-a', 'jane@example.org')
}

let openDb = null
afterEach(() => {
  if (openDb) { openDb.close(); openDb = null }
})

describe('mergeProfiles under Postgres transaction semantics', () => {
  it('merges a multi-loser group without aborting the transaction', async () => {
    const db = makePostgresSemanticsDb()
    openDb = db
    seedGroup(db)

    const result = await mergeProfiles(db, {
      winnerId: 'winner',
      loserIds: ['loser-a', 'loser-b'],
      dryRun: false,
      actorUserId: 'admin-user',
    })

    expect(result.merged_loser_ids).toEqual(['loser-a', 'loser-b'])

    const survivors = db._sqlite.prepare("SELECT id FROM profiles WHERE status IS NOT 'deleted' ORDER BY id").all()
    expect(survivors.map((r) => r.id)).toEqual(['winner'])
  })

  it('writes audit rows with a non-null primary key (audit_logs.id has no default)', async () => {
    const db = makePostgresSemanticsDb()
    openDb = db
    seedGroup(db)

    await mergeProfiles(db, {
      winnerId: 'winner',
      loserIds: ['loser-a', 'loser-b'],
      dryRun: false,
      actorUserId: 'admin-user',
    })

    const rows = db._sqlite
      .prepare("SELECT id, resource_id FROM audit_logs WHERE action = 'profile_merge' ORDER BY resource_id")
      .all()
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.resource_id)).toEqual(['loser-a', 'loser-b'])
    for (const row of rows) {
      expect(typeof row.id).toBe('string')
      expect(row.id.length).toBeGreaterThan(0)
    }
  })

  it('survives a failing best-effort block (savepoint isolates it from the outer transaction)', async () => {
    // No ux_profile_emails_profile_email index → the Postgres-branch
    // `ON CONFLICT (profile_id, email) DO NOTHING` has no matching constraint
    // and fails, exactly as an out-of-sync prod schema would.
    const db = makePostgresSemanticsDb({ profileEmailUniqueIndex: false })
    openDb = db
    seedGroup(db)

    const result = await mergeProfiles(db, {
      winnerId: 'winner',
      loserIds: ['loser-a', 'loser-b'],
      dryRun: false,
      actorUserId: 'admin-user',
    })

    const emailChange = result.changes.find((c) => c?.type === 'profile_emails.merge' && c?.from === 'loser-a')
    expect(emailChange?.skipped).toBe(true)

    // The merge itself still completed — the swallowed failure did not poison
    // the transaction for the statements that follow it.
    const survivors = db._sqlite.prepare("SELECT id FROM profiles WHERE status IS NOT 'deleted' ORDER BY id").all()
    expect(survivors.map((r) => r.id)).toEqual(['winner'])
  })
})
