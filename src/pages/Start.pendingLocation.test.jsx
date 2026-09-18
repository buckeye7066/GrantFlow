// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  localStorage.setItem('grantflow:intro_video_seen', '1')
  apiFetch.mockReset()
  apiFetch.mockImplementation(async (url) => {
    if (url === '/api/onboarding/start') return {
      session_id: 'pending-location-test',
      question: { id: 'location', kind: 'location', prompt: 'Where are you located?' },
    }
    if (url === '/api/onboarding/zip/37205') return { state: 'TN', city: 'Nashville', county: 'Davidson' }
    if (url === '/api/onboarding/answer') return {
      question: { id: 'next', kind: 'announce', prompt: 'Location saved.' },
    }
    throw new Error(`Unexpected request: ${url}`)
  })
})
afterEach(cleanup)

async function openExistingLocation() {
  render(<MemoryRouter><Start /></MemoryRouter>)
  const zip = await screen.findByLabelText('ZIP code')
  fireEvent.change(zip, { target: { value: '37205' } })
  await waitFor(() => expect(screen.getByLabelText(/^City/).value).toBe('Nashville'))
  return zip
}

function submittedAnswers() {
  return apiFetch.mock.calls.filter(([url]) => url === '/api/onboarding/answer')
}

describe('Foundation pending geography submission', () => {
  it('guards both the button and form submission until the current lookup settles', async () => {
    const zip = await openExistingLocation()
    let resolveLookup
    apiFetch.mockImplementationOnce(() => new Promise((resolve) => { resolveLookup = resolve }))
    fireEvent.change(zip, { target: { value: '37312' } })
    const submit = screen.getByRole('button', { name: 'Continue', exact: true })
    await waitFor(() => expect(submit.disabled).toBe(true))
    fireEvent.submit(submit.closest('form'))
    expect(submittedAnswers()).toHaveLength(0)
    await act(async () => { resolveLookup({ state: 'TN', city: 'Cleveland', county: 'Bradley' }) })
    await waitFor(() => expect(submit.disabled).toBe(false))
    fireEvent.click(submit)
    await screen.findByText('Location saved.')
    expect(JSON.parse(submittedAnswers()[0][1].body).answer).toEqual({
      zip: '37312', state: 'TN', city: 'Cleveland', county: 'Bradley',
    })
  })

  it('allows manual ZIP+4 entry after cancelling a lookup and ignores the old response', async () => {
    const zip = await openExistingLocation()
    let resolveLookup
    apiFetch.mockImplementationOnce(() => new Promise((resolve) => { resolveLookup = resolve }))
    fireEvent.change(zip, { target: { value: '37312' } })
    const submit = screen.getByRole('button', { name: 'Continue', exact: true })
    await waitFor(() => expect(submit.disabled).toBe(true))
    fireEvent.change(zip, { target: { value: '37312-1234' } })
    fireEvent.change(screen.getByLabelText(/^City/), { target: { value: 'Manual City' } })
    fireEvent.change(screen.getByLabelText(/^County/), { target: { value: 'Manual County' } })
    await waitFor(() => expect(submit.disabled).toBe(false))
    await act(async () => { resolveLookup({ state: 'CA', city: 'Obsolete City', county: 'Obsolete County' }) })
    expect(screen.getByLabelText(/^City/).value).toBe('Manual City')
    expect(screen.getByLabelText(/^County/).value).toBe('Manual County')
    fireEvent.click(submit)
    await screen.findByText('Location saved.')
    expect(JSON.parse(submittedAnswers()[0][1].body).answer).toEqual({
      zip: '37312-1234', state: 'TN', city: 'Manual City', county: 'Manual County',
    })
  })
})
