/**
 * visitorIdentity — GrantFlow's own answer to "who used this IP": sign-ins
 * and audited actions joined to accounts. Registry data can never name a
 * person behind a consumer carrier pool; this can, for our own users only.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { lookupVisitorIdentity, normalizeIps } = await import('../services/visitorIdentity.js')

function seed() {
  const sqlite = new Database(':memory:')
  sqlite.dialect = 'sqlite'
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, primary_email TEXT, display_name TEXT, is_admin INTEGER DEFAULT 0);
    CREATE TABLE user_sessions (id TEXT PRIMARY KEY, user_id TEXT, ip_address TEXT, created_at TEXT);
    CREATE TABLE audit_logs (id TEXT PRIMARY KEY, action TEXT, user_id TEXT, ip_address TEXT, created_at TEXT);
  `)
  sqlite.prepare("INSERT INTO users VALUES ('u1','student@example.org','Demo Student',0)").run()
  sqlite.prepare("INSERT INTO users VALUES ('u2','owner@example.org','Site Owner',1)").run()
  const s = sqlite.prepare('INSERT INTO user_sessions VALUES (?,?,?,?)')
  s.run('s1', 'u1', '71.155.201.16', '2026-09-01T10:00:00Z')
  s.run('s2', 'u1', '71.155.201.16', '2026-09-07T21:16:00Z')
  s.run('s3', 'u2', '71.155.201.16', '2026-09-05T12:00:00Z') // shared address: owner once
  s.run('s4', 'u2', '10.0.0.9', '2026-09-06T09:00:00Z')
  const a = sqlite.prepare('INSERT INTO audit_logs VALUES (?,?,?,?,?)')
  a.run('a1', 'auth.login', 'u1', '71.155.201.16', '2026-09-07T21:16:00Z')
  a.run('a2', 'profile.update', 'u1', '71.155.201.16', '2026-09-07T21:20:00Z')
  a.run('a3', 'auth.password_reset', 'u2', '203.0.113.7', '2026-09-02T08:00:00Z') // audit only, no session
  return wrapSqlite(sqlite)
}

describe('normalizeIps', () => {
  it('trims, dedupes, drops junk and caps', () => {
    expect(normalizeIps(' 1.1.1.1, 1.1.1.1 ,not an ip,2001:db8::1,', { max: 5 })).toEqual(['1.1.1.1', '2001:db8::1'])
    expect(normalizeIps(['a', '9.9.9.9'])).toEqual(['9.9.9.9'])
    expect(normalizeIps('')).toEqual([])
  })
})

describe('lookupVisitorIdentity', () => {
  it('names the account with the most sign-ins, lists the others, and attaches recent audited actions newest first', async () => {
    const out = await lookupVisitorIdentity(seed(), ['71.155.201.16', '8.8.8.8'])
    const who = out['71.155.201.16']
    expect(who.email).toBe('student@example.org')
    expect(who.name).toBe('Demo Student')
    expect(who.sessions).toBe(2)
    expect(who.first_seen).toBe('2026-09-01T10:00:00Z')
    expect(who.last_seen).toBe('2026-09-07T21:16:00Z')
    expect(who.others).toEqual([{ email: 'owner@example.org', sessions: 1 }])
    expect(who.audit.map((x) => x.action)).toEqual(['profile.update', 'auth.login'])
    expect(out['8.8.8.8']).toBeUndefined()
  })

  it('an audited action alone still names the account', async () => {
    const out = await lookupVisitorIdentity(seed(), '203.0.113.7')
    expect(out['203.0.113.7'].email).toBe('owner@example.org')
    expect(out['203.0.113.7'].sessions).toBe(0)
    expect(out['203.0.113.7'].audit[0].action).toBe('auth.password_reset')
  })

  it('flags admins and returns nothing for an empty ask', async () => {
    const out = await lookupVisitorIdentity(seed(), ['10.0.0.9'])
    expect(out['10.0.0.9'].is_admin).toBe(true)
    expect(await lookupVisitorIdentity(seed(), '')).toEqual({})
  })
})
