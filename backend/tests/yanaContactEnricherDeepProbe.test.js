/**
 * Regression test for the Yana contact enricher's "deep probe" fallback.
 *
 * Real-world failure this guards against: discovery sources (ProPublica 990,
 * FQHC directories) yield an org IDENTITY but the org's homepage shows only a
 * phone number and a "Contact Us" LINK — the email lives one click deep on
 * /contact. The original enricher scraped only the homepage, found no email,
 * and every prospect died at `no_contact_source`, so NO leads ever reached John
 * (empty draft box). The enricher must follow standard contact pages.
 */

import { describe, it, expect } from 'vitest'
import { makeContactEnricher } from '../services/yana/yanaContactEnrichment.js'

const HOMEPAGE_NO_EMAIL = `
  <html><body>
    <h1>Compass Community Health</h1>
    <p>Clinic: (740) 355-7102</p>
    <a href="/contact">Contact Us</a>
    <a href="/about">About</a>
  </body></html>
`
const CONTACT_PAGE = `
  <html><body>
    <h2>Contact Us</h2>
    <p>Reach our team at <a href="mailto:info@compasscommunityhealth.org">info@compasscommunityhealth.org</a></p>
  </body></html>
`

describe('makeContactEnricher — deep contact-page probe', () => {
  it('follows the /contact page when the homepage has no email', async () => {
    const fetched = []
    const enricher = makeContactEnricher({
      env: { YANA_ALLOW_LIVE_WEB: 'true' },
      // Search returns the org's real homepage.
      searchProvider: async () => [
        { url: 'https://www.compasscommunityhealth.org/', title: 'Compass Community Health', snippet: '' },
      ],
      // Homepage has no email; the /contact page does.
      fetcher: async (url) => {
        fetched.push(url)
        if (/\/contact\b/.test(url)) return CONTACT_PAGE
        if (url.replace(/\/$/, '').endsWith('compasscommunityhealth.org')) return HOMEPAGE_NO_EMAIL
        return '<html></html>'
      },
    })

    const res = await enricher.enrich({ organization_name: 'Compass Community Health', city: 'Portsmouth, OH' })

    expect(res.ok).toBe(true)
    expect(res.website_url).toBe('https://www.compasscommunityhealth.org/')
    expect(res.email).toBe('info@compasscommunityhealth.org')
    // It must have actually visited a contact page, not just the homepage.
    expect(fetched.some((u) => /\/contact/.test(u))).toBe(true)
    // Evidence trail: the exact public page the email was scraped from.
    expect(res.email_source_url).toMatch(/compasscommunityhealth\.org\/contact/)
  })

  it('reports the homepage as the email source when the email is on the homepage', async () => {
    const enricher = makeContactEnricher({
      env: { YANA_ALLOW_LIVE_WEB: 'true' },
      searchProvider: async () => [
        { url: 'https://www.frontdoororg.org/', title: 'Front Door Org', snippet: '' },
      ],
      fetcher: async () => '<html><body><a href="mailto:info@frontdoororg.org">Email us</a></body></html>',
    })

    const res = await enricher.enrich({ organization_name: 'Front Door Org' })
    expect(res.email).toBe('info@frontdoororg.org')
    expect(res.email_source_url).toBe('https://www.frontdoororg.org/')
  })

  it('still returns the homepage (email null) when no contact page yields an address', async () => {
    const enricher = makeContactEnricher({
      env: { YANA_ALLOW_LIVE_WEB: 'true' },
      searchProvider: async () => [
        { url: 'https://www.emaillessorg.org/', title: 'Emailless Org', snippet: '' },
      ],
      fetcher: async () => '<html><body>Call (555) 555-5555</body></html>',
    })

    const res = await enricher.enrich({ organization_name: 'Emailless Org' })
    expect(res.ok).toBe(true)
    expect(res.website_url).toBe('https://www.emaillessorg.org/')
    expect(res.email).toBeNull()
    // No email → no fabricated evidence URL either.
    expect(res.email_source_url).toBeNull()
  })
})
