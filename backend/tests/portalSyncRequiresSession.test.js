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

describe('runPortalSync — controlled-beta real-portal boundary', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    _resetCredentialSchemaCache()
  })

  it('MTSU fails closed to manual handoff before a browser or run can start', async () => {
    // A saved login exists, but NO captured session.
    await saveCredential(db, {
      userId: 'u1', profileId: 'pA', portalHost: 'mtsu.edu',
      username: 'student@mtmail.mtsu.edu', password: 'pw-not-enough-for-sso',
    })

    const r = await runPortalSync(db, { profileId: 'pA', portalHost: 'mtsu.edu', direction: 'read', actorUserId: 'u1' })

    expect(r.ok).toBe(false)
    expect(r.requires_human_handoff).toBe(true)
    expect(r.connectorId).toBeNull()
    expect(r.error).toBe('controlled_beta_manual_handoff')
    expect(r.read).toBeUndefined()

    // No automation run is created for a browser operation we refused.
    await ensurePortalSyncSchema(db).catch(() => {})
    const runs = await listRuns(db, { profileId: 'pA', portalHost: 'mtsu.edu' }).catch(() => [])
    expect(runs).toHaveLength(0)
  })

  it('EVERY connector without a real login workflow requires a captured session', () => {
    // Deterministic (no browser/network). The generic connector never fills a
    // login form, so a saved password cannot authenticate anything through it —
    // it used to declare requiresSession falsy, letting a password-only sync
    // land on a login wall, extract nothing, and record a misleading clean
    // "completed" (2026-07-28 audit). Both connectors now demand the captured
    // session the sync actually needs.
    const mtsuC = resolveConnector({ host: 'mtsu.edu' })
    const genericC = resolveConnector({ host: 'example.com' })
    expect(mtsuC.id).toBe('mtsu')
    expect(mtsuC.requiresSession).toBe(true)
    expect(genericC.id).toBe('generic')
    expect(genericC.requiresSession).toBe(true)
  })

  it('a generic real portal also fails closed before connector/browser work', async () => {
    await saveCredential(db, {
      userId: 'u1', profileId: 'pB', portalHost: 'someportal.example.org',
      username: 'student@example.org', password: 'pw-cannot-log-in-by-itself',
    })

    const r = await runPortalSync(db, { profileId: 'pB', portalHost: 'someportal.example.org', direction: 'read', actorUserId: 'u1' })

    expect(r.ok).toBe(false)
    expect(r.requires_human_handoff).toBe(true)
    expect(r.error).toBe('controlled_beta_manual_handoff')
    expect(r.connectorId).toBeNull()
    expect(r.read).toBeUndefined()
  })
})
