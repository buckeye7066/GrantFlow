// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Start from './Start'
import { apiFetch } from '@/api/client'

vi.mock('@/api/client', () => ({ apiFetch: vi.fn() }))
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector) => selector({ isAuthenticated: false, startPasswordSetup: vi.fn() }),
}))
vi.mock('@/i18n', () => ({ useLanguage: () => ({ setLanguage: vi.fn() }) }))
vi.mock('@/components/onboarding/OnboardingVideo', () => ({ default: () => null }))

beforeEach(() => {
  localStorage.clear()
  apiFetch.mockReset()
  apiFetch.mockImplementation(async (url, options) => {
    if (url === '/api/onboarding/start') return {
      session_id: 'text-question-test',
      question: { id: 'narrative', kind: 'long_text', optional: true, prompt: 'Your funding needs', placeholder: 'Your story' },
    }
    if (url === '/api/onboarding/answer') {
      const submitted = JSON.parse(options.body)
      return { question: submitted.question_id === 'narrative'
        ? { id: 'name', kind: 'text', prompt: 'Your profile label', placeholder: 'Profile label' }
        : { id: 'email', kind: 'email', prompt: 'Your email', placeholder: 'Test email' } }
    }
    throw new Error(`Unexpected request: ${url}`)
  })
})
afterEach(cleanup)

it('keeps narrative, profile label and email answers in separate question state', async () => {
  render(<MemoryRouter><Start /></MemoryRouter>)
  const story = await screen.findByPlaceholderText('Your story')
  fireEvent.change(story, { target: { value: 'A narrative that must never become a profile name.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue', exact: true }))
  const label = await screen.findByPlaceholderText('Profile label')
  expect(label.value).toBe('')
  expect(screen.getByRole('button', { name: 'Continue', exact: true }).disabled).toBe(true)
  fireEvent.change(label, { target: { value: 'Applicant label' } })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Continue', exact: true }).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Continue', exact: true }))
  expect((await screen.findByPlaceholderText('Test email')).value).toBe('')
  const answers = apiFetch.mock.calls.filter(([url]) => url === '/api/onboarding/answer')
    .map(([, options]) => JSON.parse(options.body))
  expect(answers.map(({ question_id, answer }) => ({ question_id, answer }))).toEqual([
    { question_id: 'narrative', answer: 'A narrative that must never become a profile name.' },
    { question_id: 'name', answer: 'Applicant label' },
  ])
})
