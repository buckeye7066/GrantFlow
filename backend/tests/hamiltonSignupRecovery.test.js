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

  // These two pinned the pre-2026-08-20 posture, where account creation was
  // disabled by a constant so "create the portal account yourself" was the
  // answer to every question and the vault's real state could never surface.
  // Signup execution is now an env flag defaulting ON
  // (HAMILTON_PORTAL_SIGNUP_EXECUTION), so the honest answer is the VAULT's
  // actual state — which is strictly more informative, and is what the
  // dashboard needs in order to tell "unlock me" apart from "I cannot do this".
  it('reports READY TO AUTO-PROVISION after a restart when autonomous unlock is escrowed', async () => {
    await setMasterPassphrase(db, { profileId: PID, passphrase: 'fixture-password-not-a-secret', autonomousUnlock: true })
    _resetUnlockCache() // simulate a process restart — runtime cache empty
    const st = await describeAutopilotStateForPortal(db, {
      profileId: PID, portalHost: 'scholarsapply.org', hasCredential: false, hasSession: false,
    })
    // An escrowed vault opens without a human, so this is pending-automation and
    // deliberately NOT a co-browse terminal — co-browse stays the LAST resort.
    expect(st.canAutoMerge).toBe(true)
    expect(st.resolution).toBeNull()
    expect(st.detail).toMatch(/auto-provision/i)
  })

  it('reports the VAULT as the blocker when the vault is genuinely locked', async () => {
    await setMasterPassphrase(db, { profileId: PID, passphrase: 'fixture-password-not-a-secret' }) // no escrow
    _resetUnlockCache()
    const st = await describeAutopilotStateForPortal(db, {
      profileId: PID, portalHost: 'scholarsapply.org', hasCredential: false, hasSession: false,
    })
    expect(st.state).toBe('vault_locked')
    expect(st.canAutoMerge).toBe(false)
    expect(st.detail).toMatch(/unlock/i)
  })

  it('STILL refuses an identity-proofed host, whatever the signup flag says', async () => {
    await setMasterPassphrase(db, { profileId: PID, passphrase: 'fixture-password-not-a-secret', autonomousUnlock: true })
    const st = await describeAutopilotStateForPortal(db, {
      profileId: PID, portalHost: 'studentaid.gov', hasCredential: false, hasSession: false,
    })
    expect(st.state).toBe('identity_proof_required')
    expect(st.canAutoMerge).toBe(false)
    expect(st.resolution).toBe('side_by_side_cobrowse')
  })
})
