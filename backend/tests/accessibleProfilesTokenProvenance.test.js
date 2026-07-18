/**
 * SECURITY REGRESSION (token identity self-authorization).
 *
 * getAccessibleProfileIds / getOwnedAndGrantedProfileIds must derive access from
 * DB-TRUSTED state only:
 *   - profile ownership (profiles.user_id / created_by),
 *   - email grants matched against the user's DB-VERIFIED emails
 *     (users.primary_email + verified user_credentials), NEVER req.user.email,
 *   - the token profileId ONLY via the legacy-token provenance flag.
 * A signed/stale JWT that claims someone else's email or profile_id gains nothing.
 */

import { describe, expect, it, beforeEach } from 'vitest'

const Database = (await import('better-sqlite3')).default
const { getAccessibleProfileIds, getOwnedAndGrantedProfileIds, getTrustedUserEmails } = await import(
  '../utils/accessControl.js'
)

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, is_admin INTEGER DEFAULT 0, primary_email TEXT);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT, status TEXT);
    CREATE TABLE profile_emails (id TEXT PRIMARY KEY, profile_id TEXT, email TEXT, added_by TEXT, created_at TEXT);
    CREATE TABLE user_credentials (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, identifier TEXT, verified_at DATETIME);
    INSERT INTO users (id, is_admin, primary_email) VALUES ('u1', 0, 'u1@test.example');
    INSERT INTO users (id, is_admin, primary_email) VALUES ('u2', 0, 'u2@test.example');
    INSERT INTO profiles (id, user_id, created_by, status) VALUES ('own1', 'u1', 'u1', 'active');
    INSERT INTO profiles (id, user_id, created_by, status) VALUES ('victim', 'someone-else', 'someone-else', 'active');
    INSERT INTO profiles (id, user_id, created_by, status) VALUES ('shared', 'owner-x', 'owner-x', 'active');
    -- 'shared' is granted to board@org.com via the profile_emails allowlist.
    INSERT INTO profile_emails (id, profile_id, email, added_by, created_at) VALUES ('pe1', 'shared', 'board@org.com', 'owner-x', '2026-01-01');
    -- u1 has a VERIFIED secondary email credential board@org.com.
    INSERT INTO user_credentials (id, user_id, type, identifier, verified_at) VALUES ('c1', 'u1', 'email_otp', 'board@org.com', '2026-01-01T00:00:00Z');
    -- u2 has an UNVERIFIED board@org.com credential (verified_at NULL) — must NOT grant.
    INSERT INTO user_credentials (id, user_id, type, identifier, verified_at) VALUES ('c2', 'u2', 'email_otp', 'board@org.com', NULL);
  `)
  return db
}

describe('getAccessibleProfileIds token profile_id provenance', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('a JWT profile_id for a profile the user does NOT own is NOT accessible', async () => {
    const jwtUser = { role: 'user', userId: 'u1', profileId: 'victim' } // no profileTokenAuth
    const ids = await getAccessibleProfileIds(db, jwtUser)
    expect(ids instanceof Set).toBe(true)
    expect(ids.has('own1')).toBe(true) // real ownership still resolves
    expect(ids.has('victim')).toBe(false) // forged tenant rejected
  })

  it('a DB-verified legacy profile TOKEN (profileTokenAuth) still resolves its profileId', async () => {
    const legacyTokenUser = { role: 'user', userId: 'own1', profileId: 'own1', profileTokenAuth: true }
    const ids = await getAccessibleProfileIds(db, legacyTokenUser)
    expect(ids.has('own1')).toBe(true)
  })
})

describe('email-based profile grants derive from DB-verified emails only', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('getTrustedUserEmails returns DB primary_email + VERIFIED credential emails, ignoring the token email', async () => {
    const emails = await getTrustedUserEmails(db, { userId: 'u1', email: 'victim@example.com' })
    expect(emails.slice().sort()).toEqual(['board@org.com', 'u1@test.example'])
    expect(emails).not.toContain('victim@example.com')
  })

  it('a user whose DB-verified email matches an email grant resolves the shared profile', async () => {
    const ids = await getAccessibleProfileIds(db, { role: 'user', userId: 'u1' })
    expect(ids.has('shared')).toBe(true) // via verified board@org.com credential
    expect(ids.has('own1')).toBe(true)
  })

  it('a JWT whose EMAIL claims the granted address but whose DB email differs gains NOTHING', async () => {
    // u2's DB primary_email is u2@test.example and its board@org.com credential is
    // UNVERIFIED; the JWT claim email='board@org.com' must not grant 'shared'.
    const jwtUser = { role: 'user', userId: 'u2', email: 'board@org.com' }
    const ids = await getAccessibleProfileIds(db, jwtUser)
    expect(ids.has('shared')).toBe(false)
    expect(ids.has('victim')).toBe(false)
  })

  it('getOwnedAndGrantedProfileIds (used by scope=mine) is DB-email-bound and ignores the token email', async () => {
    const ids = await getOwnedAndGrantedProfileIds(db, { role: 'user', userId: 'u1', email: 'victim@example.com' })
    expect(ids.has('own1')).toBe(true)
    expect(ids.has('shared')).toBe(true)
    expect(ids.has('victim')).toBe(false)
  })
})
