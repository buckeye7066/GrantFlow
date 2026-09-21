// @vitest-environment jsdom
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ list: vi.fn(), download: vi.fn() }))
vi.mock('@/api/client', () => ({ default: { entities: { Grant: { list: mocks.list } } } }))
vi.mock('@/api/foundations', () => ({ getCalendarDeadlines: async () => ({ events: [] }) }))
vi.mock('@/api/hamilton', () => ({ getHamiltonCalendar: async () => ({ events: [] }) }))
vi.mock('@/components/hamilton/HamiltonReadinessBanner', () => ({ default: () => null }))
vi.mock('@/components/shared/ProfileSelect', () => ({ default: ({ value, onValueChange }) => <select aria-label="Profile" value={value} onChange={e => onValueChange(e.target.value)}><option value="all">All</option><option value="a">Profile A</option></select> }))
vi.mock('@/lib/calendarExport', async importOriginal => ({ ...await importOriginal(), downloadCalendar: mocks.download }))
import Calendar from './Calendar'

it('filters pipeline dates by profile and exports the displayed month', async () => {
  const now = new Date()
  const deadline = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  mocks.list.mockResolvedValue([
    { id: 'one', profile_id: 'a', title: 'Profile A deadline', status: 'saved', deadline },
    { id: 'two', profile_id: 'b', title: 'Profile B deadline', status: 'drafting', deadline },
  ])
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter><Calendar /></MemoryRouter></QueryClientProvider>)
  await screen.findAllByText('Profile B deadline')
  fireEvent.change(screen.getByRole('combobox', { name: 'Profile' }), { target: { value: 'a' } })
  await waitFor(() => expect(mocks.list).toHaveBeenCalledWith('-created_date', expect.any(Number), { profile_id: 'a' }))
  await screen.findAllByText('Profile A deadline')
  expect(screen.queryByText('Profile B deadline')).toBeNull()
  const button = screen.getByRole('button', { name: /Export .* calendar/ })
  await waitFor(() => expect(button.disabled).toBe(false))
  fireEvent.click(button)
  expect(mocks.download).toHaveBeenLastCalledWith([expect.objectContaining({ grant_id: 'one' })], deadline.slice(0, 7))
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
  await waitFor(() => expect(button.disabled).toBe(false))
  fireEvent.click(button)
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  expect(mocks.download.mock.calls.at(-1)[1]).toBe(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`)
})
