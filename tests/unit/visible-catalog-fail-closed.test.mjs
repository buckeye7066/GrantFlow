import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import migration from '../../backend/db/migrations/999z_fail_closed_visible_catalog.mjs'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

describe('visible catalog fail-closed migration', () => {
  it('hides stale/unverified rows and preserves freshly verified rows', async () => {
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE funding_opportunities (
        id TEXT PRIMARY KEY, is_active INTEGER, is_hidden INTEGER,
        link_status TEXT, last_verified_at TEXT
      );
      CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    `)
    const fresh = new Date().toISOString()
    sqlite.prepare('INSERT INTO funding_opportunities VALUES (?, 1, 0, ?, ?)').run('fresh', 'ok', fresh)
    sqlite.prepare('INSERT INTO funding_opportunities VALUES (?, 1, 0, ?, ?)').run('missing', 'unverified', null)
    sqlite.prepare('INSERT INTO funding_opportunities VALUES (?, 1, 0, ?, ?)').run('stale', 'ok', '2020-01-01T00:00:00.000Z')
    await migration(wrapSqlite(sqlite))
    assert.equal(sqlite.prepare('SELECT is_hidden FROM funding_opportunities WHERE id = ?').get('fresh').is_hidden, 0)
    assert.equal(sqlite.prepare('SELECT is_hidden FROM funding_opportunities WHERE id = ?').get('missing').is_hidden, 1)
    assert.equal(sqlite.prepare('SELECT is_hidden FROM funding_opportunities WHERE id = ?').get('stale').is_hidden, 1)
  })
})
