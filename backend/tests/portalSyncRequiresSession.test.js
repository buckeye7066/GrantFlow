/**
 * runPortalSync HONESTY GATE: a connector that declares requiresSession (SSO/2FA
 * portal like MTSU) must NOT run an unauthenticated, misleading "completed, 0
 * awards" sync when only a saved username/password exists. With no captured
 * session it must fail honestly (needs_session) BEFORE launching a browser, and
 * record the run as failed — so the user is told to do the side-by-side login,
 * not shown a false clean sync.
 */

import { describe, it, expect, beforeEach } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = 'd'.repeat(64)
process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'true'
delete process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST

const Database = (await import('better-sqlite3')).default

const { saveCredential, _resetCredentialSchemaCache } =
  await import('../services/hamilton/hamiltonPortalCredentialService.js')
const { runPortalSync, listRuns, ensurePortalSyncSchema, resolveConnector } =
  await import('../services/hamilton/portalSync/index.js')

function makeDb() { return new Database(':memory:') }

describe('runPortalSync — requiresSession honesty (real portals)', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    _resetCredentialSchemaCache()
  })

  it('MTSU with password and no session → needs_session (not controlled_beta_manual_handoff)', async () => {
    await saveCredential(db, {
      userId: 'u1', profileId: 'pA', portalHost: 'mtsu.edu',
      username: 'student@mtmail.mtsu.edu', password: 'pw-not-enough-for-sso',
    })

    const r = await runPortalSync(db, { profileId: 'pA', portalHost: 'mtsu.edu', direction: 'read', actorUserId: 'u1' })

    expect(r.ok).toBe(false)
    expect(r.needs_session).toBe(true)
    expect(r.error).toMatch(/captured login session/i)
    expect(r.error).not.toBe('controlled_beta_manual_handoff')
    expect(r.read).toBeUndefined()

    await ensurePortalSyncSchema(db).catch(() => {})
    const runs = await listRuns(db, { profileId: 'pA', portalHost: 'mtsu.edu' }).catch(() => [])
    expect(runs.some((row) => row.status === 'failed')).toBe(true)
  })

  it('EVERY connector without a real login workflow requires a captured session', () => {
    const mtsuC = resolveConnector({ host: 'mtsu.edu' })
    const genericC = resolveConnector({ host: 'example.com' })
    expect(mtsuC.id).toBe('mtsu')
    expect(mtsuC.requiresSession).toBe(true)
    expect(genericC.id).toBe('generic')
    expect(genericC.requiresSession).toBe(true)
  })

  it('a generic real portal with password and no session → needs_session', async () => {
    await saveCredential(db, {
      userId: 'u1', profileId: 'pB', portalHost: 'someportal.example.org',
      username: 'student@example.org', password: 'pw-cannot-log-in-by-itself',
    })

    const r = await runPortalSync(db, { profileId: 'pB', portalHost: 'someportal.example.org', direction: 'read', actorUserId: 'u1' })

    expect(r.ok).toBe(false)
    expect(r.needs_session).toBe(true)
    expect(r.error).toMatch(/captured login session/i)
    expect(r.error).not.toBe('controlled_beta_manual_handoff')
    expect(r.read).toBeUndefined()
  })
})
