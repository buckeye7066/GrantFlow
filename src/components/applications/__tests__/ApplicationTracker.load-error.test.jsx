// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ApplicationTracker from '../ApplicationTracker.jsx'
import { listApplications } from '@/api/grantApplications'

vi.mock('@/api/profiles', () => ({ listProfiles: vi.fn().mockResolvedValue([]) }))
vi.mock('@/api/grantApplications', () => ({
  listApplications: vi.fn(), createApplication: vi.fn(), updateApplication: vi.fn(),
  deleteApplication: vi.fn(), submitApplication: vi.fn(),
}))
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('shows a retryable error, not an empty board, when applications cannot be read', async () => {
  listApplications.mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValueOnce([
    { id: 'recovered', status: 'draft', grant_name: 'Recovered application' },
  ])
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter><ApplicationTracker /></MemoryRouter></QueryClientProvider>)
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.queryByText(/0 total/)).toBeNull()
  expect(screen.queryAllByText('None')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading applications' }))
  expect(await screen.findByText('Recovered application')).toBeTruthy()
  client.clear()
})
