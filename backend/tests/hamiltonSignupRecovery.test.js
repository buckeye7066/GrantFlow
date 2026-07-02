/**
 * Signup-instead-of-parking + vault autonomy — regression tests.
 *
 * 1. attemptPortalSignupRecovery: a login-blocked run with NO usable credential
 *    asks the Portal Autopilot Identity brain to CREATE the account, then
 *    re-reads the vault and retries — instead of parking on a human backoff.
 *    Compliance stays in the brain: any non-provisioned outcome (identity
 *    proofing, ToS block, CAPTCHA/2FA handoff) yields NO credential and the
 *    normal human path proceeds. Unusable credentials (vault-locked,
 *    pending-registration) are filtered.
 *
 * 2. describeAutopilotStateForPortal must NOT report a false "vault locked"
 *    after a process restart when the owner enabled AUTONOMOUS UNLOCK (#732) —
 *    the escrowed key lets Hamilton open the vault herself.
 */
import { describe, it, expect, beforeEach } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'a'.repeat(64)

const Database = (await import('better-sqlite3')).default
const { attemptPortalSignupRecovery } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')
const { describeAutopilotStateForPortal } = await import('../services/hamilton/hamiltonPortalAutopilotIdentity.js')
const {
  setMasterPassphrase,
  _resetMasterVaultSchemaCache,
  _resetUnlockCache,
} = await import('../services/hamilton/hamiltonPortalMasterVault.js')

const PID = 'profile-1'
const URL = 'https://apply.scholarsapply.org/login'

describe('attemptPortalSignupRecovery', () => {
  const db = {} // the helper only passes db through to the injected seams

  it('returns a usable credential after the brain auto-provisions the account', async () => {
    const cred = { id: 'c1', username: 'id@example.com', password: 'pw', vault_locked: false, pending_registration: false }
    const { outcome, credential } = await attemptPortalSignupRecovery(db, {
      profileId: PID, url: URL,
      _identityRunner: async () => ({ state: 'auto_provisioned', host: 'scholarsapply.org', detail: 'registered' }),
      _credentialFetcher: async () => cred,
    })
    expect(outcome.state).toBe('auto_provisioned')
    expect(credential).toBe(cred)
  })

  it('yields NO credential when the brain hands off to a human (compliance rails intact)', async () => {
    for (const state of ['needs_user', 'identity_proof_required', 'vault_locked', 'automation_disabled', 'waiting_for_email_verification']) {
      const { credential } = await attemptPortalSignupRecovery(db, {
        profileId: PID, url: URL,
        _identityRunner: async () => ({ state, host: 'scholarsapply.org' }),
        _credentialFetcher: async () => { throw new Error('must not be called') },
      })
      expect(credential).toBeNull()
    }
  })

  it('filters vault-locked and pending-registration credentials (not usable logins)', async () => {
    for (const cred of [
      { id: 'c1', password: null, vault_locked: true },
      { id: 'c2', password: 'pw', pending_registration: true },
    ]) {
      const { credential } = await attemptPortalSignupRecovery(db, {
        profileId: PID, url: URL,
        _identityRunner: async () => ({ state: 'has_existing_credentials', host: 'scholarsapply.org' }),
        _credentialFetcher: async () => cred,
      })
      expect(credential).toBeNull()
    }
  })

  it('never throws — a signup failure falls back to the normal backoff', async () => {
    const { outcome, credential } = await attemptPortalSignupRecovery(db, {
      profileId: PID, url: URL,
      _identityRunner: async () => { throw new Error('portal exploded') },
    })
    expect(outcome).toBeNull()
    expect(credential).toBeNull()
  })
})

describe('describeAutopilotStateForPortal + autonomous unlock', () => {
  let db
  beforeEach(() => {
    db = new Database(':memory:')
    db.dialect = 'sqlite'
    _resetMasterVaultSchemaCache()
    _resetUnlockCache()
  })

  it('does not report vault_locked after a restart when autonomous unlock is escrowed', async () => {
    await setMasterPassphrase(db, { profileId: PID, passphrase: 'Tennessee93!', autonomousUnlock: true })
    _resetUnlockCache() // simulate a process restart — runtime cache empty
    const st = await describeAutopilotStateForPortal(db, {
      profileId: PID, portalHost: 'scholarsapply.org', hasCredential: false, hasSession: false,
    })
    expect(st.state).not.toBe('vault_locked')
    expect(st.canAutoMerge).toBe(true) // ready to auto-provision
  })

  it('still reports vault_locked when there is no escrow (honest lock)', async () => {
    await setMasterPassphrase(db, { profileId: PID, passphrase: 'Tennessee93!' }) // no escrow
    _resetUnlockCache()
    const st = await describeAutopilotStateForPortal(db, {
      profileId: PID, portalHost: 'scholarsapply.org', hasCredential: false, hasSession: false,
    })
    expect(st.state).toBe('vault_locked')
  })
})
