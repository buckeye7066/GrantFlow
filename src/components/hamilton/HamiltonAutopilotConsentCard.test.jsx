// @vitest-environment jsdom
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getAuthorizationsMock,
  grantAuthorizationMock,
  revokeAuthorizationMock,
  getVaultStatusMock,
  beginAutomationMock,
  toastMock,
} = vi.hoisted(() => ({
  getAuthorizationsMock: vi.fn(),
  grantAuthorizationMock: vi.fn(),
  revokeAuthorizationMock: vi.fn(),
  getVaultStatusMock: vi.fn(),
  beginAutomationMock: vi.fn(),
  toastMock: vi.fn(),
}))

vi.mock('@/api/hamilton', () => ({
  getHamiltonAuthorizations: (...args) => getAuthorizationsMock(...args),
  grantHamiltonAuthorization: (...args) => grantAuthorizationMock(...args),
  revokeHamiltonAuthorization: (...args) => revokeAuthorizationMock(...args),
  getPortalVaultStatus: (...args) => getVaultStatusMock(...args),
  enableAutonomousUnlock: vi.fn(),
  disableAutonomousUnlock: vi.fn(),
  beginHamiltonAutomation: (...args) => beginAutomationMock(...args),
}))

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

import HamiltonAutopilotConsentCard from './HamiltonAutopilotConsentCard.jsx'

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <HamiltonAutopilotConsentCard profileId="profile-1" />
    </QueryClientProvider>,
  )
}

describe('HamiltonAutopilotConsentCard final-submit boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAuthorizationsMock.mockResolvedValue({ active: [] })
    beginAutomationMock.mockResolvedValue({ ok: true, queued: true, queued_count: 3 })
    getVaultStatusMock.mockResolvedValue({
      vault: { has_passphrase: false, autonomous_unlock: false },
    })
    revokeAuthorizationMock.mockResolvedValue({ ok: true })
  })

  it('exposes a real switch that GRANTS submit authority', async () => {
    // This card used to render a static "Final portal Submit stays with you"
    // paragraph and a revoke-only button, so full automation could be turned
    // OFF from the profile but never ON. Owner order 2026-08-20.
    renderCard()

    const submitSwitch = await screen.findByRole('switch', {
      name: /allow hamilton to submit applications/i,
    })
    fireEvent.click(submitSwitch)

    await waitFor(() => expect(grantAuthorizationMock).toHaveBeenCalled())
    const call = grantAuthorizationMock.mock.calls[0][0]
    expect(call.authorizationTypes).toContain('submit_applications')
  })

  it('full automation sends the auto-submit OPTION, not a bogus type', async () => {
    // `allow_auto_submit` is an OPTION on the grant row, never one of
    // HAMILTON_AUTHORIZATION_TYPES. Sending it as a type grants nothing and
    // silently leaves automation off.
    renderCard()

    fireEvent.click(await screen.findByRole('switch', {
      name: /allow hamilton full automation/i,
    }))

    await waitFor(() => expect(grantAuthorizationMock).toHaveBeenCalled())
    const call = grantAuthorizationMock.mock.calls[0][0]
    expect(call.authorizationTypes).toContain('submit_applications')
    expect(call.authorizationTypes).not.toContain('allow_auto_submit')
    expect(call.options.allow_auto_submit).toBe(true)
    expect(call.options.require_human_review).toBe(false)
  })

  it('turning ON submit does not silently revoke the sign-in consent', async () => {
    // The authorize route hardcodes replaceOmittedTypes:true, so a grant is a
    // REPLACEMENT of the whole set - sending one type drops the others.
    getAuthorizationsMock.mockResolvedValue({
      active: [{
        id: 'login-auth',
        profile_id: 'profile-1',
        scope: 'profile',
        authorization_type: 'use_saved_credentials_reference',
        revoked_at: null,
        options: {},
      }],
    })
    renderCard()

    fireEvent.click(await screen.findByRole('switch', {
      name: /allow hamilton to submit applications/i,
    }))

    await waitFor(() => expect(grantAuthorizationMock).toHaveBeenCalled())
    const call = grantAuthorizationMock.mock.calls[0][0]
    expect(call.authorizationTypes).toContain('use_saved_credentials_reference')
    expect(call.authorizationTypes).toContain('submit_applications')
  })

  it('turning full automation OFF clears the auto-submit flag', async () => {
    getAuthorizationsMock.mockResolvedValue({
      active: [{
        id: 'submit-auth',
        profile_id: 'profile-1',
        scope: 'profile',
        authorization_type: 'submit_applications',
        revoked_at: null,
        options: { allow_auto_submit: true },
      }],
    })
    renderCard()

    const fullSwitch = await screen.findByRole('switch', {
      name: /allow hamilton full automation/i,
    })
    fireEvent.click(fullSwitch)

    // Only submit_applications was active, so nothing remains to authorize and
    // the card withdraws the grant outright.
    await waitFor(() => {
      expect(revokeAuthorizationMock).toHaveBeenCalledWith('submit-auth', 'user_toggled_off')
    })
  })

  it('shows NO start button until full automation is actually on', async () => {
    // A button that cannot lawfully run reads as a capability the profile
    // does not have.
    renderCard()
    await screen.findByRole('switch', { name: /allow hamilton full automation/i })
    expect(screen.queryByRole('button', { name: /begin automation/i })).toBeNull()
  })

  it('offers "Begin automation" once full automation is on, and starts a run', async () => {
    getAuthorizationsMock.mockResolvedValue({
      active: [{
        id: 'submit-auth',
        profile_id: 'profile-1',
        scope: 'profile',
        authorization_type: 'submit_applications',
        revoked_at: null,
        options: { allow_auto_submit: true },
      }],
    })
    renderCard()

    const start = await screen.findByRole('button', { name: /begin automation/i })
    fireEvent.click(start)

    await waitFor(() => expect(beginAutomationMock).toHaveBeenCalledWith('profile-1'))
  })
})
