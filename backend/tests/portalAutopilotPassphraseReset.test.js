/**
 * Regression tests for the Portal Autopilot passphrase RESET recovery path.
 *
 * Before the fix, once a master passphrase was set the UI only offered "unlock":
 * a forgotten/unverifiable passphrase was a permanent dead end. The recovery path
 * lets the owner set a NEW passphrase (a true rotation). Because this route never
 * re-wraps with the old passphrase, the previously auto-provisioned (master-
 * wrapped) secrets become permanently unreadable AND would never regenerate
 * (saveAutoProvisionedCredential short-circuits on already_existed), so the reset
 * must purge them. User-entered / server-vault-only logins must survive.
 */

import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

const profilePortalsRouter = (await import('../routes/profilePortals.js')).default
const { attachRequestContext } = await import('../middleware/requestContext.js')
const {
  setMasterPassphrase,
  getUnlockedKey,
  _resetMasterVaultSchemaCache,
  _resetUnlockCache,
} = await import('../services/hamilton/hamiltonPortalMasterVault.js')
const {
  saveCredential,
  saveAutoProvisionedCredential,
  listCredentialsForProfile,
  _resetCredentialSchemaCache,
} = await import('../services/hamilton/hamiltonPortalCredentialService.js')

const PROFILE_ID = 'c4a92724-9cee-416f-ba30-e91b9b5cd885'

function createApp(db) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    // Validated synthetic ADMIN_TOKEN identity → req.ctx.isAdmin=true (DB-backed
    // context now fails closed for any other unresolved role:'admin' token).
    req.user = { role: 'admin', is_admin: true, userId: 'system_admin_token' }
    next()
  })
  // Mirror prod: admin authority is DB-backed via attachRequestContext.
  app.use(attachRequestContext())
  app.use('/api', profilePortalsRouter)
  return app
}

describe('POST /api/profiles/:id/portal-autopilot/passphrase — reset recovery', () => {
  let db
  beforeEach(() => {
    db = new Database(':memory:')
    db.dialect = 'sqlite'
    _resetMasterVaultSchemaCache()
    _resetCredentialSchemaCache()
    _resetUnlockCache()
  })

  it('resetting purges orphaned master-wrapped logins, keeps user logins, and unlocks with the NEW passphrase', async () => {
    // Vault set with the OLD passphrase + one auto-provisioned (master-wrapped)
    // login and one user-entered login.
    await setMasterPassphrase(db, { profileId: PROFILE_ID, passphrase: 'old-secret-1' })
    const masterKey = getUnlockedKey(PROFILE_ID)
    expect(masterKey).toBeTruthy()
    await saveAutoProvisionedCredential(db, {
      userId: 'admin-1', profileId: PROFILE_ID, portalHost: 'grants.example.org',
      username: 'tishka@icloud.com', masterKey, loginUrl: 'https://grants.example.org/login',
    })
    await saveCredential(db, {
      userId: 'admin-1', profileId: PROFILE_ID, portalHost: 'mtsu.edu',
      username: 'student@mtsu.edu', password: 'user-typed-pw', managedBy: 'user',
    })

    const before = await listCredentialsForProfile(db, PROFILE_ID)
    expect(before).toHaveLength(2)

    const app = createApp(db)
    const res = await request(app)
      .post(`/api/profiles/${PROFILE_ID}/portal-autopilot/passphrase`)
      .send({ passphrase: 'brand-new-secret-2' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.reset).toBe(true)
    expect(res.body.purged_logins).toBe(1)

    // Master-wrapped (auto-provisioned) row gone; user-entered row survives.
    const after = await listCredentialsForProfile(db, PROFILE_ID)
    expect(after).toHaveLength(1)
    expect(after[0].portal_host).toBe('mtsu.edu')

    // The owner can now unlock with the NEW passphrase (the dead end is gone).
    _resetUnlockCache()
    const unlock = await request(app)
      .post(`/api/profiles/${PROFILE_ID}/portal-autopilot/unlock`)
      .send({ passphrase: 'brand-new-secret-2' })
    expect(unlock.status).toBe(200)
    expect(unlock.body.ok).toBe(true)
  })

  it('first-time SET (no existing passphrase) does not report a reset or purge', async () => {
    const app = createApp(db)
    const res = await request(app)
      .post(`/api/profiles/${PROFILE_ID}/portal-autopilot/passphrase`)
      .send({ passphrase: 'first-secret-1' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.reset).toBe(false)
    expect(res.body.purged_logins).toBe(0)
  })
})
