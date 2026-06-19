// @vitest-environment jsdom
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.mock factories are hoisted above module init, so shared mocks must come
// from vi.hoisted to avoid a TDZ ReferenceError.
const { removeGrant, apiFetch } = vi.hoisted(() => ({
  removeGrant: vi.fn(),
  apiFetch: vi.fn(async () => {
    const err = new Error('Not found')
    err.status = 404 // target grant no longer exists
    throw err
  }),
}))

vi.mock('@/api/client', () => ({ apiFetch }))
vi.mock('@/stores/savedGrantsStore', () => ({
  useSavedGrantsStore: () => ({
    savedIds: ['sch-ana-workforce-scholarship'],
    removeGrant,
    sync: vi.fn(),
    synced: true,
    getNote: () => '',
    updateNote: vi.fn(),
  }),
}))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))

import SavedGrants from './SavedGrants.jsx'

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SavedGrants />
    </QueryClientProvider>,
  )
}

describe('SavedGrants — missing grant (GET /api/grants/:id -> 404)', () => {
  beforeEach(() => {
    removeGrant.mockClear()
    apiFetch.mockClear()
  })

  it('renders a graceful "no longer available" card, not the raw grant ID as a title', async () => {
    renderPage()

    await waitFor(() => {
      expect(screen.getByText('This grant is no longer available')).toBeTruthy()
    })

    // The raw id must NOT be shown as the card title (the old "Grant ID: <id>").
    expect(screen.queryByText(/^Grant ID:/)).toBeNull()

    // A working Remove action is present and calls removeGrant with the id.
    const removeBtn = screen.getAllByRole('button', { name: /^remove$/i })[0]
    fireEvent.click(removeBtn)
    expect(removeGrant).toHaveBeenCalledWith('sch-ana-workforce-scholarship')
  })

  it('offers a bulk "Remove N unavailable" cleanup action', async () => {
    renderPage()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Remove 1 unavailable/i })).toBeTruthy()
    })
  })
})
