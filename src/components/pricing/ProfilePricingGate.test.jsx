// @vitest-environment jsdom
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { statusMock } = vi.hoisted(() => ({ statusMock: vi.fn() }))

vi.mock('@/api/accessGate', () => ({
  accessGateApi: { status: (...args) => statusMock(...args), acceptAgreement: vi.fn() },
}))
vi.mock('@/lib/platform', () => ({ isNativeApp: () => false }))
vi.mock('./PricingCheckoutPanel', () => ({ default: () => <p>Checkout panel</p> }))

import ProfilePricingGate from './ProfilePricingGate.jsx'

const blocked = (overrides) => ({
  ok: true,
  authenticated: true,
  is_admin: false,
  access_granted: false,
  installed: true,
  payment_required: true,
  agreement_required: true,
  agreement_accepted: false,
  ...overrides,
})

describe('ProfilePricingGate', () => {
  beforeEach(() => vi.clearAllMocks())

  it('never offers an agreement it cannot record when no pricing row exists', async () => {
    // Prod 2026-09-07: every non-admin profile had no pricing row, the gate
    // rendered the agreement form, and "Accept and continue" answered
    // 400 no_pricing. That form must not be offered for no_pricing_yet.
    statusMock.mockResolvedValue(blocked({ blocking_reason: 'no_pricing_yet', payment_status: 'pending_pricing' }))
    render(<ProfilePricingGate profileId="profile-1" />)
    await waitFor(() => expect(screen.getByText('Pricing not yet available')).toBeTruthy())
    expect(screen.queryByText('I agree to the GrantFlow professional service terms.')).toBeNull()
    expect(screen.queryByText('Checkout panel')).toBeNull()
  })

  it('still offers the agreement when pricing exists and is pending', async () => {
    statusMock.mockResolvedValue(blocked({
      blocking_reason: 'agreement_required',
      payment_status: 'pending_agreement',
      access_status: 'pending_agreement',
      recommended_package_name: 'Starter',
      total_cents: 25000,
    }))
    render(<ProfilePricingGate profileId="profile-1" />)
    await waitFor(() => expect(screen.getByText('I agree to the GrantFlow professional service terms.')).toBeTruthy())
  })

  it('renders children once billing grants access', async () => {
    statusMock.mockResolvedValue({
      ok: true, authenticated: true, is_admin: false, access_granted: true, installed: true,
      blocking_reason: null, payment_status: 'pro_bono', access_source: 'billing',
    })
    render(<ProfilePricingGate profileId="profile-1"><p>Workspace</p></ProfilePricingGate>)
    await waitFor(() => expect(screen.getByText('Workspace')).toBeTruthy())
  })
})
