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
  toastMock,
} = vi.hoisted(() => ({
  getAuthorizationsMock: vi.fn(),
  grantAuthorizationMock: vi.fn(),
  revokeAuthorizationMock: vi.fn(),
  getVaultStatusMock: vi.fn(),
  toastMock: vi.fn(),
}))

vi.mock('@/api/hamilton', () => ({
  getHamiltonAuthorizations: (...args) => getAuthorizationsMock(...args),
  grantHamiltonAuthorization: (...args) => grantAuthorizationMock(...args),
  revokeHamiltonAuthorization: (...args) => revokeAuthorizationMock(...args),
  getPortalVaultStatus: (...args) => getVaultStatusMock(...args),
  enableAutonomousUnlock: vi.fn(),
  disableAutonomousUnlock: vi.fn(),
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
    getVaultStatusMock.mockResolvedValue({
      vault: { has_passphrase: false, autonomous_unlock: false },
    })
    revokeAuthorizationMock.mockResolvedValue({ ok: true })
  })

  it('offers draft preparation but no control that grants submit authority', async () => {
    renderCard()

    expect(await screen.findByText(/final portal submit stays with you/i)).toBeTruthy()
    expect(screen.queryByRole('switch', { name: /submit/i })).toBeNull()
    expect(screen.queryByText(/also submit finished applications/i)).toBeNull()
    expect(grantAuthorizationMock).not.toHaveBeenCalled()
  })

  it('can only revoke a retired profile-wide submit grant', async () => {
    getAuthorizationsMock.mockResolvedValue({
      active: [{
        id: 'legacy-submit-auth',
        profile_id: 'profile-1',
        scope: 'profile',
        authorization_type: 'submit_applications',
        revoked_at: null,
      }],
    })
    renderCard()

    fireEvent.click(await screen.findByRole('button', { name: /revoke legacy submit permission/i }))

    await waitFor(() => {
      expect(revokeAuthorizationMock).toHaveBeenCalledWith('legacy-submit-auth', 'user_toggled_off')
    })
    expect(grantAuthorizationMock).not.toHaveBeenCalled()
  })
})
