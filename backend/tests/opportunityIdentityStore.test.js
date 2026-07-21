/**
 * Phase 2.1 web-lane de-contamination — opportunity identity schema + accessors.
 *
 * ADDITIVE, default-off, ZERO behavior change. These tests pin that:
 *   (a) an alias round-trips (insert → get) and touch bumps last_seen_at ONLY;
 *   (b) upsertOpenConflict is idempotent per (scheme, identity_key): a second
 *       observation lands on the SAME row id with updated evidence — never a
 *       second open row (the partial unique index is the DDL backstop) — while
 *       a RESOLVED conflict frees the slot for a genuinely NEW open one;
 *   (c) resolveConflict refuses 'open' (and any unknown status);
 *   (d) withIdentityTxn dispatches by dialect (pg advisory lock inside the txn
 *       vs SQLite BEGIN IMMEDIATE) and, on a unique-constraint violation from
 *       a lost two-writer race, retries the callback exactly ONCE so the
 *       re-read sees the winner;
 *   (e) the migration twins exist, apply on a fresh DB, and are idempotent;
 *       schema.sql (fresh-install bootstrap) creates the same tables; and
 *   (f) NOTHING in the live code path imports the accessor yet (wired in a
 *       later sub-PR).
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import {
  getAlias,
  insertAlias,
  touchAlias,
  upsertOpenConflict,
  resolveConflict,
  withIdentityTxn,
  isUniqueViolation,
  CONFLICT_STATUSES,
  RESOLVED_CONFLICT_STATUSES,
} from '../services/opportunityIdentityStore.js'

// Located by SUFFIX, not number: another session may renumber the migration
// files; the number lives only in the filename, never inside the SQL.
function findMigrationBySuffix(dir, suffix) {
  const matches = fs.readdirSync(dir).filter((f) => f.endsWith(suffix))
  if (matches.length !== 1) {
    throw new Error(`expected exactly one *${suffix} in ${dir}, found: ${matches.join(', ') || '(none)'}`)
  }
  return path.join(dir, matches[0])
}

const sqliteMigrationsDir = path.join(process.cwd(), 'backend/db/migrations')
const pgMigrationsDir = path.join(process.cwd(), 'backend/db/postgres/migrations')
const schemaSqlPath = path.join(process.cwd(), 'backend/db/schema.sql')
const sqlitePath = findMigrationBySuffix(sqliteMigrationsDir, '_opportunity_identity_tables.sql')
const pgPath = findMigrationBySuffix(pgMigrationsDir, '_opportunity_identity_tables.sql')

// A DB whose identity tables were created by applying the ACTUAL migration
// file, so the accessors are exercised against the real shipped schema.
function makeMigratedDb() {
  const raw = new Database(':memory:')
  raw.exec(fs.readFileSync(sqlitePath, 'utf8'))
  raw.dialect = 'sqlite'
  return raw
}

const ALIAS = Object.freeze({
  scheme: 'normalized_url',
  identityKey: 'https://example.org/grant-a',
  opportunityId: 'opp-1',
})

describe('alias accessors', () => {
  it('insertAlias then getAlias round-trips (first/last_seen set)', async () => {
    const db = makeMigratedDb()
    const inserted = await insertAlias(db, ALIAS)
    expect(inserted).toMatchObject({
      scheme: ALIAS.scheme,
      identity_key: ALIAS.identityKey,
      opportunity_id: ALIAS.opportunityId,
    })
    expect(inserted.first_seen_at).toBeTruthy()
    expect(inserted.last_seen_at).toBeTruthy()
    expect(await getAlias(db, ALIAS.scheme, ALIAS.identityKey)).toEqual(inserted)
  })

  it('getAlias returns null for an unclaimed key (and for a different scheme)', async () => {
    const db = makeMigratedDb()
    expect(await getAlias(db, ALIAS.scheme, ALIAS.identityKey)).toBeNull()
    await insertAlias(db, ALIAS)
    expect(await getAlias(db, 'external_id', ALIAS.identityKey)).toBeNull()
  })

  it('touchAlias updates last_seen_at ONLY (first_seen_at + opportunity_id untouched)', async () => {
    const db = makeMigratedDb()
    await insertAlias(db, ALIAS)
    // Backdate both timestamps so a same-second CURRENT_TIMESTAMP is still a
    // detectable change on last_seen_at and a detectable NON-change on first.
    db.prepare(
      `UPDATE opportunity_identity_aliases
          SET first_seen_at = '2000-01-01 00:00:00', last_seen_at = '2000-01-01 00:00:00'`,
    ).run()
    expect(await touchAlias(db, ALIAS.scheme, ALIAS.identityKey)).toBe(true)
    const row = await getAlias(db, ALIAS.scheme, ALIAS.identityKey)
    expect(row.first_seen_at).toBe('2000-01-01 00:00:00')
    expect(row.last_seen_at).not.toBe('2000-01-01 00:00:00')
    expect(row.opportunity_id).toBe(ALIAS.opportunityId)
  })

  it('touchAlias on an unclaimed key updates nothing (returns false)', async () => {
    const db = makeMigratedDb()
    expect(await touchAlias(db, ALIAS.scheme, ALIAS.identityKey)).toBe(false)
  })

  it('the UNIQUE(scheme, identity_key) constraint rejects a second claim (DDL backstop)', async () => {
    const db = makeMigratedDb()
    await insertAlias(db, ALIAS)
    let caught = null
    try {
      await insertAlias(db, { ...ALIAS, opportunityId: 'opp-2' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeTruthy()
    expect(isUniqueViolation(caught)).toBe(true)
    // The winner's row is untouched.
    expect((await getAlias(db, ALIAS.scheme, ALIAS.identityKey)).opportunity_id).toBe('opp-1')
  })
})

describe('open-conflict upsert idempotency', () => {
  const CONFLICT = Object.freeze({
    scheme: 'normalized_url',
    identityKey: 'https://example.org/grant-a',
    aId: 'opp-1',
    bId: 'opp-2',
  })

  it('a second observation lands on the SAME row id with updated evidence — never a second open row', async () => {
    const db = makeMigratedDb()
    const first = await upsertOpenConflict(db, { ...CONFLICT, evidence: { reason: 'url_clash' } })
    expect(first.status).toBe('open')
    expect(first.evidence).toBe(JSON.stringify({ reason: 'url_clash' }))

    const second = await upsertOpenConflict(db, { ...CONFLICT, evidence: { reason: 'seen_again' } })
    expect(second.id).toBe(first.id)
    expect(second.evidence).toBe(JSON.stringify({ reason: 'seen_again' }))
    expect(second.opportunity_id_a).toBe('opp-1')
    expect(second.opportunity_id_b).toBe('opp-2')
    expect(second.first_seen_at).toBe(first.first_seen_at)
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM opportunity_identity_conflicts`).get().n,
    ).toBe(1)
  })

  it('re-observation bumps last_seen_at', async () => {
    const db = makeMigratedDb()
    const first = await upsertOpenConflict(db, { ...CONFLICT, evidence: 'e1' })
    db.prepare(`UPDATE opportunity_identity_conflicts SET last_seen_at = '2000-01-01 00:00:00'`).run()
    const second = await upsertOpenConflict(db, { ...CONFLICT, evidence: 'e2' })
    expect(second.id).toBe(first.id)
    expect(second.last_seen_at).not.toBe('2000-01-01 00:00:00')
  })

  it('the partial unique index itself refuses a second open row (raw-write backstop)', () => {
    const db = makeMigratedDb()
    const insert = db.prepare(
      `INSERT INTO opportunity_identity_conflicts
         (id, scheme, identity_key, opportunity_id_a, opportunity_id_b, status)
       VALUES (?, ?, ?, 'a', 'b', ?)`,
    )
    insert.run('c1', 's', 'k', 'open')
    expect(() => insert.run('c2', 's', 'k', 'open')).toThrow(/UNIQUE constraint failed/)
    // A RESOLVED row for the same key coexists fine — the index is partial.
    expect(() => insert.run('c3', 's', 'k', 'resolved_distinct')).not.toThrow()
  })

  it('after resolution, a NEW open conflict for the same key gets a NEW row (partial-unique frees the slot)', async () => {
    const db = makeMigratedDb()
    const first = await upsertOpenConflict(db, { ...CONFLICT, evidence: 'round one' })
    expect(await resolveConflict(db, first.id, 'resolved_distinct')).toBe(true)

    const reopened = await upsertOpenConflict(db, { ...CONFLICT, evidence: 'round two' })
    expect(reopened.id).not.toBe(first.id)
    expect(reopened.status).toBe('open')
    const rows = db
      .prepare(`SELECT status, COUNT(*) AS n FROM opportunity_identity_conflicts GROUP BY status ORDER BY status`)
      .all()
    expect(rows).toEqual([
      { status: 'open', n: 1 },
      { status: 'resolved_distinct', n: 1 },
    ])
  })
})

describe('resolveConflict', () => {
  it('moves an open conflict to each of the three resolved states', async () => {
    const db = makeMigratedDb()
    for (const status of RESOLVED_CONFLICT_STATUSES) {
      const row = await upsertOpenConflict(db, {
        scheme: 's',
        identityKey: `k-${status}`,
        aId: 'a',
        bId: 'b',
      })
      expect(await resolveConflict(db, row.id, status)).toBe(true)
      expect(
        db.prepare(`SELECT status FROM opportunity_identity_conflicts WHERE id = ?`).get(row.id).status,
      ).toBe(status)
    }
  })

  it("REJECTS 'open' (a conflict is never re-opened through resolveConflict)", async () => {
    const db = makeMigratedDb()
    const row = await upsertOpenConflict(db, { scheme: 's', identityKey: 'k', aId: 'a', bId: 'b' })
    await expect(resolveConflict(db, row.id, 'open')).rejects.toThrow(TypeError)
    // And any unknown status.
    await expect(resolveConflict(db, row.id, 'resolved')).rejects.toThrow(TypeError)
    await expect(resolveConflict(db, row.id, undefined)).rejects.toThrow(TypeError)
    // The row is untouched.
    expect(
      db.prepare(`SELECT status FROM opportunity_identity_conflicts WHERE id = ?`).get(row.id).status,
    ).toBe('open')
  })

  it('returns false for an unknown id (nothing updated, no throw)', async () => {
    const db = makeMigratedDb()
    expect(await resolveConflict(db, 'no-such-id', 'dismissed')).toBe(false)
  })

  it('every CHECK-constraint status is reachable: the constant lists exactly the DDL statuses', () => {
    // The DDL CHECK and the module constant must not drift.
    const ddl = fs.readFileSync(sqlitePath, 'utf8')
    for (const status of CONFLICT_STATUSES) {
      expect(ddl).toContain(`'${status}'`)
    }
    expect(RESOLVED_CONFLICT_STATUSES).toEqual(CONFLICT_STATUSES.filter((s) => s !== 'open'))
  })
})

describe('withIdentityTxn — dialect dispatch + retry-once', () => {
  it('commits the callback result through the raw-sqlite BEGIN IMMEDIATE path', async () => {
    const db = makeMigratedDb()
    const result = await withIdentityTxn(db, ALIAS.scheme, ALIAS.identityKey, async (tx) => {
      const existing = await getAlias(tx, ALIAS.scheme, ALIAS.identityKey)
      if (existing) return existing
      return insertAlias(tx, ALIAS)
    })
    expect(result.opportunity_id).toBe('opp-1')
    expect(await getAlias(db, ALIAS.scheme, ALIAS.identityKey)).toEqual(result)
  })

  it('rolls back the transaction when the callback throws a non-unique error (no retry)', async () => {
    const db = makeMigratedDb()
    let calls = 0
    await expect(
      withIdentityTxn(db, ALIAS.scheme, ALIAS.identityKey, async (tx) => {
        calls += 1
        await insertAlias(tx, ALIAS)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(calls).toBe(1) // a non-unique error is NEVER retried
    expect(await getAlias(db, ALIAS.scheme, ALIAS.identityKey)).toBeNull() // rolled back
  })

  it('retries ONCE on a unique violation from a lost two-writer race; the re-read sees the winner', async () => {
    const db = makeMigratedDb()
    // Writer B (the winner) has already committed its claim.
    await insertAlias(db, { ...ALIAS, opportunityId: 'opp-winner' })

    let calls = 0
    const result = await withIdentityTxn(db, ALIAS.scheme, ALIAS.identityKey, async (tx) => {
      calls += 1
      const existing = await getAlias(tx, ALIAS.scheme, ALIAS.identityKey)
      if (calls === 1) {
        // Attempt 1 stands in for the LOST RACE: writer A's read happened
        // before writer B's commit landed (a deterministic schedule of the
        // physical interleave is impossible under BEGIN IMMEDIATE on one
        // file), so A acts on its stale null read and claims anyway — which is
        // exactly the unique violation the retry exists to absorb.
        return insertAlias(tx, { ...ALIAS, opportunityId: 'opp-loser' })
      }
      return existing
    })

    expect(calls).toBe(2) // exactly one retry
    expect(result.opportunity_id).toBe('opp-winner') // the re-read saw the winner
    const rows = db.prepare(`SELECT opportunity_id FROM opportunity_identity_aliases`).all()
    expect(rows).toEqual([{ opportunity_id: 'opp-winner' }]) // the loser's claim never landed
  })

  it('a unique violation on the RETRY itself propagates (retry is ONCE, not a loop)', async () => {
    const db = makeMigratedDb()
    await insertAlias(db, { ...ALIAS, opportunityId: 'opp-winner' })
    let calls = 0
    await expect(
      withIdentityTxn(db, ALIAS.scheme, ALIAS.identityKey, async (tx) => {
        calls += 1
        // A callback that never re-reads keeps colliding — the second failure
        // must surface, not spin.
        return insertAlias(tx, { ...ALIAS, opportunityId: 'opp-loser' })
      }),
    ).rejects.toSatisfy(isUniqueViolation)
    expect(calls).toBe(2)
  })

  it('POSTGRES dispatch: takes pg_advisory_xact_lock(hashtext(scheme || \':\' || identity_key)) INSIDE the txn, BEFORE the callback', async () => {
    const events = []
    const fakePg = {
      dialect: 'postgres',
      async withTransaction(fn) {
        events.push('BEGIN')
        const tx = {
          dialect: 'postgres',
          prepare(sql) {
            return {
              get: async (...args) => {
                events.push({ sql: sql.replace(/\s+/g, ' ').trim(), args })
                return { locked: true }
              },
              all: async () => [],
              run: async () => ({ changes: 0 }),
            }
          },
        }
        const result = await fn(tx)
        events.push('COMMIT')
        return result
      },
    }

    const result = await withIdentityTxn(fakePg, 'normalized_url', 'key-1', async (tx) => {
      events.push('CALLBACK')
      expect(tx.dialect).toBe('postgres') // the callback gets the TX handle
      return 'done'
    })

    expect(result).toBe('done')
    expect(events[0]).toBe('BEGIN')
    expect(events[1].sql).toContain("pg_advisory_xact_lock(hashtext(? || ':' || ?))")
    expect(events[1].args).toEqual(['normalized_url', 'key-1'])
    expect(events[2]).toBe('CALLBACK') // lock BEFORE any callback dual-read
    expect(events[3]).toBe('COMMIT')
  })

  it('SQLITE shim dispatch: uses the shim withTransaction (BEGIN IMMEDIATE lives there), no advisory-lock SQL', async () => {
    const prepared = []
    const raw = makeMigratedDb()
    const fakeShim = {
      dialect: 'sqlite',
      prepare(sql) {
        prepared.push(sql)
        return raw.prepare(sql)
      },
      async withTransaction(fn) {
        // The real shim opens BEGIN IMMEDIATE and passes itself.
        prepared.push('BEGIN IMMEDIATE')
        return fn(this)
      },
    }
    const result = await withIdentityTxn(fakeShim, ALIAS.scheme, ALIAS.identityKey, (tx) =>
      insertAlias(tx, ALIAS),
    )
    expect(result.opportunity_id).toBe('opp-1')
    expect(prepared[0]).toBe('BEGIN IMMEDIATE')
    expect(prepared.some((s) => String(s).includes('pg_advisory_xact_lock'))).toBe(false)
  })
})

describe('migration twins — opportunity identity tables', () => {
  it('exist as a numbered twin pair (found by suffix — numbers only in filenames)', () => {
    expect(fs.existsSync(sqlitePath)).toBe(true)
    expect(fs.existsSync(pgPath)).toBe(true)
    // No migration NUMBER inside the SQL, so a renumber never edits content.
    for (const p of [sqlitePath, pgPath]) {
      const base = path.basename(p)
      const number = base.split('_')[0]
      expect(fs.readFileSync(p, 'utf8')).not.toContain(number)
    }
  })

  it('both twins create both tables + the partial unique open-conflict index', () => {
    for (const p of [sqlitePath, pgPath]) {
      const sql = fs.readFileSync(p, 'utf8')
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS opportunity_identity_aliases/)
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS opportunity_identity_conflicts/)
      expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS ux_opportunity_identity_conflicts_one_open/)
      expect(sql).toMatch(/WHERE status = 'open'/)
    }
  })

  it('applies on a fresh DB AND is idempotent (re-run is a clean no-op)', () => {
    const raw = new Database(':memory:')
    const sql = fs.readFileSync(sqlitePath, 'utf8')
    expect(() => raw.exec(sql)).not.toThrow()
    // Re-running must be a clean no-op (IF NOT EXISTS guards).
    expect(() => raw.exec(sql)).not.toThrow()
    const tables = raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'opportunity_identity_%' ORDER BY name`,
      )
      .all()
      .map((r) => r.name)
    expect(tables).toEqual(['opportunity_identity_aliases', 'opportunity_identity_conflicts'])
  })

  it('fresh-install parity: schema.sql bootstrap creates the SAME tables + partial index, and the accessors work on it', async () => {
    const raw = new Database(':memory:')
    raw.exec(fs.readFileSync(schemaSqlPath, 'utf8'))
    raw.dialect = 'sqlite'
    const tables = raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'opportunity_identity_%' ORDER BY name`,
      )
      .all()
      .map((r) => r.name)
    expect(tables).toEqual(['opportunity_identity_aliases', 'opportunity_identity_conflicts'])
    const partialIndex = raw
      .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='ux_opportunity_identity_conflicts_one_open'`)
      .get()
    expect(partialIndex?.sql).toMatch(/WHERE status = 'open'/)
    // The accessors run unchanged against the schema.sql-built DB.
    await insertAlias(raw, ALIAS)
    expect((await getAlias(raw, ALIAS.scheme, ALIAS.identityKey)).opportunity_id).toBe('opp-1')
    const conflict = await upsertOpenConflict(raw, {
      scheme: 's', identityKey: 'k', aId: 'a', bId: 'b', evidence: 'parity',
    })
    expect(conflict.status).toBe('open')
  })
})

describe('zero behavior change — nothing live calls the accessor yet', () => {
  // Walk the live source dirs (NOT tests) for any import/require of the
  // accessor module. Doc-comment MENTIONS of the module path (schema.sql, the
  // migrations) are fine — those are the additive registration points, not
  // callers; we assert only that no live code IMPORTS/CALLS it (wired in a
  // later sub-PR).
  const LIVE_DIRS = ['backend', 'src', 'shared']
  const CODE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx)$/
  const IMPORT_RE = /(?:from\s+['"][^'"]*opportunityIdentityStore|require\(\s*['"][^'"]*opportunityIdentityStore)/
  const CALL_RE = /\b(?:getAlias|insertAlias|touchAlias|upsertOpenConflict|resolveConflict|withIdentityTxn)\s*\(/

  function walk(dir, out) {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return out
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        // Skip test directories/files — the accessor's OWN tests import it.
        if (ent.name === 'tests' || ent.name === '__tests__') continue
        walk(full, out)
      } else if (CODE_EXT.test(ent.name) && !/\.test\.|\.spec\./.test(ent.name)) {
        out.push(full)
      }
    }
    return out
  }

  it('no live source file imports OR calls the accessor (wired in a later sub-PR)', () => {
    const modulePath = 'backend/services/opportunityIdentityStore.js'
    const files = LIVE_DIRS.flatMap((d) => walk(path.join(process.cwd(), d), []))
    const offenders = []
    for (const f of files) {
      const rel = path.relative(process.cwd(), f).split(path.sep).join('/')
      if (rel === modulePath) continue // the module defines the functions
      const src = fs.readFileSync(f, 'utf8')
      if (IMPORT_RE.test(src) || CALL_RE.test(src)) offenders.push(rel)
    }
    expect(offenders, `unexpected live import/call of opportunityIdentityStore: ${offenders.join(', ')}`).toEqual([])
  })
})
