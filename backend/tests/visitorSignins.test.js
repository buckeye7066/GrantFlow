/**
 * listVisitorSignins — every sign-in in a window, newest first, with the
 * account and profile it belongs to (the Axiom Visitors "Sign-ins" tab,
 * owner 2026-09-07: "list the logins in order of time").
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { listVisitorSignins } = await import('../services/visitorIdentity.js')

function seed() {
  const sqlite = new Database(':memory:')
  sqlite.dialect = 'sqlite'
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, primary_email TEXT, display_name TEXT, is_admin INTEGER DEFAULT 0);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT);
    CREATE TABLE user_sessions (id TEXT PRIMARY KEY, user_id TEXT, profile_id TEXT, ip_address TEXT, user_agent TEXT, created_at TEXT);
  `)
  sqlite.prepare("INSERT INTO users VALUES ('u1','senior@example.org','Demo Senior',0)").run()
  sqlite.prepare("INSERT INTO users VALUES ('u2','owner@example.org','Site Owner',1)").run()
  sqlite.prepare("INSERT INTO profiles VALUES ('p1','Demo Senior Profile')").run()
  const s = sqlite.prepare('INSERT INTO user_sessions VALUES (?,?,?,?,?,?)')
  s.run('s1', 'u1', 'p1', '152.233.47.65', 'Mozilla/5.0 (Macintosh) Safari/605.1.15', '2026-09-07T23:24:04Z')
  s.run('s2', 'u1', 'p1', '152.233.47.65', 'Mozilla/5.0 (Macintosh) Safari/605.1.15', '2026-09-08T00:14:27Z')
  s.run('s3', 'u2', null, '104.63.145.56', 'curl/8.21.0', '2026-09-07T20:20:29Z')
  s.run('s4', 'u1', 'p1', '152.233.47.65', 'Safari', '2026-09-01T00:00:00Z') // outside the window
  return wrapSqlite(sqlite)
}

describe('listVisitorSignins', () => {
  it('lists the window newest first with account, profile, ip, and device', async () => {
    const out = await listVisitorSignins(seed(), { since: new Date('2026-09-07T00:00:00Z') })
    expect(out.map((r) => r.id)).toEqual(['s2', 's1', 's3'])
    expect(out[0]).toMatchObject({
      at: '2026-09-08T00:14:27Z', ip: '152.233.47.65', email: 'senior@example.org', name: 'Demo Senior',
      is_admin: false, profile_id: 'p1', profile_name: 'Demo Senior Profile',
    })
    expect(out[2]).toMatchObject({ email: 'owner@example.org', is_admin: true, profile_id: null, profile_name: null, user_agent: 'curl/8.21.0' })
  })
  it('honors the limit and needs a window', async () => {
    expect(await listVisitorSignins(seed(), { since: new Date('2026-09-07T00:00:00Z'), limit: 1 })).toHaveLength(1)
    expect(await listVisitorSignins(seed(), {})).toEqual([])
  })
})
