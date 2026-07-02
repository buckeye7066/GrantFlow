// @vitest-environment jsdom
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/api/client', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '@/api/client'
import ProfileGapGate from '../ProfileGapGate.jsx'

const PLAN = {
  complete: false,
  needs_questions: true,
  questions: [
    { id: 'state', type: 'text', prompt: 'Which state do you live in?', writes: { section: 'location_focus', field: 'state' } },
  ],
}

function renderGate(props) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><ProfileGapGate {...props} /></QueryClientProvider>)
}

beforeEach(() => { apiFetch.mockReset() })

describe('ProfileGapGate', () => {
  it('is inert when disabled — renders children, fetches nothing', () => {
    renderGate({ profileId: 'p1', enabled: false, children: <div>child</div> })
    expect(screen.getByText('child')).toBeTruthy()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('renders the interview when enabled and the profile is incomplete', async () => {
    apiFetch.mockImplementation((url) => {
      if (url.endsWith('/gap-plan')) return Promise.resolve(PLAN)
      return Promise.resolve([])
    })
    renderGate({ profileId: 'p1', enabled: true, children: <div>child</div> })
    expect(await screen.findByText('Which state do you live in?')).toBeTruthy()
  })

  it('persists answers by merging into the section and PUTting it', async () => {
    const puts = []
    apiFetch.mockImplementation((url, opts) => {
      if (url.endsWith('/gap-plan')) return Promise.resolve(PLAN)
      if (url.endsWith('/sections') && !opts) return Promise.resolve([]) // current sections (empty)
      if (/\/sections\//.test(url) && opts?.method === 'PUT') { puts.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve({ ok: true }) }
      return Promise.resolve({})
    })
    renderGate({ profileId: 'p1', enabled: true })

    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'TN' } })
    fireEvent.click(screen.getByText('Save & continue'))

    await waitFor(() => expect(puts.length).toBe(1))
    expect(puts[0].url).toContain('/api/profiles/p1/sections/location_focus')
    expect(puts[0].body).toEqual({ data: { state: 'TN' } })
  })
})
