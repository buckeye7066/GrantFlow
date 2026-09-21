// @vitest-environment jsdom
import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const { logout } = vi.hoisted(() => ({ logout: vi.fn() }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: select => select({ logout }) }))
vi.mock('@/i18n', () => ({ useLanguage: () => ({ t: () => 'Log out' }) }))
import LogoutButton from './LogoutButton'

beforeEach(() => { logout.mockReset() })

function mount() {
  render(<MemoryRouter initialEntries={['/Calendar']}><Routes>
    <Route path="/Calendar" element={<LogoutButton />} />
    <Route path="/login" element={<h1>Sign in</h1>} />
  </Routes></MemoryRouter>)
}

it('labels the action, prevents duplicate requests and returns to sign-in', async () => {
  let finish
  logout.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  mount()
  const button = screen.getByRole('button', { name: 'Log out' })
  fireEvent.click(button)
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(logout).toHaveBeenCalledTimes(1)
  await act(async () => finish())
  expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy()
})

it('returns to sign-in if server logout fails after the store clears local state', async () => {
  logout.mockRejectedValue(new Error('offline'))
  mount()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Log out' })))
  expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy()
})
