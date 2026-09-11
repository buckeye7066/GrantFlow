// @vitest-environment jsdom
import React from 'react'
import { render, screen, waitFor, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { meMock, storeState } = vi.hoisted(() => ({
  meMock: vi.fn(),
  storeState: {
    isAuthenticated: false,
    guidedCycleTourStatus: null,
    hydrateFromStorage: vi.fn(),
    setAuthenticatedUser: vi.fn(),
    clearState: vi.fn(),
    scheduleSessionRefresh: vi.fn(),
  },
}))

vi.mock('@/api/client', () => ({ default: { auth: { me: (...a) => meMock(...a) } } }))
vi.mock('@/stores/authStore', () => {
  const useAuthStore = (selector) => selector(storeState)
  useAuthStore.getState = () => storeState
  return { useAuthStore }
})
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector) => selector({ fetchPreferences: vi.fn(), isInitialized: true }),
}))
vi.mock('@/pages/index.jsx', () => ({ default: () => <div>pages-rendered</div> }))
vi.mock('@/components/ui/toaster', () => ({ Toaster: () => null }))
vi.mock('@/components/auth/SessionExpiredDialog', () => ({ default: () => null }))
vi.mock('@/components/hamilton/HamiltonToastBridge', () => ({ default: () => null }))
vi.mock('@/components/hamilton/HamiltonAuthPrimingToast', () => ({ default: () => null }))
vi.mock('@/components/onboarding/ProfileCompletionGate', () => ({ default: () => null }))
vi.mock('@/components/mobile/MobileUpdateWatcher', () => ({ default: () => null }))
vi.mock('@/components/shared/FlashHighlighter.jsx', () => ({ default: () => null }))
vi.mock('@/config/env.js', () => ({ env: { appBase: '/' } }))

import App from './App.jsx'

function rateLimited(retryAfter = 2) {
  const err = new Error('rate_limit_exceeded')
  err.status = 429
  err.errorCode = 'rate_limit_exceeded'
  err.details = { ok: false, error: 'rate_limit_exceeded', retry_after_seconds: retryAfter }
  return err
}

describe('App auth bootstrap under a rate limit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks keeps queued mockResolvedValueOnce values; reset so one
    // case's leftover response can never answer the next case's bootstrap.
    meMock.mockReset()
    vi.useRealTimers()
  })

  it('does not sign a valid session out when GET /api/auth/me answers 429', async () => {
    // Production 2026-09-11: an exhausted read bucket made auth.me() throw 429,
    // App cleared the session, and every route rendered "Sign in to GrantFlow".
    meMock.mockRejectedValueOnce(rateLimited(1)).mockResolvedValueOnce({ userId: 'u1', email: 'a@example.test', isAdmin: true })
    render(<App />)
    await waitFor(() => expect(meMock).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 50))
    expect(storeState.clearState).not.toHaveBeenCalled()
    expect(screen.getByText(/busy|try(ing)? again|retry/i)).toBeTruthy()
    expect(screen.queryByText('pages-rendered')).toBeNull()
    await waitFor(() => expect(meMock).toHaveBeenCalledTimes(2), { timeout: 5000 })
    await waitFor(() => expect(storeState.setAuthenticatedUser).toHaveBeenCalled())
    expect(storeState.clearState).not.toHaveBeenCalled()
    expect(screen.getByText('pages-rendered')).toBeTruthy()
  })

  it('still clears the session when auth.me() resolves null (signed out)', async () => {
    meMock.mockResolvedValueOnce(null)
    render(<App />)
    await waitFor(() => expect(storeState.clearState).toHaveBeenCalledTimes(1))
    expect(screen.getByText('pages-rendered')).toBeTruthy()
  })
})
