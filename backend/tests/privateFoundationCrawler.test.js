import { describe, expect, it } from 'vitest'

import { crawlPrivateFoundations, getFoundationRegistry } from '../services/privateFoundationCrawler.js'

describe('privateFoundationCrawler — East Tennessee Foundation honesty', () => {
  it('does not carry a fabricated ETF umbrella grant range in the registry', () => {
    const etf = getFoundationRegistry().find((row) => row.name === 'East Tennessee Foundation')
    expect(etf).toBeTruthy()
    expect(etf.applicationUrl).toBe('https://www.easttennesseefoundation.org/nonprofits/apply-for-grants/')
    expect(etf.grantRange).toBeUndefined()
  })

  it('emits null min/max for the ETF umbrella row so amount enrichment must answer it honestly later', async () => {
    const { opportunities } = await crawlPrivateFoundations({
      signals: {
        location: { state: 'TN' },
        keywords: ['education'],
      },
    })
    const etf = opportunities.find((row) => row.title === 'East Tennessee Foundation')
    expect(etf).toBeTruthy()
    expect(etf.grant_amount_min).toBeNull()
    expect(etf.grant_amount_max).toBeNull()
  })
})
