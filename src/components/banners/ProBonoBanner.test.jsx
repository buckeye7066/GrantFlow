// @vitest-environment jsdom
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { authState, fetchMock } = vi.hoisted(() => ({
  authState: { activeProfileId: 'profile-1', user: { id: 'user-1' } },
  fetchMock: vi.fn(),
}))

vi.mock('@/stores/authStore', () => ({ useAuthStore: (selector) => selector(authState) }))
vi.mock('@/api/client', () => ({ apiFetch: (...args) => fetchMock(...args) }))
vi.mock('@/api/profileIdGuards', () => ({ isRealProfileId: (id) => Boolean(id) }))

import ProBonoBanner from './ProBonoBanner.jsx'

function renderBanner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><ProBonoBanner /></QueryClientProvider>)
}

describe('ProBonoBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    try { localStorage.clear() } catch { /* jsdom */ }
  })

  it('renders nothing for a live pro bono account with no declared end date', async () => {
    // Prod 2026-09-07: a profile created 2026-07-20 with is_pro_bono=true was
    // told "Pro Bono Period Has Ended" from created_at + 30 days. Pro bono has
    // no built-in term; only an explicit end date may announce an ending.
    fetchMock.mockResolvedValue({ id: 'profile-1', created_at: '2026-07-20T00:12:33.341Z', billing: { is_pro_bono: true, tier_id: 'foundation' } })
    renderBanner()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText(/Pro Bono Period Has Ended/)).toBeNull()
    expect(screen.queryByText(/Pro Bono Status Ending Soon/)).toBeNull()
  })

  it('announces an ending only from an explicit end date', async () => {
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString()
    fetchMock.mockResolvedValue({ id: 'profile-1', billing: { is_pro_bono: true, pro_bono_end_date: soon } })
    renderBanner()
    await waitFor(() => expect(screen.getByText(/Pro Bono Status Ending Soon/)).toBeTruthy())
  })

  it('renders nothing for a non pro bono account', async () => {
    fetchMock.mockResolvedValue({ id: 'profile-1', billing: { is_pro_bono: false } })
    renderBanner()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText(/Pro Bono/)).toBeNull()
  })
})
