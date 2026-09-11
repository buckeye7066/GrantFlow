// @vitest-environment jsdom
import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector) => selector({ user: { id: 'admin-1', is_admin: true } }),
}))
vi.mock('@/api/client', () => ({ default: { entities: { Grant: { list: vi.fn().mockResolvedValue([]) } } } }))

import PipelineStatusCard from './PipelineStatusCard.jsx'

function renderCard(stats) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PipelineStatusCard stats={stats} isLoading={false} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function tileCount(label) {
  const labelEl = screen.getByText(label, { selector: 'span' })
  return Number(labelEl.nextElementSibling?.textContent)
}

describe('PipelineStatusCard (admin) reads the canonical pipeline stages', () => {
  it('shows the Saved stage and counts every active canonical stage', () => {
    // Live GET /api/pipeline/stats, production 2026-09-11. The card read legacy
    // keys only, never showed Saved (27) and announced "Tracking 115".
    renderCard({
      discovered: 16, saved: 27, interested: 41, gathering_documents: 31, drafting: 2,
      ready_to_submit: 1, submitted: 23, follow_up: 0, awarded: 1, declined: 0, archived: 11,
      app_prep: 31, submission_ready: 1, rejected: 0,
    })
    expect(tileCount('Saved')).toBe(27)
    expect(tileCount('Prep')).toBe(31)
    expect(tileCount('Ready to Submit')).toBe(1)
    expect(screen.getByText(/Tracking 142 pipeline grants/)).toBeTruthy()
  })

  it('still counts a legacy-only stats payload', () => {
    renderCard({ discovered: 2, interested: 3, drafting: 1, app_prep: 5, submission_ready: 4, submitted: 1, awarded: 1, rejected: 2 })
    expect(tileCount('Prep')).toBe(5)
    expect(tileCount('Ready to Submit')).toBe(4)
    expect(tileCount('Closed')).toBe(2)
    expect(screen.getByText(/Tracking 19 pipeline grants/)).toBeTruthy()
  })
})
