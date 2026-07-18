/**
 * SECURITY REGRESSION (token profile_id self-authorization).
 *
 * getAccessibleProfileIds used to unconditionally add getAuthProfileId(user) —
 * i.e. the token's profile_id — to the accessible set, so a signed JWT could
 * choose its own tenant (profile_id:'victim') and read it. Access must derive
 * from DB ownership / email grants; a token profile_id is access proof ONLY for
 * the DB-verified legacy profile bearer token (provenance flag profileTokenAuth,
 * never settable from a JWT payload).
 */

import { describe, expect, it, beforeEach } from 'vitest'

const Database = (await import('better-sqlite3')).default
const { getAccessibleProfileIds } = await import('../utils/accessControl.js')

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, is_admin INTEGER DEFAULT 0, primary_email TEXT);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT, status TEXT);
    INSERT INTO users (id, is_admin, primary_email) VALUES ('u1', 0, 'u1@test.example');
    INSERT INTO profiles (id, user_id, created_by, status) VALUES ('own1', 'u1', 'u1', 'active');
    INSERT INTO profiles (id, user_id, created_by, status) VALUES ('victim', 'someone-else', 'someone-else', 'active');
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

  it('a legacy-token flag cannot smuggle a profile the token was not issued for — but that is a per-token concern; a JWT still cannot set the flag', async () => {
    // Documents the provenance boundary: a JWT user object never carries
    // profileTokenAuth (only the legacy-token auth branch sets it), so a JWT with
    // profile_id:'victim' is denied even though this stub can't forge the flag.
    const jwtUser = { role: 'user', userId: 'u1', profileId: 'victim' }
    const ids = await getAccessibleProfileIds(db, jwtUser)
    expect(ids.has('victim')).toBe(false)
  })
})
