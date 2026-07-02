/**
 * Saved-session lookup must match by REGISTRABLE DOMAIN (eTLD+1) — the same
 * rule the credential vault uses — so a session the user captured on
 * `mtsu.edu` is found when a run lands on `login.mtsu.edu` (and vice versa).
 * Exact-host-only matching silently hid working sessions and hard-stopped
 * unattended runs the vault could have satisfied.
 *
 * Pins: exact host preferred; domain-level fallback; PSL safety (no
 * cross-registrable-domain leak); an expired exact-host session does not mask
 * a valid domain-level one.
 */
import { describe, it, expect, beforeEach } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'a'.repeat(64)

const Database = (await import('better-sqlite3')).default
const {
  importSession,
  findValidSession,
  _resetCredentialSchemaCache,
} = await import('../services/hamilton/hamiltonCredentialSessionService.js')

const STATE = { cookies: [{ name: 'session', value: 'x' }], origins: [] }
const PID = 'profile-1'

describe('findValidSession registrable-domain matching', () => {
  let db
  beforeEach(() => {
    db = new Database(':memory:')
    db.dialect = 'sqlite'
    _resetCredentialSchemaCache()
  })

  it('finds a session saved on the apex when the run lands on a subdomain', async () => {
    await importSession(db, { userId: 'u1', profileId: PID, portalHost: 'mtsu.edu', storageState: STATE })
    const found = await findValidSession(db, { profileId: PID, portalHost: 'https://login.mtsu.edu/cas' })
    expect(found).not.toBeNull()
    expect(found.portal_host).toBe('mtsu.edu')
  })

  it('finds a session saved on a subdomain when the run lands on the apex', async () => {
    await importSession(db, { userId: 'u1', profileId: PID, portalHost: 'pipelinemt.mtsu.edu', storageState: STATE })
    const found = await findValidSession(db, { profileId: PID, portalHost: 'mtsu.edu' })
    expect(found).not.toBeNull()
    expect(found.portal_host).toBe('pipelinemt.mtsu.edu')
  })

  it('prefers the exact host over a domain-level match', async () => {
    await importSession(db, { userId: 'u1', profileId: PID, portalHost: 'mtsu.edu', storageState: STATE })
    await importSession(db, { userId: 'u1', profileId: PID, portalHost: 'login.mtsu.edu', storageState: STATE })
    const found = await findValidSession(db, { profileId: PID, portalHost: 'login.mtsu.edu' })
    expect(found.portal_host).toBe('login.mtsu.edu')
  })

  it('never leaks a session across unrelated registrable domains', async () => {
    await importSession(db, { userId: 'u1', profileId: PID, portalHost: 'foo.example.com', storageState: STATE })
    expect(await findValidSession(db, { profileId: PID, portalHost: 'bar.other.com' })).toBeNull()
  })

  it('an expired exact-host session does not mask a valid domain-level session', async () => {
    await importSession(db, {
      userId: 'u1', profileId: PID, portalHost: 'login.mtsu.edu', storageState: STATE,
      expiresAt: new Date(Date.now() - 3600_000).toISOString(), // already expired
    })
    await importSession(db, { userId: 'u1', profileId: PID, portalHost: 'mtsu.edu', storageState: STATE })
    const found = await findValidSession(db, { profileId: PID, portalHost: 'login.mtsu.edu' })
    expect(found).not.toBeNull()
    expect(found.portal_host).toBe('mtsu.edu')
    // ...and the expired row was marked expired, not silently left 'valid'.
    const row = await db.prepare(`SELECT status FROM hamilton_saved_sessions WHERE portal_host = 'login.mtsu.edu'`).get()
    expect(row.status).toBe('expired')
  })
})
