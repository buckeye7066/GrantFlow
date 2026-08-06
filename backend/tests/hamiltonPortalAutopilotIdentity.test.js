/**
 * Unit tests for the Portal Autopilot Identity feature:
 *   - master-passphrase KDF: wrap/unwrap round-trip + wrong-passphrase rejection
 *   - unique per-portal password generation (never reused)
 *   - identity-proofed portal → session-capture handoff (no registration)
 *   - existing-credential path skips registration
 *   - vault-locked path blocks a new registration with a clear status
 *
 * The automation / blocker layer is exercised purely through the engine's policy
 * decisions — no network and no real browser are touched (browser automation is
 * disabled by not setting HAMILTON_ENABLE_BROWSER_AUTOMATION; identity-proof /
 * existing-cred / vault-locked paths are decided BEFORE any browser gate anyway).
 */

import { describe, it, expect, beforeEach } from 'vitest'

// Encryption key (32 bytes as 64 hex chars) + admin vault id must exist before
// the credential service module derives a key.
process.env.RUNTIME_SECRETS_KEY = 'b'.repeat(64)
process.env.HAMILTON_ADMIN_VAULT_PROFILE_ID = 'owner-vault'
// Ensure browser automation is OFF so the engine's automation gate is exercised
// (and never tries to open a browser in a unit test).
delete process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
delete process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST

const Database = (await import('better-sqlite3')).default

const masterVault = await import('../services/hamilton/hamiltonPortalMasterVault.js')
const {
  setMasterPassphrase, unlockVault, getUnlockedKey, lockVault,
  wrapSecretWithKey, unwrapSecretWithKey, getMasterVaultStatus,
  setAutopilotIdentity, _resetMasterVaultSchemaCache, _resetUnlockCache,
} = masterVault

const credService = await import('../services/hamilton/hamiltonPortalCredentialService.js')
const {
  generateStrongPassword, saveAutoProvisionedCredential, saveCredential,
  getDecryptedCredential, _resetCredentialSchemaCache,
} = credService

const {
  runAutopilotIdentityForPortal, AUTOPILOT_STATE,
} = await import('../services/hamilton/hamiltonPortalAutopilotIdentity.js')

const { isIdentityProofedHost } = await import('../services/hamilton/hamiltonPortalPolicyRegistry.js')

function makeDb() {
  return new Database(':memory:')
}

describe('master passphrase KDF + wrap/unwrap', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    _resetMasterVaultSchemaCache()
    _resetUnlockCache()
  })

  it('wraps and unwraps a secret round-trip with the derived key', async () => {
    const { key } = await setMasterPassphrase(db, { profileId: 'pA', passphrase: 'correct horse battery' })
    const wrapped = wrapSecretWithKey('s3cr3t-portal-pw', key)
    expect(wrapped.wrapped_ciphertext).toBeTruthy()
    // ciphertext must not contain the plaintext
    expect(wrapped.wrapped_ciphertext).not.toContain('s3cr3t')
    const back = unwrapSecretWithKey(wrapped, key)
    expect(back).toBe('s3cr3t-portal-pw')
  })

  it('rejects the WRONG passphrase on unlock (and a wrong key fails to unwrap)', async () => {
    const { key } = await setMasterPassphrase(db, { profileId: 'pA', passphrase: 'right-passphrase' })
    const wrapped = wrapSecretWithKey('pw', key)
    // wrong passphrase → unlock fails, no key
    const bad = await unlockVault(db, { profileId: 'pA', passphrase: 'wrong-passphrase' })
    expect(bad.ok).toBe(false)
    expect(bad.key).toBeNull()
    // a wrong derived key cannot unwrap (GCM auth failure throws)
    const wrong = await setMasterPassphrase(db, { profileId: 'pB', passphrase: 'some-other-pass' })
    expect(() => unwrapSecretWithKey(wrapped, wrong.key)).toThrow()
  })

  it('unlocks with the RIGHT passphrase and caches the key in the runtime vault', async () => {
    await setMasterPassphrase(db, { profileId: 'pA', passphrase: 'unlock-me-please' })
    lockVault('pA')
    expect(getUnlockedKey('pA')).toBeNull()
    const ok = await unlockVault(db, { profileId: 'pA', passphrase: 'unlock-me-please' })
    expect(ok.ok).toBe(true)
    expect(getUnlockedKey('pA')).not.toBeNull()
  })

  it('status reports has_passphrase + is_unlocked without leaking secrets', async () => {
    await setAutopilotIdentity(db, { profileId: 'pA', identityEmail: 'auto@example.com' })
    let st = await getMasterVaultStatus(db, 'pA')
    expect(st.has_passphrase).toBe(false)
    expect(st.identity_email).toBe('auto@example.com')
    await setMasterPassphrase(db, { profileId: 'pA', passphrase: 'a-good-passphrase' })
    st = await getMasterVaultStatus(db, 'pA')
    expect(st.has_passphrase).toBe(true)
    expect(st.is_unlocked).toBe(true)
    // never exposes salt/verifier
    expect(st.salt).toBeUndefined()
    expect(st.verifier).toBeUndefined()
  })
})

describe('unique per-portal password generation', () => {
  it('generates distinct strong passwords every call (never reused)', () => {
    const seen = new Set()
    for (let i = 0; i < 200; i += 1) {
      const pw = generateStrongPassword()
      expect(pw.length).toBe(28)
      // one of each class
      expect(/[A-Z]/.test(pw)).toBe(true)
      expect(/[a-z]/.test(pw)).toBe(true)
      expect(/[0-9]/.test(pw)).toBe(true)
      seen.add(pw)
    }
    expect(seen.size).toBe(200) // all unique
  })
})

describe('saveAutoProvisionedCredential (master-wrapped, unique passwords)', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    _resetMasterVaultSchemaCache()
    _resetCredentialSchemaCache()
    _resetUnlockCache()
  })

  it('stores a unique master-wrapped password recoverable only when unlocked', async () => {
    const { key } = await setMasterPassphrase(db, { profileId: 'pA', passphrase: 'master-pass-1' })
    const res = await saveAutoProvisionedCredential(db, {
      userId: 'u1', profileId: 'pA', portalHost: 'scholarships.example.org',
      username: 'auto@example.com', masterKey: key,
    })
    expect(res.already_existed).toBe(false)
    expect(res.password_one_time_view).toBeTruthy()
    expect(res.credential.has_master_wrap).toBe(true)
    // server vault key alone is NOT enough — the row has no password_ciphertext.
    const raw = await db.prepare('SELECT password_ciphertext, wrapped_ciphertext FROM hamilton_portal_credentials WHERE profile_id = ?').get('pA')
    expect(raw.password_ciphertext === null || raw.password_ciphertext === undefined).toBe(true)
    expect(raw.wrapped_ciphertext).toBeTruthy()
    // UNLOCKED: getDecryptedCredential returns the same plaintext.
    const dec = await getDecryptedCredential(db, { profileId: 'pA', portalHost: 'scholarships.example.org' })
    expect(dec.password).toBe(res.password_one_time_view)
    // LOCKED: returns vault_locked sentinel, no password.
    lockVault('pA')
    const locked = await getDecryptedCredential(db, { profileId: 'pA', portalHost: 'scholarships.example.org' })
    expect(locked.vault_locked).toBe(true)
    expect(locked.password).toBeNull()
  })

  it('is idempotent — does not rotate an existing login', async () => {
    const { key } = await setMasterPassphrase(db, { profileId: 'pA', passphrase: 'master-pass-1' })
    await saveAutoProvisionedCredential(db, { userId: 'u1', profileId: 'pA', portalHost: 'x.example.org', username: 'a@b.com', masterKey: key })
    const second = await saveAutoProvisionedCredential(db, { userId: 'u1', profileId: 'pA', portalHost: 'x.example.org', username: 'a@b.com', masterKey: key })
    expect(second.already_existed).toBe(true)
    expect(second.password_one_time_view).toBeNull()
  })
})

describe('autopilot identity state machine', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    _resetMasterVaultSchemaCache()
    _resetCredentialSchemaCache()
    _resetUnlockCache()
  })

  it('classifies identity-proofed hosts', () => {
    expect(isIdentityProofedHost('studentaid.gov')).toBe(true)
    expect(isIdentityProofedHost('login.gov')).toBe(true)
    expect(isIdentityProofedHost('id.me')).toBe(true)
    expect(isIdentityProofedHost('my.login.gov')).toBe(true)
    expect(isIdentityProofedHost('mtsu.edu')).toBe(false)
  })

  it('IDENTITY-PROOFED portal → hands off to session capture (no registration)', async () => {
    await setMasterPassphrase(db, { profileId: 'pA', passphrase: 'master-pass-1' })
    const r = await runAutopilotIdentityForPortal(db, {
      profileId: 'pA', userId: 'u1', portalHost: 'studentaid.gov', loginUrl: 'https://studentaid.gov/login',
    })
    expect(r.state).toBe(AUTOPILOT_STATE.IDENTITY_PROOF_REQUIRED)
    // no credential was provisioned
    const cred = await getDecryptedCredential(db, { profileId: 'pA', portalHost: 'studentaid.gov' })
    expect(cred).toBeNull()
    // a session-capture request WAS queued (graceful handoff)
    const reqs = await db.prepare('SELECT * FROM hamilton_session_capture_requests WHERE profile_id = ?').all('pA')
    expect(reqs.length).toBe(1)
    expect(reqs[0].portal_host).toBe('studentaid.gov')
  })

  it('EXISTING credentials → skips registration (has_existing_credentials)', async () => {
    // A profile already has a saved login for this host.
    await saveCredential(db, {
      userId: 'u1', profileId: 'pA', portalHost: 'awardspring.com',
      username: 'student@example.com', password: 'already-set',
    })
    await setMasterPassphrase(db, { profileId: 'pA', passphrase: 'master-pass-1' })
    const r = await runAutopilotIdentityForPortal(db, {
      profileId: 'pA', userId: 'u1', portalHost: 'awardspring.com',
    })
    expect(r.state).toBe(AUTOPILOT_STATE.HAS_EXISTING_CREDENTIALS)
    // exactly one credential row — no duplicate account
    const rows = await db.prepare('SELECT * FROM hamilton_portal_credentials WHERE profile_id = ? AND portal_host = ?').all('pA', 'awardspring.com')
    expect(rows.length).toBe(1)
  })

  it('account-creation boundary wins before vault state for a new registration', async () => {
    await setMasterPassphrase(db, { profileId: 'pA', passphrase: 'master-pass-1' })
    lockVault('pA') // passphrase set but not unlocked
    const r = await runAutopilotIdentityForPortal(db, {
      profileId: 'pA', userId: 'u1', portalHost: 'communityforce.com',
    })
    expect(r.state).toBe(AUTOPILOT_STATE.NEEDS_USER)
    expect(r.blocker).toBe('create_portal_account')
    expect(r.detail).toMatch(/does not authorize|create.*yourself/i)
    // no credential provisioned while locked
    const rows = await db.prepare('SELECT * FROM hamilton_portal_credentials WHERE profile_id = ?').all('pA')
    expect(rows.length).toBe(0)
  })

  it('NO PASSPHRASE set → cannot provision; needs_user / vault_locked, no credential', async () => {
    // Browser automation is off, but even with it on, a non-identity-proofed host
    // with no passphrase cannot be auto-provisioned.
    const r = await runAutopilotIdentityForPortal(db, {
      profileId: 'pNoPass', userId: 'u1', portalHost: 'communityforce.com',
    })
    expect([AUTOPILOT_STATE.VAULT_LOCKED, AUTOPILOT_STATE.AUTOMATION_DISABLED, AUTOPILOT_STATE.NEEDS_USER]).toContain(r.state)
    const rows = await db.prepare('SELECT * FROM hamilton_portal_credentials WHERE profile_id = ?').all('pNoPass')
    expect(rows.length).toBe(0)
  })
})
