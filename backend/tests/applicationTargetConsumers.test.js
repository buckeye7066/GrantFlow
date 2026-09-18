import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// Structural guards complement the HTTP, renderer and packet behavior tests.
// These prevent a later page mapping from dropping the selected alias before
// the already-tested canonical resolver or server-side admission sees it.
describe('application-target consumer wiring', () => {
  it('the FundingResults add action validates and de-duplicates the selected explicit alias', () => {
    const source = readFileSync('src/pages/FundingResults.jsx', 'utf8')
    expect(source).toContain('const candidateUrl = resolveApplicationUrl(opportunity)')
    expect(source).toContain('const applicationUrl = resolveApplicationUrl(opportunity)')
  })
  it('the FundingResults request carries that selected alias to the canonical pipeline route', () => {
    const source = readFileSync('src/pages/FundingResults.jsx', 'utf8')
    expect(source).toContain('application_url: applicationUrl,')
    expect(source).not.toContain('application_url: opportunity.application_url ?? null,')
  })
})
