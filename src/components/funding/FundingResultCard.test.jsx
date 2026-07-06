// @vitest-environment jsdom
import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import FundingResultCard from './FundingResultCard.jsx'

const BASE = {
  id: 'opp-1',
  title: 'Test Grant',
  sponsor: 'Test Foundation',
  description: 'A test grant for verification.',
  application_url: 'https://example.org/apply',
  source_url: 'https://example.org',
  source: 'grants.gov',
  match_score: 78,
  match_decision: 'ACCEPT',
  match_confidence: 80,
  matched_profile_facts: ['Profile state: TN', 'Need: equipment'],
  ineligibility_reasons: [],
}

describe('FundingResultCard', () => {
  it('renders title, sponsor, and source for a direct grant', () => {
    render(<FundingResultCard result={{ ...BASE, kind: 'direct', source_trust_tier: 'official_api', link_status: 'verified' }} />)
    expect(screen.getByText('Test Grant')).toBeTruthy()
    expect(screen.getByText(/From Test Foundation/)).toBeTruthy()
    expect(screen.getByText(/Source: grants.gov/)).toBeTruthy()
  })

  it('shows the match score and confidence', () => {
    render(<FundingResultCard result={{ ...BASE, kind: 'direct', link_status: 'verified' }} />)
    const scoreEl = screen.getByTestId('funding-result-card-score')
    expect(scoreEl).toBeTruthy()
    expect(scoreEl.textContent).toContain('78')
    expect(scoreEl.textContent).toContain('80% conf')
  })

  it('shows "why this matched" with matched_profile_facts (Phase 2 mission rule)', () => {
    render(<FundingResultCard result={{ ...BASE, kind: 'direct', link_status: 'verified' }} />)
    const why = screen.getByTestId('funding-result-card-why')
    expect(why).toBeTruthy()
    expect(why.textContent).toContain('Profile state: TN')
    expect(why.textContent).toContain('Need: equipment')
  })

  it('renders a directory result with the directory disclaimer (Phase 4/5)', () => {
    render(
      <FundingResultCard
        result={{ ...BASE, kind: 'directory', link_status: 'verified', source_trust_tier: 'verified_directory' }}
      />,
    )
    const card = screen.getByTestId('funding-result-card')
    expect(card.dataset.kind).toBe('directory')
    expect(screen.getByText(/not a direct grant/)).toBeTruthy()
  })

  it('shows the broken-link warning for direct opportunities with link_status=broken', () => {
    render(
      <FundingResultCard
        result={{ ...BASE, kind: 'direct', link_status: 'broken' }}
      />,
    )
    expect(screen.getByTestId('funding-result-card-broken')).toBeTruthy()
  })

  it('shows an honest amount STATUS when no dollar figure is knowable (2026-07-06)', () => {
    render(<FundingResultCard result={{ ...BASE, kind: 'direct', link_status: 'verified', amount_status: 'varies' }} />)
    expect(screen.getByText('Amount varies')).toBeTruthy()
  })

  it('shows the stored amount excerpt when only text is knowable (2026-07-06)', () => {
    render(
      <FundingResultCard
        result={{ ...BASE, kind: 'direct', link_status: 'verified', amount_text: 'Total funding available: $500,000', amount_status: 'not_listed' }}
      />,
    )
    expect(screen.getByText('Total funding available: $500,000')).toBeTruthy()
  })

  it('warns when an opportunity is a loan (RC-15)', () => {
    render(<FundingResultCard result={{ ...BASE, kind: 'direct', link_status: 'verified', is_loan: true }} />)
    const banner = screen.getByTestId('funding-result-card-loan')
    expect(banner).toBeTruthy()
    expect(banner.textContent).toMatch(/loan/i)
  })

  it('warns when an opportunity requires matching funds (RC-15)', () => {
    render(<FundingResultCard result={{ ...BASE, kind: 'direct', link_status: 'verified', requires_match: true }} />)
    expect(screen.getByTestId('funding-result-card-matching-funds')).toBeTruthy()
  })

  it('warns when a fixed deadline has passed (RC-15)', () => {
    render(
      <FundingResultCard
        result={{ ...BASE, kind: 'direct', link_status: 'verified', deadline: '2000-01-01', deadline_type: 'fixed' }}
      />,
    )
    expect(screen.getByTestId('funding-result-card-expired')).toBeTruthy()
  })

  it('does NOT warn expired for rolling deadlines (RC-15)', () => {
    render(
      <FundingResultCard
        result={{ ...BASE, kind: 'direct', link_status: 'verified', deadline: '2000-01-01', deadline_type: 'rolling' }}
      />,
    )
    expect(screen.queryByTestId('funding-result-card-expired')).toBeNull()
  })

  it('shows ineligibility reasons when present', () => {
    render(
      <FundingResultCard
        result={{
          ...BASE,
          kind: 'direct',
          link_status: 'verified',
          match_decision: 'REVIEW',
          ineligibility_reasons: ['Requires 501(c)(3)', 'State mismatch'],
        }}
      />,
    )
    const block = screen.getByTestId('funding-result-card-ineligibility')
    expect(block).toBeTruthy()
    expect(block.textContent).toContain('Requires 501(c)(3)')
  })

  it('honestly surfaces threshold relaxation (Phase 5 rule)', () => {
    render(
      <FundingResultCard
        result={{
          ...BASE,
          kind: 'direct',
          link_status: 'verified',
          threshold_relaxed: true,
          relaxed_reason: 'No strong matches found.',
        }}
      />,
    )
    const relaxed = screen.getByTestId('funding-result-card-relaxed')
    expect(relaxed).toBeTruthy()
    expect(relaxed.textContent).toContain('No strong matches found.')
  })

  it('renders a benefit (e.g., LIHEAP) with the benefit kind label', () => {
    render(
      <FundingResultCard
        result={{
          ...BASE,
          kind: 'benefit',
          link_status: 'verified',
          source_trust_tier: 'official_portal',
        }}
      />,
    )
    expect(screen.getByText(/Benefit/)).toBeTruthy()
  })

  it('renders a school portal result', () => {
    render(
      <FundingResultCard
        result={{
          ...BASE,
          kind: 'school_portal',
          link_status: 'verified',
          source_trust_tier: 'official_portal',
          title: 'Tennessee Tech Financial Aid',
          source: 'school_portal',
        }}
      />,
    )
    expect(screen.getByText(/School portal/)).toBeTruthy()
  })

  it('returns null when result is missing', () => {
    const { container } = render(<FundingResultCard result={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the canonical action label per kind', () => {
    const { unmount } = render(
      <FundingResultCard result={{ ...BASE, kind: 'direct', link_status: 'verified' }} />,
    )
    expect(screen.getByTestId('funding-result-card-action').textContent).toBe('Open application')
    unmount()

    render(
      <FundingResultCard
        result={{ ...BASE, kind: 'directory', link_status: 'verified' }}
      />,
    )
    expect(screen.getByTestId('funding-result-card-action').textContent).toBe(
      'Search this directory',
    )
  })
})
