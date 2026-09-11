// @vitest-environment jsdom
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

// Live GET /api/billing/catalog shape, production 2026-09-11 (trimmed).
const CATALOG = {
  capability_keys: ['enable_document_ai', 'enable_item_funding', 'enable_pipeline_automation'],
  capability_labels: {},
  addons: [],
  tiers: [
    { id: 'foundation', name: 'Foundation', audience: 'Individuals & families getting started', monthly_usd: 0, hourly_usd: 0, capabilities: {} },
    { id: 'growth', name: 'Growth', audience: 'Active applicants who want automation', monthly_usd: 99, hourly_usd: 150, capabilities: {} },
    { id: 'individual', name: 'Individual / family', audience: 'A single person or household', monthly_usd: 0, hourly_usd: 85, capabilities: {} },
    { id: 'small_org', name: 'Small organization', audience: 'Organizations with 1 login', monthly_usd: 149, hourly_usd: 85, capabilities: {} },
    { id: 'mid_size', name: 'Mid-sized organization', audience: 'Organizations with 2–5 logins', monthly_usd: 349, hourly_usd: 115, capabilities: {} },
    { id: 'large_org', name: 'Large organization', audience: 'Organizations with 6+ logins', monthly_usd: 599, hourly_usd: 150, capabilities: {} },
  ],
  discounts: [
    { id: 'student', label: 'Student', percent: 15, plain: 'Reduced rate for verified students.' },
    { id: 'minister', label: 'Minister / clergy', percent: 10, plain: 'Reduced rate for ministers and clergy.' },
    { id: 'hardship', label: 'Financial hardship', percent: 15, plain: 'Reduced rate for documented financial hardship.' },
    { id: 'pro_bono', label: 'Pro bono', percent: 100, plain: 'Fully waived.' },
  ],
}

vi.mock('@/api/billing', () => ({ getTierCatalog: vi.fn(async () => CATALOG) }))
vi.mock('@/lib/platform', () => ({ isNativeApp: () => false }))
vi.mock('@/components/billing/TierMatrix.jsx', () => ({ default: () => <div data-testid="tier-matrix" /> }))

import Pricing from '../Pricing.jsx'

function renderPricing() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Pricing />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Pricing cards read the canonical catalog', () => {
  it('shows catalog monthly prices and never the old hardcoded ranges', async () => {
    renderPricing()
    await waitFor(() => expect(screen.getByText('$149/mo')).toBeTruthy())
    expect(screen.getByText('$349/mo')).toBeTruthy()
    expect(screen.getByText('$599/mo')).toBeTruthy()
    const body = document.body.textContent
    for (const stale of ['$100 - $250', '$250 - $500', '$25 - $75', '$50 - $100', '$0 - $50', 'Up to 30% off']) {
      expect(body).not.toContain(stale)
    }
  })

  it('shows catalog discount percentages on persona cards and in the discount list', async () => {
    renderPricing()
    await waitFor(() => expect(screen.getByText('Student: 15% off')).toBeTruthy())
    expect(screen.getByText('Minister / clergy: 10% off')).toBeTruthy()
    // Student and Financial hardship are BOTH 15% in the catalog, so assert each
    // discount row by its own catalog description rather than the shared percent.
    expect(screen.getAllByText(/15% off any plan\./)).toHaveLength(2)
    expect(screen.getByText(/15% off any plan\.\s*Reduced rate for verified students\./)).toBeTruthy()
    expect(screen.getByText(/10% off any plan\.\s*Reduced rate for ministers and clergy\./)).toBeTruthy()
    expect(screen.getByText(/Fully waived\./)).toBeTruthy()
  })

  it('sends every Get Started click to a real route', async () => {
    renderPricing()
    await waitFor(() => expect(screen.getByText('$149/mo')).toBeTruthy())
    const hrefs = screen.getAllByRole('link', { name: /Get Started/i }).map((a) => a.getAttribute('href'))
    expect(hrefs.length).toBeGreaterThan(0)
    for (const href of hrefs) expect(href).toBe('/Organizations?quickAdd=1')
  })
})
