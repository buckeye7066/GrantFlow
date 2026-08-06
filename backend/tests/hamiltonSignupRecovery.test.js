/**
 * Portal-account handoff + vault honesty — regression tests.
 *
 * 1. attemptPortalSignupRecovery never treats saved-login authority as authority
 *    to create a portal account. This bounded release ships no reviewed real-host
 *    signup adapter, so all such paths become a precise owner handoff.
 *
 * 2. describeAutopilotStateForPortal must NOT report a false "vault locked"
 *    after a process restart when the owner enabled AUTONOMOUS UNLOCK (#732) —
 *    the escrowed key lets Hamilton open the vault herself.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

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

  it('never invokes the legacy identity runner or credential fetcher without account-creation authority', async () => {
    const identityRunner = vi.fn()
    const credentialFetcher = vi.fn()
    const { outcome, credential, reason } = await attemptPortalSignupRecovery(db, {
      profileId: PID, url: URL,
      _identityRunner: identityRunner,
      _credentialFetcher: credentialFetcher,
    })
    expect(outcome).toMatchObject({ state: 'needs_user', blocker: 'create_portal_account' })
    expect(reason).toBe('account_creation_not_authorized')
    expect(credential).toBeNull()
    expect(identityRunner).not.toHaveBeenCalled()
    expect(credentialFetcher).not.toHaveBeenCalled()
  })

  it('requires both separate authority and a reviewed adapter before execution', async () => {
    const withoutAdapter = await attemptPortalSignupRecovery(db, {
      profileId: PID, url: URL, createPortalAccountAuthorized: true,
    })
    expect(withoutAdapter.reason).toBe('reviewed_signup_adapter_required')
    expect(withoutAdapter.credential).toBeNull()

    const disabledReviewed = await attemptPortalSignupRecovery(db, {
      profileId: PID, url: URL, createPortalAccountAuthorized: true,
      reviewedSignupAdapter: { reviewed: true, id: 'fixture-only' },
    })
    expect(disabledReviewed.reason).toBe('reviewed_signup_execution_not_enabled')
    expect(disabledReviewed.credential).toBeNull()
  })

  it('ignores throwing legacy seams and returns the safe handoff deterministically', async () => {
    const { outcome, credential } = await attemptPortalSignupRecovery(db, {
      profileId: PID, url: URL,
      _identityRunner: async () => { throw new Error('portal exploded') },
      _credentialFetcher: async () => { throw new Error('vault exploded') },
    })
    expect(outcome).toMatchObject({ state: 'needs_user', blocker: 'create_portal_account' })
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

  it('does not imply auto-account creation after a restart when autonomous vault unlock is escrowed', async () => {
    await setMasterPassphrase(db, { profileId: PID, passphrase: 'fixture-password-not-a-secret', autonomousUnlock: true })
    _resetUnlockCache() // simulate a process restart — runtime cache empty
    const st = await describeAutopilotStateForPortal(db, {
      profileId: PID, portalHost: 'scholarsapply.org', hasCredential: false, hasSession: false,
    })
    expect(st.state).toBe('needs_user')
    expect(st.canAutoMerge).toBe(false)
    expect(st.detail).toMatch(/create the portal account yourself/i)
  })

  it('does not expose vault state as the blocker when account creation itself is disabled', async () => {
    await setMasterPassphrase(db, { profileId: PID, passphrase: 'fixture-password-not-a-secret' }) // no escrow
    _resetUnlockCache()
    const st = await describeAutopilotStateForPortal(db, {
      profileId: PID, portalHost: 'scholarsapply.org', hasCredential: false, hasSession: false,
    })
    expect(st.state).toBe('needs_user')
    expect(st.canAutoMerge).toBe(false)
    expect(st.detail).toMatch(/create the portal account yourself/i)
  })
})
