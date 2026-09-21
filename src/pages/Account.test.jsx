// @vitest-environment jsdom
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ profiles: vi.fn(), overview: vi.fn(), invoices: vi.fn(), catalog: vi.fn(), services: vi.fn(), reset: vi.fn(), request: vi.fn() }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: select => select({ user: { id: 'owner', email: 'login@example.test', display_name: 'Account owner' }, activeProfileId: 'unrelated-client' }) }))
vi.mock('@/api/profiles', () => ({ listProfiles: (...args) => mock.profiles(...args) }))
vi.mock('@/api/billing', () => ({ getBillingOverview: (...args) => mock.overview(...args), getBillingInvoices: (...args) => mock.invoices(...args), getTierCatalog: () => mock.catalog(), requestPlanChange: (...args) => mock.request(...args) }))
vi.mock('@/api/services', () => ({ fetchServiceCatalog: () => mock.services() }))
vi.mock('@/api/auth', () => ({ startPasswordReset: (...args) => mock.reset(...args) }))
vi.mock('@/components/auth/LogoutButton', () => ({ default: () => <button>Log out</button> }))
vi.mock('@/lib/platform', () => ({ isNativeApp: () => false }))
import Account from './Account'
import { serviceStartingPrice } from '@/lib/accountBilling'

beforeEach(() => {
  vi.resetAllMocks()
  mock.profiles.mockResolvedValue([{ id: 'owned', display_name: 'Research workspace' }])
  mock.overview.mockResolvedValue({ account: { tier: { id: 'foundation', name: 'Foundation' } }, billing: { net_monthly_cents: 0 } })
  mock.invoices.mockResolvedValue({ balances: [{ currency: 'USD', amount_cents: 4500 }], open_invoices: [{ id: 'bill', period_key: 'September', status: 'sent', amount_cents: 4500, currency: 'USD', stripe_payment_link: 'https://checkout.stripe.com/c/pay/example' }] })
  mock.catalog.mockResolvedValue({ tiers: [{ id: 'growth', name: 'Growth', monthly_usd: 99, includes: ['Application support'] }] })
  mock.services.mockResolvedValue({ catalog: [{ slug: 'review', name: 'Proposal review', prices: [{ amount_cents: 2500 }], pricing_model: 'fixed' }] })
  mock.reset.mockResolvedValue({ email_sent: true })
  mock.request.mockResolvedValue({ ok: true })
})
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<MemoryRouter><QueryClientProvider client={client}><Account /></QueryClientProvider></MemoryRouter>)
}
it('uses account identity and owned workspaces, with bill payment and actual service pricing', async () => {
  mount()
  expect(screen.getByText('login@example.test')).toBeTruthy()
  expect(await screen.findByText('Foundation')).toBeTruthy()
  expect(mock.profiles).toHaveBeenCalledWith({ scope: 'mine', limit: 1000 })
  expect(mock.overview).toHaveBeenCalledWith('owned')
  expect(mock.overview).not.toHaveBeenCalledWith('unrelated-client')
  expect(screen.getByRole('link', { name: /Pay invoice/ }).getAttribute('href')).toBe('https://checkout.stripe.com/c/pay/example')
  expect(screen.getByText('From $25.00')).toBeTruthy()
  expect(screen.getByRole('link', { name: /View service/ }).getAttribute('href')).toBe('/Services?service=review&profile_id=owned')
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
  await screen.findByText('Check your login email for the password-change link.')
  expect(mock.reset).toHaveBeenCalledWith('login@example.test')
})
it('persists a plan request without claiming payment or activation', async () => {
  mount()
  const button = await screen.findByRole('button', { name: 'Request Growth' })
  await waitFor(() => expect(button.disabled).toBe(false))
  fireEvent.click(button)
  await screen.findByText('Plan request saved. No charge has been made.')
  expect(mock.request).toHaveBeenCalledWith('owned', 'growth')
  expect(screen.getByText('Foundation')).toBeTruthy()
})
it('does not show zero when billing cannot be verified', async () => {
  mock.invoices.mockRejectedValue(new Error('unavailable'))
  mount()
  expect(await screen.findByText(/Your balance could not be verified/)).toBeTruthy()
  expect(screen.queryByText('You have no outstanding invoices.')).toBeNull()
  expect(screen.queryByRole('link', { name: /Pay invoice/ })).toBeNull()
})
it('switches billing workspaces without retaining the previous balance', async () => {
  mock.profiles.mockResolvedValue([{ id: 'owned', display_name: 'First' }, { id: 'second', display_name: 'Second' }])
  mock.invoices.mockImplementation(id => id === 'second' ? new Promise(() => {}) : Promise.resolve({ balances: [{ currency: 'USD', amount_cents: 4500 }], open_invoices: [] }))
  mount()
  await screen.findByText('$45.00')
  fireEvent.change(screen.getByLabelText('Billing workspace'), { target: { value: 'second' } })
  await waitFor(() => expect(mock.invoices).toHaveBeenCalledWith('second'))
  expect(screen.queryByText('$45.00')).toBeNull()
  expect(screen.getByText('Loading your balance…')).toBeTruthy()
})
it('advertises total milestone prices instead of just initial installments', () => {
  expect(serviceStartingPrice({ pricing_model: 'milestone', prices: [{ client_category: 'individual', amount_cents: 4000 }, { client_category: 'individual', amount_cents: 4000 }, { client_category: 'individual', amount_cents: 2000 }, { client_category: 'large', amount_cents: 40000 }] })).toBe(10000)
  expect(serviceStartingPrice({ prices: [{ amount_cents: null }] })).toBeNull()
})
