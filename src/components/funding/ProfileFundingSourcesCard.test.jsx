// @vitest-environment jsdom
/**
 * ProfileFundingSourcesCard — sticky remove (2026-07-27 owner request:
 * "give me the ability to delete these items out of the pipeline").
 *
 * Every matched-source row must expose a remove control that calls the
 * sticky-dismiss API and refreshes the list; a failed dismiss must NOT
 * silently drop the row.
 */
import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const listMock = vi.fn()
const dismissMock = vi.fn()
const toastMock = vi.fn()

vi.mock('@/api/matching', () => ({
  listProfileFundingSources: (...args) => listMock(...args),
  dismissProfileFundingSource: (...args) => dismissMock(...args),
}))
vi.mock('@/components/hamilton/hamiltonWatchedOpen', () => ({
  openWithHamiltonWatching: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

import ProfileFundingSourcesCard from './ProfileFundingSourcesCard.jsx'

const SOURCE = {
  id: 'opp-drrp',
  title: 'DRRP Research Projects Program',
  sponsor: 'Administration for Community Living',
  url: 'https://grants.gov/drrp',
  match_score: 18,
  match_decision: 'accept',
  why: 'Covers about 18% of this profile’s main needs.',
  is_directory: false,
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ProfileFundingSourcesCard profileId="p1" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  listMock.mockResolvedValue({
    profile_id: 'p1',
    total: 1,
    best_matches: [SOURCE],
    worth_reviewing: [],
    directories: [],
    sources: [SOURCE],
  })
})

describe('ProfileFundingSourcesCard sticky remove', () => {
  it('renders a remove control on every source row and dismisses through the API', async () => {
    dismissMock.mockResolvedValue({ dismissed: true })
    renderCard()

    const removeBtn = await screen.findByRole('button', {
      name: /remove drrp research projects program/i,
    })
    fireEvent.click(removeBtn)

    await waitFor(() => expect(dismissMock).toHaveBeenCalledWith('p1', 'opp-drrp'))
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Source removed' }),
    ))
    // The list is re-fetched after a successful dismiss (query invalidation).
    await waitFor(() => expect(listMock.mock.calls.length).toBeGreaterThan(1))
  })

  it('surfaces a failure instead of silently dropping the row', async () => {
    dismissMock.mockRejectedValue(new Error('boom'))
    renderCard()

    fireEvent.click(await screen.findByRole('button', { name: /remove drrp/i }))

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Couldn’t remove source', variant: 'destructive' }),
    ))
    // Row is still there — only a successful dismiss refreshes it away.
    expect(screen.getByText('DRRP Research Projects Program')).toBeTruthy()
  })
})
