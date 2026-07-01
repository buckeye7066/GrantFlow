/**
 * Portal-login session persistence: a captured storageState must survive as a
 * durable, encrypted row and be reloadable by ANY actor on the profile — so
 * logins persist across runs and container restarts. Regression guard for the
 * previously-missing autopilot save half (engine → sessionSink → importSession).
 */
import { describe, it, expect, beforeEach } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = 'd'.repeat(64)

const Database = (await import('better-sqlite3')).default
const {
  importSession, findValidSession, getSessionStorageState,
  listSessionsForProfile, _resetCredentialSchemaCache,
} = await import('../services/hamilton/hamiltonCredentialSessionService.js')

function makeDb() { return new Database(':memory:') }
const STATE = { cookies: [{ name: 'sid', value: 'abc', domain: 'mtsu.edu', path: '/' }], origins: [] }

describe('Hamilton portal session persistence (save → load round-trip)', () => {
  let db
  beforeEach(() => { db = makeDb(); _resetCredentialSchemaCache() })

  it('a saved session is found and decrypts back to the same storageState', async () => {
    // Save with the full portal URL (what the autopilot passes); load by host.
    await importSession(db, {
      userId: 'u1', profileId: 'pA', portalHost: 'https://mtsu.edu/apply',
      storageState: STATE, authenticationStrategy: 'autopilot_login',
    })
    const found = await findValidSession(db, { profileId: 'pA', portalHost: 'mtsu.edu' })
    expect(found).toBeTruthy()
    expect(found.has_storage_state).toBe(true)
    const loaded = await getSessionStorageState(db, found.id)
    expect(loaded).toEqual(STATE)
  })

  it('is found regardless of which user acts on the profile (profile+host scoped)', async () => {
    await importSession(db, { userId: 'the-cobrowse-user', profileId: 'pA', portalHost: 'mtsu.edu', storageState: STATE })
    // A different actor (e.g. the automation "system" user) still resolves it.
    const found = await findValidSession(db, { profileId: 'pA', portalHost: 'mtsu.edu' })
    expect(found).toBeTruthy()
  })

  it('re-import for the same profile+host updates in place (no duplicate rows)', async () => {
    await importSession(db, { userId: 'u1', profileId: 'pA', portalHost: 'mtsu.edu', storageState: STATE })
    await importSession(db, {
      userId: 'u1', profileId: 'pA', portalHost: 'mtsu.edu',
      storageState: { cookies: [{ name: 'sid', value: 'NEW', domain: 'mtsu.edu', path: '/' }], origins: [] },
    })
    const list = await listSessionsForProfile(db, 'pA')
    expect(list).toHaveLength(1)
    const loaded = await getSessionStorageState(db, list[0].id)
    expect(loaded.cookies[0].value).toBe('NEW')
  })

  it('an expired session is not returned', async () => {
    await importSession(db, {
      userId: 'u1', profileId: 'pA', portalHost: 'mtsu.edu',
      storageState: STATE, expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    const found = await findValidSession(db, { profileId: 'pA', portalHost: 'mtsu.edu' })
    expect(found).toBeNull()
  })
})
