// @vitest-environment jsdom
/**
 * An ACCEPT the engine could not back with stated eligibility criteria, or
 * whose source stated no service area, must never read "Open application" as
 * if a check had been made (result-quality PR3, 2026-09-17).
 */
import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import FundingResultCard from './FundingResultCard.jsx'
import { toCanonicalResult } from './toCanonicalResult.js'

const BASE = {
  id: 'opp-1',
  title: 'Test Grant',
  sponsor: 'Test Foundation',
  description: 'A test grant.',
  application_url: 'https://example.org/apply',
  source_url: 'https://example.org',
  source: 'web_search',
  kind: 'direct',
  link_status: 'verified',
  match_score: 32,
  match_decision: 'ACCEPT',
  match_confidence: 70,
  matched_profile_facts: ['Need: housing'],
}

describe('FundingResultCard — eligibility evidence', () => {
  it('a fully evidenced ACCEPT keeps "Open application" and shows no confirm chip', () => {
    render(<FundingResultCard result={{ ...BASE, eligibility_evidence: 'prose', geo_evidence: 'stated' }} />)
    expect(screen.getByTestId('funding-result-card-action').textContent).toBe('Open application')
    expect(screen.queryByTestId('funding-result-card-confirm')).toBeNull()
    expect(screen.getByTestId('funding-result-card-score').textContent).toContain('Excellent Match')
  })

  it('applicant-types-only evidence: confirm chip + CTA says confirm first', () => {
    render(<FundingResultCard result={{ ...BASE, eligibility_evidence: 'applicant_types_only', geo_evidence: 'stated' }} />)
    const chip = screen.getByTestId('funding-result-card-confirm')
    expect(chip.textContent).toMatch(/Only who may apply is stated/)
    expect(screen.getByTestId('funding-result-card-action').textContent).toBe('Confirm eligibility, then apply')
    expect(screen.getByTestId('funding-result-card-action').dataset.needsConfirmation).toBe('true')
  })

  it('an unstated service area: confirm chip names the geography gap even with eligibility prose', () => {
    render(<FundingResultCard result={{ ...BASE, eligibility_evidence: 'prose', geo_evidence: 'unknown' }} />)
    expect(screen.getByTestId('funding-result-card-confirm').textContent).toMatch(/service area is not stated/)
    expect(screen.getByTestId('funding-result-card-action').textContent).toBe('Confirm eligibility, then apply')
  })

  it('evidence not recorded (pre-2026-09-17 match): renders conservatively', () => {
    render(<FundingResultCard result={{ ...BASE, eligibility_evidence: 'unknown', geo_evidence: 'stated' }} />)
    expect(screen.getByTestId('funding-result-card-confirm').textContent).toMatch(/not recorded/)
  })

  it('a raw row without evidence fields (legacy caller) is unchanged: no chip, no claim either way', () => {
    render(<FundingResultCard result={{ ...BASE }} />)
    expect(screen.queryByTestId('funding-result-card-confirm')).toBeNull()
    expect(screen.getByTestId('funding-result-card-action').textContent).toBe('Open application')
  })

  it('the header label follows the persisted decision, never the score alone', () => {
    render(<FundingResultCard result={{ ...BASE, match_score: 85, match_decision: 'REVIEW', eligibility_evidence: 'prose', geo_evidence: 'stated' }} />)
    expect(screen.getByTestId('funding-result-card-score').textContent).toContain('Needs review')
    expect(screen.getByTestId('funding-result-card-score').textContent).not.toContain('Excellent')
    expect(screen.queryByTestId('funding-result-card-confirm')).toBeNull() // REVIEW already says review
  })

  it('end to end from a Discover row: explain JSON → adapter → card', () => {
    const row = {
      ...BASE,
      eligibility_evidence: undefined,
      geo_evidence: undefined,
      state: null,
      is_national: false,
      match_explain_json: JSON.stringify({
        eligibility_evidence: 'prose',
        four_truth_proof: { evidence_basis: { eligibility: 'prose', geography: 'unknown' } },
      }),
    }
    const canonical = toCanonicalResult(row)
    expect(canonical.eligibility_evidence).toBe('prose')
    expect(canonical.geo_evidence).toBe('unknown')
    render(<FundingResultCard result={canonical} />)
    expect(screen.getByTestId('funding-result-card-confirm').textContent).toMatch(/service area/)
  })
})
