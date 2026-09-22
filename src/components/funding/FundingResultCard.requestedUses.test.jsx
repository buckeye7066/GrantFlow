// @vitest-environment jsdom
import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import FundingResultCard from './FundingResultCard.jsx'
import { toCanonicalResult } from './toCanonicalResult.js'

const coverage = { pass: true, requested_need_evidence: [
  { need: 'laboratory building', status: 'excluded', evidence: [{ field: 'description', excerpt: 'Building acquisition is not allowable.' }] },
  { need: 'laboratory equipment', status: 'supported', evidence: [{ field: 'description', excerpt: 'Equipment costs are allowable.' }] },
  { need: 'research salaries', status: 'unknown', evidence: [] },
] }

describe('requested funding-use evidence reaches the owner', () => {
  it('retains persisted evidence and renders partial support without certifying all expenses', () => {
    const result = toCanonicalResult({ id: 'test-use', title: 'Synthetic Research Award', match_decision: 'REVIEW',
      match_score: 40, application_url: 'https://funder.example/apply',
      match_explain_json: JSON.stringify({ requested_need_coverage: coverage }) })
    expect(result.requested_need_coverage).toEqual(coverage)
    render(<FundingResultCard result={result} />)
    const evidence = screen.getByTestId('funding-result-requested-uses')
    expect(evidence.textContent).toContain('laboratory building')
    expect(evidence.textContent).toContain('Excluded by recorded terms')
    expect(evidence.textContent).toContain('Supported by recorded terms')
    expect(evidence.textContent).toContain('Not established')
    expect(evidence.textContent).toContain('Equipment costs are allowable.')
  })

  it('malformed legacy evidence does not create a claim or crash the card', () => {
    const result = toCanonicalResult({ id: 'legacy', title: 'Legacy', match_explain: { requested_need_coverage: 'bad' } })
    render(<FundingResultCard result={result} />)
    expect(screen.queryByTestId('funding-result-requested-uses')).toBeNull()
  })
})
