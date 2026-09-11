// @vitest-environment jsdom
import React from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { authState, billingMock, catalogMock } = vi.hoisted(() => ({
  authState: { user: null, activeProfileId: null },
  billingMock: vi.fn(),
  catalogMock: vi.fn(),
}))

// The REAL auth store shape: admin is `user.is_admin` (see authStore
// setAuthenticatedUser). There is no top-level `isAdmin` and no `user.role`.
vi.mock('@/stores/authStore', () => ({ useAuthStore: (selector) => selector(authState) }))
vi.mock('@/api/billing', () => ({
  getBillingOverview: (...args) => billingMock(...args),
  getTierCatalog: (...args) => catalogMock(...args),
}))

import { useTierEntitlements } from './useTierEntitlements'

function wrapper({ children }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('useTierEntitlements admin recognition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    catalogMock.mockResolvedValue({ tiers: [], capability_labels: {} })
    billingMock.mockResolvedValue({ account: { tier: null }, entitlements: { capabilities: {
      enable_document_ai: { allowed: false },
      enable_item_funding: { allowed: false },
      enable_pipeline_automation: { allowed: false },
    } } })
  })

  it('treats a DB admin (user.is_admin) as admin: every capability allowed, no billing lookup', async () => {
    // Production 2026-09-11: the hook read s.isAdmin (never set), so the owner
    // was gated by the selected profile's billing and the Automation tab fired
    // GET /api/billing/me/__admin__ -> 404.
    authState.user = { id: 'admin-user', email: 'owner@example.test', is_admin: true }
    authState.activeProfileId = '__admin__'
    const { result } = renderHook(() => useTierEntitlements('profile-real-1'), { wrapper })
    await waitFor(() => expect(catalogMock).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 30))
    expect(billingMock).not.toHaveBeenCalled()
    expect(result.current.capabilities.pipelineAutomation).toBe(true)
    expect(result.current.capabilities.documentAI).toBe(true)
    expect(result.current.capabilities.itemFunding).toBe(true)
  })

  it('never requests billing for the UI-only admin sentinel profile id', async () => {
    authState.user = { id: 'end-user', email: 'user@example.test', is_admin: false }
    const { result } = renderHook(() => useTierEntitlements('__admin__'), { wrapper })
    await waitFor(() => expect(catalogMock).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 30))
    expect(billingMock).not.toHaveBeenCalled()
    expect(result.current.capabilities.pipelineAutomation).toBe(false)
  })

  it('still gates a non-admin by the server entitlement decision', async () => {
    authState.user = { id: 'end-user', email: 'user@example.test', is_admin: false }
    const { result } = renderHook(() => useTierEntitlements('profile-real-1'), { wrapper })
    await waitFor(() => expect(billingMock).toHaveBeenCalledWith('profile-real-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.capabilities.pipelineAutomation).toBe(false)
  })
})
