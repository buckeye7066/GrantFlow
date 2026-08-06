// @vitest-environment jsdom
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { authState, statusMock } = vi.hoisted(() => ({
  authState: { user: null, profiles: [] },
  statusMock: vi.fn(),
}))

vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector) => selector(authState),
}))

vi.mock('@/api/accessGate', () => ({
  accessGateApi: { status: (...args) => statusMock(...args) },
}))

import RequirePaidAccess from './RequirePaidAccess.jsx'

function renderGate() {
  return render(
    <MemoryRouter initialEntries={['/Dashboard']}>
      <Routes>
        <Route
          path="/Dashboard"
          element={(
            <RequirePaidAccess fallback={<p>Checking access</p>}>
              <p>Protected workspace</p>
            </RequirePaidAccess>
          )}
        />
        <Route path="/PricingRequired" element={<p>Pricing required</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('RequirePaidAccess server authority', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authState.user = {
      id: 'user-1',
      activeProfileId: 'profile-1',
      role: 'admin',
      is_admin: true,
    }
    authState.profiles = []
  })

  it('does not render protected content from browser-side admin claims', async () => {
    statusMock.mockImplementation(() => new Promise(() => {}))

    renderGate()

    await waitFor(() => expect(statusMock).toHaveBeenCalledWith('profile-1'))
    expect(screen.getByText('Checking access')).toBeTruthy()
    expect(screen.queryByText('Protected workspace')).toBeNull()
  })

  it('fails closed on a status error and unlocks only after a successful retry', async () => {
    statusMock
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce({ ok: true, authenticated: true, access_granted: true, is_admin: true })

    renderGate()

    expect(await screen.findByRole('alert')).toHaveTextContent(/keeping this workspace locked/i)
    expect(screen.queryByText('Protected workspace')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Protected workspace')).toBeTruthy()
    expect(statusMock).toHaveBeenCalledTimes(2)
  })

  it('fails closed when the server cannot verify the session identity', async () => {
    statusMock.mockResolvedValue({
      ok: true,
      authenticated: false,
      access_granted: false,
      blocking_reason: 'not_authenticated',
    })

    renderGate()

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText('Protected workspace')).toBeNull()
  })

  it('keeps the existing pricing redirect for a verified but unpaid identity', async () => {
    statusMock.mockResolvedValue({
      ok: true,
      authenticated: true,
      access_granted: false,
      blocking_reason: 'payment_required',
    })

    renderGate()

    expect(await screen.findByText('Pricing required')).toBeTruthy()
    expect(screen.queryByText('Protected workspace')).toBeNull()
  })
})
