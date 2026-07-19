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
const { getAccessibleProfileIds, getOwnedAndGrantedProfileIds, getTrustedUserEmails, isAdminUserWithDb } = await import(
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
    -- 'stale-owned' is owned by a DELETED user (no users row for 'deleted-user').
    INSERT INTO profiles (id, user_id, created_by, status) VALUES ('stale-owned', 'deleted-user', 'deleted-user', 'active');
    -- A self-healed synthetic admin-token row + a profile it "owns" and its email grant.
    INSERT INTO users (id, is_admin, primary_email) VALUES ('system_admin_token', 1, 'svc@grantflow.app');
    INSERT INTO profiles (id, user_id, created_by, status) VALUES ('svc-owned', 'system_admin_token', 'system_admin_token', 'active');
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

describe('getOwnedAndGrantedProfileIds FAILS CLOSED for a deleted user (no users row)', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('a stale JWT for a DELETED user gains NOTHING even if profiles.user_id still references it', async () => {
    // 'deleted-user' has no users row but still owns 'stale-owned'.
    const staleJwt = { role: 'user', userId: 'deleted-user' }
    const owned = await getOwnedAndGrantedProfileIds(db, staleJwt)
    expect(owned.has('stale-owned')).toBe(false)
    expect(owned.size).toBe(0)
    // And through the admin-aware wrapper (used by ensureProfileAccess):
    const accessible = await getAccessibleProfileIds(db, staleJwt)
    expect(accessible.has('stale-owned')).toBe(false)
  })

  it('a REAL user (with a users row) still resolves their owned profiles', async () => {
    const ids = await getOwnedAndGrantedProfileIds(db, { role: 'user', userId: 'u1' })
    expect(ids.has('own1')).toBe(true)
  })

  it('a validated synthetic service token is not blocked by the users-row gate', async () => {
    // serviceToken provenance skips the users-row requirement; it simply has no
    // owned/granted personal profiles here (returns an empty set, does not throw).
    const svc = { role: 'admin', is_admin: true, serviceToken: true, userId: 'system_admin_token' }
    const ids = await getOwnedAndGrantedProfileIds(db, svc)
    expect(ids instanceof Set).toBe(true)
  })
})

describe('a synthetic-id JWT WITHOUT service-token provenance is rejected everywhere', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('gets NO profiles from the grant helper even though a users.id row was self-healed', async () => {
    const jwt = { role: 'user', userId: 'system_admin_token' } // colliding sub, NO serviceToken
    const owned = await getOwnedAndGrantedProfileIds(db, jwt)
    expect(owned.size).toBe(0)
    expect(owned.has('svc-owned')).toBe(false)
  })

  it('is NOT admin via isAdminUserWithDb (does not honor the self-healed synthetic row)', async () => {
    const jwt = { role: 'user', userId: 'system_admin_token', roles: ['admin'] }
    expect(await isAdminUserWithDb(db, jwt)).toBe(false)
  })

  it('getAccessibleProfileIds returns an EMPTY set (not the admin null sentinel)', async () => {
    const jwt = { role: 'user', userId: 'system_admin_token' }
    const ids = await getAccessibleProfileIds(db, jwt)
    expect(ids instanceof Set).toBe(true)
    expect(ids.size).toBe(0)
  })

  it('the REAL service token (serviceToken provenance) still resolves admin', async () => {
    const svc = { role: 'admin', is_admin: true, serviceToken: true, userId: 'system_admin_token' }
    expect(await isAdminUserWithDb(db, svc)).toBe(true)
    expect(await getAccessibleProfileIds(db, svc)).toBeNull() // admin sentinel
  })

  it('cannot REHYDRATE admin via a token profileId that maps to the synthetic-admin row', async () => {
    // r14 hole: userId nulled but profileId survives -> profiles.user_id -> synthetic row.
    // PRECONDITION: 'svc-owned' MUST actually map to system_admin_token, so this
    // test genuinely exercises the reserved-synthetic-id guard in the
    // profileId->userId rehydration path (would FAIL if the guard regressed).
    const mapping = db.prepare('SELECT user_id FROM profiles WHERE id = ?').get('svc-owned')
    expect(mapping?.user_id).toBe('system_admin_token')

    const viaProfile = { role: 'user', userId: null, profileId: 'svc-owned' } // no serviceToken
    expect(await isAdminUserWithDb(db, viaProfile)).toBe(false)
    const ids = await getAccessibleProfileIds(db, viaProfile)
    expect(ids).not.toBeNull() // never the all-access sentinel
    expect(ids.size).toBe(0)
  })

  it('cannot REHYDRATE admin via a token email that matches the synthetic-admin row', async () => {
    const viaEmail = { role: 'user', userId: null, email: 'svc@grantflow.app' } // no serviceToken
    expect(await isAdminUserWithDb(db, viaEmail)).toBe(false)
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
