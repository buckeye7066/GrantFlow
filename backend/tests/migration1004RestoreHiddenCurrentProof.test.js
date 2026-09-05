/**
 * Migration 1004 un-hides ONLY rows whose stored state is entirely successful
 * and unmarked (fresh successful link proof, no verification marker, active
 * status, reality not rejected, deadline open). Every other hidden row stays
 * hidden: a verification marker, a paused/quarantined status, a rejected
 * reality status, stale proof, or a past deadline each keep the row as it is.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import up from '../db/migrations/1004_restore_hidden_rows_with_current_proof.mjs'

const DAY_MS = 24 * 60 * 60_000
const fresh = new Date(Date.now() - 10 * DAY_MS).toISOString()
const stale = new Date(Date.now() - 45 * DAY_MS).toISOString()

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, is_hidden INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
      link_status TEXT, last_verified_at TEXT, verification_error TEXT, status TEXT DEFAULT 'active',
      reality_status TEXT, deadline TEXT
    );
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  `)
  const ins = raw.prepare(`INSERT INTO funding_opportunities
    (id, title, is_hidden, is_active, link_status, last_verified_at, verification_error, status, reality_status, deadline)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  ins.run('restore-ok', 'Nourished Communities Grant', 1, 1, 'ok', fresh, null, 'active', 'verified', null)
  ins.run('restore-redirect-future', 'Housing Grants for Green Homes', 1, 1, 'redirect', fresh, '', 'active', 'rolling', '2099-01-01')
  ins.run('keep-marker', 'Marked row', 1, 1, 'ok', fresh, 'stale_reverification_required:2026-08-06', 'active', 'verified', null)
  ins.run('keep-paused', 'Paused row', 1, 1, 'ok', fresh, null, 'paused', 'verified', null)
  ins.run('keep-rejected', 'Rejected reality', 1, 1, 'ok', fresh, null, 'active', 'rejected', null)
  ins.run('keep-stale', 'Stale proof', 1, 1, 'ok', stale, null, 'active', 'verified', null)
  ins.run('keep-broken', 'Broken link', 1, 1, 'broken', fresh, null, 'active', 'verified', null)
  ins.run('keep-past-deadline', 'Deadline passed', 1, 1, 'ok', fresh, null, 'active', 'verified', '2020-01-01')
  ins.run('keep-inactive', 'Inactive row', 1, 0, 'ok', fresh, null, 'active', 'verified', null)
  ins.run('already-visible', 'Visible row', 0, 1, 'ok', fresh, null, 'active', 'verified', null)
  return { raw, db: wrapSqlite(raw) }
}

describe('migration 1004: restore hidden rows carrying current successful proof', () => {
  it('un-hides exactly the unmarked fresh-success rows and records the count', async () => {
    const { raw, db } = makeDb()
    await up(db)
    const visible = raw.prepare('SELECT id FROM funding_opportunities WHERE is_hidden = 0 ORDER BY id').all().map((r) => r.id)
    expect(visible).toEqual(['already-visible', 'restore-ok', 'restore-redirect-future'])
    const hidden = raw.prepare('SELECT id FROM funding_opportunities WHERE is_hidden = 1 ORDER BY id').all().map((r) => r.id)
    expect(hidden).toEqual([
      'keep-broken', 'keep-inactive', 'keep-marker', 'keep-past-deadline', 'keep-paused', 'keep-rejected', 'keep-stale',
    ])
    const kv = JSON.parse(raw.prepare("SELECT value FROM system_kv WHERE key = 'hidden_current_proof_restore_last_run'").get().value)
    expect(kv.restored).toBe(2)
  })

  it('is idempotent', async () => {
    const { raw, db } = makeDb()
    await up(db)
    await up(db)
    expect(raw.prepare('SELECT COUNT(*) AS n FROM funding_opportunities WHERE is_hidden = 0').get().n).toBe(3)
    const kv = JSON.parse(raw.prepare("SELECT value FROM system_kv WHERE key = 'hidden_current_proof_restore_last_run'").get().value)
    expect(kv.restored).toBe(0)
  })
})
