// @vitest-environment jsdom
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const searchMock = vi.fn()
const toastMock = vi.fn()

vi.mock('@/api/items', () => ({
  searchGreenHomePrograms: (...args) => searchMock(...args),
}))

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector) => selector({
    activeProfileId: 'profile-1',
    user: { profile_id: 'profile-1' },
    profiles: [{ id: 'profile-1', display_name: 'White Household' }],
  }),
}))

vi.mock('@/components/shared/ProfileSelect', () => ({
  default: ({ value, onValueChange, triggerId, ariaLabel, disabled }) => (
    <select
      id={triggerId}
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      disabled={disabled}
    >
      <option value="profile-1">White Household</option>
      <option value="profile-2">Second Household</option>
    </select>
  ),
}))

const GreenHomePrograms = (await import('./GreenHomePrograms.jsx')).default

function successfulResponse() {
  return {
    success: true,
    profile_id: 'profile-1',
    policy_version: 'green_home_no_cost_v1',
    strict_no_cost: true,
    household: { occupancy: 'homeowner', state: 'TN' },
    count: 1,
    notice: 'Only explicitly no-cost, non-loan paths are shown.',
    programs: [{
      id: 'wap',
      title: 'Weatherization Assistance Program',
      sponsor: 'U.S. Department of Energy',
      description: 'Official application path for income-qualified weatherization services.',
      source_url: 'https://www.energy.gov/cmei/scep/wap/how-apply-weatherization-assistance',
      opportunity_kind: 'directory',
      no_cost_classification: 'eligible',
      no_cost_evidence: 'Official free weatherization assistance path.',
      upgrades: ['energy audit', 'insulation', 'air sealing'],
      eligibility_bullets: ['The local provider determines eligibility and covered work.'],
    }],
    review_count: 1,
    review_reasons: [{ reason: 'no_cost_not_proven', count: 1 }],
    excluded_count: 2,
    excluded_reasons: [
      { reason: 'loan_or_financing', count: 1 },
      { reason: 'tax_credit', count: 1 },
    ],
    search_coverage: { source_errors: [] },
  }
}

describe('GreenHomePrograms', () => {
  beforeEach(() => {
    searchMock.mockReset()
    searchMock.mockResolvedValue(successfulResponse())
    toastMock.mockReset()
  })

  it('explains the strict no-payment boundary before the search runs', () => {
    render(<GreenHomePrograms />)

    expect(screen.getByRole('heading', { name: /no-cost green home upgrades/i })).toBeTruthy()
    expect(screen.getByText(/primary results exclude loans, financing, leases/i)).toBeTruthy()
    expect(screen.getByLabelText(/household or homeowner profile/i).value).toBe('profile-1')
    expect(screen.getByRole('button', { name: /find no-cost programs/i })).toBeTruthy()
  })

  it('shows only verified primary programs and summarizes withheld payment-based results', async () => {
    render(<GreenHomePrograms />)

    fireEvent.click(screen.getByRole('button', { name: /find no-cost programs/i }))

    await waitFor(() => {
      expect(searchMock).toHaveBeenCalledWith({ profileId: 'profile-1' })
    })

    expect(await screen.findByText('Weatherization Assistance Program')).toBeTruthy()
    expect(screen.getByText(/explicit no-cost path/i)).toBeTruthy()
    expect(screen.getByText(/loan or financing required/i)).toBeTruthy()
    expect(screen.getByText(/tax credit rather than direct help/i)).toBeTruthy()
    expect(screen.getByText(/cost terms were not clear enough to show/i)).toBeTruthy()

    const sourceLink = screen.getByRole('link', { name: /open official source/i })
    expect(sourceLink.getAttribute('href')).toMatch(/^https:\/\/www\.energy\.gov\//)
  })

  it('does not convert provider failure into a successful zero-result page', async () => {
    searchMock.mockRejectedValueOnce(new Error('Official-source search unavailable'))
    render(<GreenHomePrograms />)

    fireEvent.click(screen.getByRole('button', { name: /find no-cost programs/i }))

    expect(await screen.findByText(/the search could not be completed/i)).toBeTruthy()
    expect(screen.getByText(/no unavailable source is being counted as a zero-result search/i)).toBeTruthy()
    expect(screen.queryByText(/0 verified no-cost paths/i)).toBeNull()
  })
})
