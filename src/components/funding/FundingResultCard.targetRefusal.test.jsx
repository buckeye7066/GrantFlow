// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import FundingResultCard from './FundingResultCard.jsx'
import { toCanonicalResult } from './toCanonicalResult.js'

afterEach(cleanup)
const rejected = 'https://alpha.grantable.co/login'
const source = 'https://www.tn.gov/collegepays/scholarship'
const refusal = { status:'non_application',reason:'non_application_vendor_content' }
const base = { id:'refused',title:'Student assistance',kind:'direct',match_decision:'REVIEW',
  match_score:50,apply_url:rejected,application_url:'https://www.tn.gov/collegepays/apply',
  source_url:source,link_status:'verified',match_explain:{application_target:refusal} }

for (const shape of ['raw','stored','canonical','twice']) {
  it(`a ${shape} refused target offers only the original source without an application callback`, () => {
    const onApply = vi.fn()
    let row = shape === 'stored' ? { ...base,match_explain:undefined,
      match_explain_json:JSON.stringify(base.match_explain) } : base
    if (shape === 'canonical' || shape === 'twice') row = toCanonicalResult(row)
    if (shape === 'twice') row = toCanonicalResult(row)
    render(<FundingResultCard result={row} onPrimaryAction={onApply} />)
    const action = screen.getByTestId('funding-result-card-action')
    expect(action.getAttribute('href')).toBe(source)
    expect(action.textContent).not.toMatch(/apply|application/i)
    fireEvent.click(action)
    expect(onApply).not.toHaveBeenCalled()
  })
}
it.each([null,rejected])('does not relabel a rejected target as its own source: %s', (source_url) => {
  const row = toCanonicalResult({ ...base,source_url,url:rejected })
  render(<FundingResultCard result={row} />)
  expect(screen.queryByTestId('funding-result-card-action')).toBeNull()
})
it('retains the recorded refusal through repeated canonical mapping', () => {
  const once = toCanonicalResult(base)
  expect(once.application_target).toEqual(refusal)
  expect(toCanonicalResult(once)).toEqual(once)
  expect(base.apply_url).toBe(rejected)
})
it('a valid unrefused application keeps its existing action and callback', () => {
  const callback = vi.fn(e => e.preventDefault())
  const valid = 'https://www.tn.gov/collegepays/apply'
  render(<FundingResultCard result={{ ...base,apply_url:valid,match_explain:null,match_decision:'ACCEPT' }} onPrimaryAction={callback} />)
  const action = screen.getByTestId('funding-result-card-action')
  expect(action.getAttribute('href')).toBe(valid)
  fireEvent.click(action)
  expect(callback).toHaveBeenCalledOnce()
})

it('the actual Discover mapping retains a persisted refusal through the card boundary', async () => {
  const { mapDiscoverCatalogRow } = await import('@/lib/discoverCatalogKeep.js')
  const mapped = mapDiscoverCatalogRow(base)
  const canonical = toCanonicalResult(mapped)
  expect(canonical.application_target).toEqual(refusal)
  render(<FundingResultCard result={canonical} />)
  const link = screen.queryByTestId('funding-result-card-action')
  expect(link?.getAttribute('href')).not.toBe(rejected)
  expect(link?.textContent).not.toMatch(/open application/i)
})
