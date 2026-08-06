import { describe, expect, it, vi } from 'vitest'

import { attemptPortalSignupRecovery } from '../services/hamilton/hamiltonAutomationOrchestrator.js'
import {
  automaticMailboxVerificationEnabled,
  completeEmailVerification,
  extractConfirmationLink,
  registerOnPortal,
  recheckEmailVerification,
  reviewedPortalSignupExecutionEnabled,
} from '../services/hamilton/hamiltonPortalSignupAdapter.js'
import {
  reviewedPortalAccountCreationEnabled,
} from '../services/hamilton/hamiltonPortalAutopilotIdentity.js'

describe('Hamilton portal-account and activation authority boundary', () => {
  it('never converts saved-credential authority into portal-account creation', async () => {
    const identityRunner = vi.fn()
    const credentialFetcher = vi.fn()
    const result = await attemptPortalSignupRecovery({}, {
      profileId: 'profile-1', userId: 'user-1',
      url: 'https://portal.example.org/register',
      createPortalAccountAuthorized: false,
      _identityRunner: identityRunner, _credentialFetcher: credentialFetcher,
    })
    expect(result).toMatchObject({ credential: null, reason: 'account_creation_not_authorized' })
    expect(identityRunner).not.toHaveBeenCalled()
    expect(credentialFetcher).not.toHaveBeenCalled()
  })

  it('requires a reviewed host-specific adapter even after separate account-creation authority', async () => {
    const identityRunner = vi.fn()
    const result = await attemptPortalSignupRecovery({}, {
      profileId: 'profile-1', userId: 'user-1',
      url: 'https://portal.example.org/register',
      createPortalAccountAuthorized: true,
      reviewedSignupAdapter: null,
      _identityRunner: identityRunner,
    })
    expect(result).toMatchObject({ credential: null, reason: 'reviewed_signup_adapter_required' })
    expect(identityRunner).not.toHaveBeenCalled()
  })

  it.each([
    ['unknown host', 'https://unknown.example/register'],
    ['inline terms form', 'https://portal.example.org/register?terms=inline'],
    ['redirect-shaped target', 'https://portal.example.org/register?next=https://attacker.example'],
  ])('ships zero automatic registration for %s', async (_label, signupUrl) => {
    const launchBrowser = vi.fn()
    const result = await registerOnPortal({}, {
      portalHost: new URL(signupUrl).hostname,
      signupUrl,
      identity: { email: 'sentinel@example.org', password: 'PASSWORD-CANARY' },
      launchBrowser,
    })
    expect(reviewedPortalSignupExecutionEnabled()).toBe(false)
    expect(result).toMatchObject({ status: 'blocked', blockerType: 'create_portal_account' })
    expect(launchBrowser).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('PASSWORD-CANARY')
  })

  it('keeps direct identity orchestration in human handoff even with a forged reviewed flag', async () => {
    expect(reviewedPortalAccountCreationEnabled()).toBe(false)
    const identityRunner = vi.fn()
    const result = await attemptPortalSignupRecovery({}, {
      profileId: 'profile-1', userId: 'user-1', portalHost: 'portal.example.org',
      createPortalAccountAuthorized: true,
      reviewedSignupAdapter: { reviewed: true },
      url: 'https://portal.example.org/register',
      _identityRunner: identityRunner,
    })
    expect(result).toMatchObject({ credential: null, reason: 'reviewed_signup_execution_not_enabled' })
    expect(identityRunner).not.toHaveBeenCalled()
  })

  it('does not read mail, follow links, or expose activation tokens', async () => {
    const provider = { listInboxMessages: vi.fn() }
    const browserContext = { newPage: vi.fn() }
    const result = await completeEmailVerification({
      identityEmail: 'sentinel@example.org', portalHost: 'portal.example.org',
      outlookProvider: provider, browserContext,
    })
    expect(automaticMailboxVerificationEnabled()).toBe(false)
    expect(result).toMatchObject({
      status: 'verification_pending', blocker_kind: 'manual_email_verification_required',
    })
    expect(provider.listInboxMessages).not.toHaveBeenCalled()
    expect(browserContext.newPage).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('sentinel@example.org')
  })

  it('never falls back to arbitrary unsubscribe/internal links and recheck opens no browser', async () => {
    expect(extractConfirmationLink('<a href="https://attacker.example/unsubscribe?token=SECRET">click</a>')).toBeNull()
    expect(extractConfirmationLink('https://169.254.169.254/latest/meta-data')).toBeNull()
    const launchBrowser = vi.fn()
    const result = await recheckEmailVerification({}, {
      portalHost: 'portal.example.org', identityEmail: 'sentinel@example.org', launchBrowser,
    })
    expect(result).toMatchObject({ blocker_kind: 'manual_email_verification_required' })
    expect(launchBrowser).not.toHaveBeenCalled()
  })
})
