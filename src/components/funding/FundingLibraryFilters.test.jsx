// @vitest-environment jsdom
import React from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import FundingLibraryFilters from './FundingLibraryFilters.jsx'

// Capture the URL fundingLibraryApi.list builds so we can assert that the
// "Any" sentinel is omitted from the request.
const apiFetch = vi.fn(() => Promise.resolve({ ok: true, items: [], total: 0 }))
vi.mock('@/api/client', () => ({ apiFetch: (...args) => apiFetch(...args) }))

const EMPTY_FILTERS = {
  q: '', state: '', applicant_type: '', deadline: '', source_trust: '', kind: '',
}

describe('FundingLibraryFilters', () => {
  it('mounts without throwing (no <SelectItem value="">)', () => {
    // Regression: the Applicant type / Deadline / Source trust filters used to
    // render { value: "" } options into Radix <SelectItem>, which throws
    // "A <Select.Item /> must have a value prop that is not an empty string"
    // and tripped the RouteErrorBoundary on /FundingLibrary.
    expect(() =>
      render(
        <FundingLibraryFilters
          filters={EMPTY_FILTERS}
          onChange={() => {}}
          onReset={() => {}}
          onRefresh={() => {}}
          loading={false}
        />,
      ),
    ).not.toThrow()
  })

  it('renders with non-empty filter values without throwing', () => {
    expect(() =>
      render(
        <FundingLibraryFilters
          filters={{ ...EMPTY_FILTERS, applicant_type: 'nonprofit', deadline: 'open', source_trust: 'official_api' }}
          onChange={() => {}}
          onReset={() => {}}
          onRefresh={() => {}}
          loading={false}
        />,
      ),
    ).not.toThrow()
  })
})

describe('fundingLibraryApi.list query building', () => {
  it('omits empty/"Any" filters and includes selected ones', async () => {
    apiFetch.mockClear()
    const { fundingLibraryApi } = await import('@/api/fundingLibrary.js')

    // Selecting "Any" maps to '' in the component; '' must be omitted from the URL.
    await fundingLibraryApi.list({ applicant_type: '', deadline: 'open', source_trust: '' })

    expect(apiFetch).toHaveBeenCalledTimes(1)
    const url = apiFetch.mock.calls[0][0]
    expect(url).not.toContain('applicant_type')
    expect(url).not.toContain('source_trust')
    expect(url).toContain('deadline=open')
  })
})
