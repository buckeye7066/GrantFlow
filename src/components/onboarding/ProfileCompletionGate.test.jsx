// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ProfileCompletionGate from './ProfileCompletionGate'
import { apiFetch } from '@/api/client'

const { state } = vi.hoisted(() => ({ state: {} }))
vi.mock('@/api/client', () => ({ apiFetch: vi.fn() }))
vi.mock('@/stores/authStore', () => ({
  useAuthStore: selector => selector(state),
  normalizeUserAdmin: user => Boolean(user?.is_admin),
}))

function completion(profileId, prompts = ['Financial urgency?', 'Household size?']) {
  return {
    blocked: true,
    next: {
      profile_id: profileId,
      questions: prompts.map((prompt, index) => ({
        id: `question-${index + 1}`, prompt, index: index + 1, total: prompts.length, type: 'text',
      })),
    },
  }
}

beforeEach(() => {
  Object.assign(state, {
    isAuthenticated: false, user: null, profileCompletion: null, forcedWelcomeVideo: false,
    setProfileCompletion: vi.fn(value => { state.profileCompletion = value }),
  })
  apiFetch.mockReset()
})
afterEach(cleanup)

describe('profile completion after asynchronous authentication', () => {
  it('opens when sign-in supplies the profile after App has already mounted', async () => {
    const view = render(<ProfileCompletionGate />)
    expect(screen.queryByTestId('profile-completion-gate')).toBeNull()
    Object.assign(state, { isAuthenticated: true, user: { id: 'u1' }, profileCompletion: completion('p1') })
    view.rerender(<ProfileCompletionGate />)
    expect(await screen.findByRole('textbox', { name: 'Financial urgency?' })).toBeTruthy()
    expect(screen.getByTestId('completion-gate-counter').textContent).toBe('Question 1 of 2')
  })

  it('keeps the original numbering on refresh and resets unsaved answers for another profile', async () => {
    Object.assign(state, { isAuthenticated: true, user: { id: 'u1' }, profileCompletion: completion('p1') })
    const view = render(<ProfileCompletionGate />)
    apiFetch.mockResolvedValueOnce({ complete: false })
    fireEvent.change(screen.getByRole('textbox', { name: 'Financial urgency?' }), { target: { value: 'high' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue', exact: true }))
    await waitFor(() => expect(screen.getByTestId('completion-gate-counter').textContent).toBe('Question 2 of 2'))
    state.profileCompletion = completion('p1', ['Household size?'])
    view.rerender(<ProfileCompletionGate />)
    expect(screen.getByTestId('completion-gate-counter').textContent).toBe('Question 2 of 2')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'private unsaved answer' } })
    state.profileCompletion = completion('p2', ['Another profile question?'])
    view.rerender(<ProfileCompletionGate />)
    expect(screen.getByTestId('completion-gate-counter').textContent).toBe('Question 1 of 1')
    expect(screen.getByRole('textbox', { name: 'Another profile question?' }).value).toBe('')
  })

  it('preserves the admin exemption and welcome-video priority', () => {
    Object.assign(state, { isAuthenticated: true, user: { id: 'admin', is_admin: true }, profileCompletion: completion('p1') })
    const view = render(<ProfileCompletionGate />)
    expect(screen.queryByTestId('profile-completion-gate')).toBeNull()
    Object.assign(state, { user: { id: 'u1' }, forcedWelcomeVideo: true })
    view.rerender(<ProfileCompletionGate />)
    expect(screen.queryByTestId('profile-completion-gate')).toBeNull()
    state.forcedWelcomeVideo = false
    view.rerender(<ProfileCompletionGate />)
    expect(screen.getByRole('textbox', { name: 'Financial urgency?' })).toBeTruthy()
  })
})
