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

describe('runPortalSync — requiresSession honesty gate', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    _resetCredentialSchemaCache()
  })

  it('MTSU with only a saved password (no session) fails honestly — never a misleading empty sync', async () => {
    // A saved login exists, but NO captured session.
    await saveCredential(db, {
      userId: 'u1', profileId: 'pA', portalHost: 'mtsu.edu',
      username: 'student@mtmail.mtsu.edu', password: 'pw-not-enough-for-sso',
    })

    const r = await runPortalSync(db, { profileId: 'pA', portalHost: 'mtsu.edu', direction: 'read', actorUserId: 'u1' })

    expect(r.ok).toBe(false)
    expect(r.needs_session).toBe(true)
    expect(r.connectorId).toBe('mtsu')
    expect(r.error).toMatch(/captured login session|side-by-side/i)
    // It must NOT report any read results (it never authenticated).
    expect(r.read).toBeUndefined()

    // The run is recorded as failed, not completed — observability stays honest.
    await ensurePortalSyncSchema(db).catch(() => {})
    const runs = await listRuns(db, { profileId: 'pA', portalHost: 'mtsu.edu' }).catch(() => [])
    expect(runs.length).toBeGreaterThan(0)
    expect(runs[0].status).toBe('failed')
  })

  it('the gate is connector-scoped: MTSU requires a session, the generic connector does not', () => {
    // Deterministic (no browser/network): MTSU declares requiresSession so the
    // honesty gate fires; the generic connector that handles any other host does
    // NOT, so non-SSO portals are unaffected by the gate.
    const mtsuC = resolveConnector({ host: 'mtsu.edu' })
    const genericC = resolveConnector({ host: 'example.com' })
    expect(mtsuC.id).toBe('mtsu')
    expect(mtsuC.requiresSession).toBe(true)
    expect(genericC.requiresSession).toBeFalsy()
  })
})
