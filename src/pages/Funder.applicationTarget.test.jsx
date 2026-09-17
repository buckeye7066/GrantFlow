// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { apiFetch } from '@/api/client'
import Funder from './Funder.jsx'

vi.mock('@/api/client', () => ({ apiFetch: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const selected = 'https://www.tn.gov/collegepays/apply'
const stale = 'https://alpha.grantable.co/login'

it.each(['opportunity','grant'])('Funder page and dialog preserve the selected %s application', async (kind) => {
  const row = { id:'target-fixture',title:'Student assistance',sponsor:'TN Foundation',funder:'TN Foundation',
    apply_url:selected,application_url:stale,url:stale,source_url:'https://www.tn.gov/collegepays' }
  vi.mocked(apiFetch).mockImplementation(async url => String(url).startsWith('/api/grants')
    ? (kind === 'grant' ? [row] : []) : (kind === 'opportunity' ? [row] : []))
  const client = new QueryClient({ defaultOptions: { queries: { retry:false } } })
  try {
    render(<QueryClientProvider client={client}><MemoryRouter><Funder /></MemoryRouter></QueryClientProvider>)
    fireEvent.click(await screen.findByRole('button',{name:'View Details'}))
    const dialog = screen.getByRole('dialog')
    const links = within(dialog).getAllByRole('link').map(a => a.getAttribute('href'))
    expect(links).toContain(selected)
    expect(links).not.toContain(stale)
    expect(links.filter(url => url === selected)).toHaveLength(2)
  } finally { client.clear() }
})
