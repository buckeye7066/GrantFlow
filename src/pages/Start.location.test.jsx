// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
const locationQuestion = { id: 'location', kind: 'location', prompt: 'Where are you located?' }
const locations = {
 '37205': { state: 'TN', city: 'Nashville', county: 'Davidson' },
 '37312': { state: 'TN', city: 'Cleveland', county: 'Bradley' },
 '10001': { state: 'NY', city: 'New York' },
}
beforeEach(() => {
 localStorage.clear()
 localStorage.setItem('grantflow:intro_video_seen', '1')
 apiFetch.mockReset()
 apiFetch.mockImplementation(async (url) => {
 if (url === '/api/onboarding/start') {
 return { session_id: 'test-location-session', question: locationQuestion }
 }
 if (url.startsWith('/api/onboarding/zip/')) return locations[url.split('/').pop()]
 if (url === '/api/onboarding/answer') {
 return { question: { id: 'household', kind: 'announce', prompt: 'Location saved.' } }
 }
 throw new Error(`Unexpected test request: ${url}`)
 })
})
afterEach(cleanup)
async function openLocation() {
 render(<MemoryRouter><Start /></MemoryRouter>)
 await screen.findByLabelText('ZIP code')
}
async function enterZip(zip, city) {
 fireEvent.change(screen.getByLabelText('ZIP code'), { target: { value: zip } })
 await waitFor(() => expect(screen.getByLabelText(/^City/).value).toBe(city))
}
function countyInput() { return screen.getByLabelText(/^County/) }
describe('Foundation onboarding location', () => {
 it('updates an automatically filled county after ZIP changes and submits that county', async () => {
 await openLocation()
 await enterZip('37205', 'Nashville')
 expect(countyInput().value).toBe('Davidson')
 await enterZip('37312', 'Cleveland')
 expect(countyInput().value).toBe('Bradley')
 fireEvent.click(screen.getByRole('button', { name: 'Continue', exact: true }))
 await screen.findByText('Location saved.')
 const answerCall = apiFetch.mock.calls.find(([url]) => url === '/api/onboarding/answer')
 expect(JSON.parse(answerCall[1].body).answer).toEqual({
 zip: '37312', state: 'TN', city: 'Cleveland', county: 'Bradley',
 })
 })
 it('preserves a county deliberately entered by the applicant', async () => {
 await openLocation()
 await enterZip('37205', 'Nashville')
 fireEvent.change(countyInput(), { target: { value: 'Applicant County' } })
 await enterZip('37312', 'Cleveland')
 expect(countyInput().value).toBe('Applicant County')
 })
 it('resumes automatic county updates when the applicant clears the manual value', async () => {
 await openLocation()
 await enterZip('37205', 'Nashville')
 fireEvent.change(countyInput(), { target: { value: 'Applicant County' } })
 fireEvent.change(countyInput(), { target: { value: '' } })
 await enterZip('37312', 'Cleveland')
 expect(countyInput().value).toBe('Bradley')
 await enterZip('37205', 'Nashville')
 expect(countyInput().value).toBe('Davidson')
 })
 it('does not retain an old automatic county when the new lookup has no county', async () => {
 await openLocation()
 await enterZip('37205', 'Nashville')
 await enterZip('10001', 'New York')
 expect(countyInput().value).toBe('')
 })
})
