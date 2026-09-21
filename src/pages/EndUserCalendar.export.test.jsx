// @vitest-environment jsdom
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ download: vi.fn() }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: select => select({ activeProfileId: 'a', profiles: [{ id: 'a' }] }) }))
vi.mock('@/api/client', () => ({ default: {
  get: async () => ({ tasks: [] }),
  entities: {
    Grant: { list: async () => [{ id: 'one', profile_id: 'a', title: 'Research', status: 'saved', deadline: '2026-09-21T15:30:00Z' }] },
    Milestone: { list: async () => [] },
  },
} }))
vi.mock('@/lib/calendarExport', async importOriginal => ({ ...await importOriginal(), downloadCalendar: mocks.download }))
import EndUserCalendar from './EndUserCalendar'
import { buildCalendarExport } from '@/lib/calendarExport'

it('preserves exact submission cutoff times through the end-user export button', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter><EndUserCalendar /></MemoryRouter></QueryClientProvider>)
  const button = await screen.findByRole('button', { name: /Export .* calendar/ })
  await waitFor(() => expect(button.disabled).toBe(false))
  fireEvent.click(button)
  const events = mocks.download.mock.calls.at(-1)[0]
  expect(events).toContainEqual(expect.objectContaining({ deadline: '2026-09-21T15:30:00Z' }))
  expect(buildCalendarExport(events)).toContain('DTSTART:20260921T153000Z')
})
